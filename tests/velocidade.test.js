/* ==========================================================
   BarrilFacil — testes: troca de abas rápida (arquivos versionados, cache, session:bootstrap, menos consultas)
   Rodar:  npm test   (precisa do Supabase local; veja "Rodar os testes" no README)
   ========================================================== */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SEM_BANCO, limparBanco, startServer, setupAdmin, makeUser, client } = require("./helpers");

const RENDERER = path.join(__dirname, "..", "src", "renderer");
const PAGINAS = fs.readdirSync(RENDERER).filter((f) => f.endsWith(".html"));
// <script src> e <link href> locais das pastas versionadas
const LOCAIS = /<(?:script|link)\b[^>]*?\s(?:src|href)="((?:js|css|vendor|assets)\/[^"]*)"/g;

describe("troca de abas rápida", { skip: SEM_BANCO }, () => {
  let srv, admin, versao;
  const u = {};
  const get = (caminho, headers = {}) => fetch(`${srv.base}${caminho}`, { headers });

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    u.centro = (await admin.ok("units:create", { razaoSocial: "Bar do Centro Bebidas Ltda", nome: "Bar do Centro", nomeCurto: "Centro", cnpj: "11.222.333/0001-81", endereco: "Av. Brasil, 100, Centro, Cuiabá - MT" })).id;
    u.porto = (await admin.ok("units:create", { razaoSocial: "Bar do Porto Bebidas Ltda", nome: "Bar do Porto", nomeCurto: "Porto", cnpj: "11.444.777/0001-61", endereco: "Rua do Porto, 200, Cuiabá - MT" })).id;
  });
  after(async () => { if (srv) await srv.stop(); });

  test("as páginas saem com ?v= nos arquivos locais, a mesma versão em todos, sem Google Fonts", async () => {
    for (const pagina of PAGINAS) {
      const html = await (await get(`/${pagina}`)).text();
      const locais = [...html.matchAll(LOCAIS)].map((m) => m[1]);
      assert.ok(locais.length > 0, `${pagina} sem arquivos locais`);
      for (const url of locais) {
        const m = /\?v=([0-9a-f]{10})$/.exec(url);
        assert.ok(m, `${pagina}: ${url} sem versão`);
        versao = versao || m[1];
        assert.equal(m[1], versao, `${pagina}: ${url} com outra versão`);
      }
      assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/, `${pagina} ainda chama o Google Fonts`);
      assert.match(html, /href="manifest\.webmanifest"/, `${pagina}: o manifest não leva versão (não está nas pastas versionadas)`);
      // no arquivo em disco não há versão escrita à mão
      assert.doesNotMatch(fs.readFileSync(path.join(RENDERER, pagina), "utf8"), /\?v=/, `${pagina} com versão escrita à mão`);
    }
  });

  test("arquivo com a versão atual: cache longo; sem versão ou com versão velha: no-cache com ETag e 304", async () => {
    let r = await get(`/js/common.js?v=${versao}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "public, max-age=31536000, immutable");

    for (const caminho of ["/js/common.js", "/js/common.js?v=0000000000", "/css/style.css"]) {
      r = await get(caminho);
      assert.equal(r.status, 200, caminho);
      assert.equal(r.headers.get("cache-control"), "no-cache", caminho);
      const etag = r.headers.get("etag");
      assert.ok(etag, `${caminho} sem ETag`);
      const r304 = await get(caminho, { "If-None-Match": etag });
      assert.equal(r304.status, 304, caminho);
      assert.equal(await r304.text(), "");
    }

    // a página: no-cache, ETag e 304 (ela é que aponta para a versão nova depois de um deploy)
    r = await get("/barris.html");
    assert.equal(r.headers.get("cache-control"), "no-cache");
    const etag = r.headers.get("etag");
    assert.equal((await get("/barris.html", { "If-None-Match": etag })).status, 304);
    assert.equal((await get("/barris.html", { "If-None-Match": '"outro"' })).status, 200);
  });

  test("service worker com o cache da versão; fontes locais; CSP sem Google e com as regras de pré-carregamento", async () => {
    const sw = await (await get("/sw.js")).text();
    assert.match(sw, new RegExp(`const VERSAO = "${versao}"`));
    assert.doesNotMatch(sw, /__VERSAO__/);

    for (const f of ["manrope-latin", "manrope-latin-ext", "sora-latin", "sora-latin-ext"]) {
      const r = await get(`/assets/fonts/${f}.woff2`);
      assert.equal(r.status, 200, f);
      assert.equal(r.headers.get("content-type"), "font/woff2");
    }
    const css = await (await get(`/css/style.css?v=${versao}`)).text();
    assert.match(css, /@font-face[^}]*"Manrope"[^}]*manrope-latin\.woff2/);
    assert.match(css, /@font-face[^}]*"Sora"[^}]*sora-latin\.woff2/);
    assert.match(css, /font-display: swap/);

    const csp = (await get("/dashboard.html")).headers.get("content-security-policy");
    assert.doesNotMatch(csp, /googleapis|gstatic/);
    assert.match(csp, /font-src 'self'/);
    assert.match(csp, /script-src 'self' 'inline-speculation-rules'/);
  });

  test("cada chamada da API devolve o tempo no servidor (Server-Timing)", async () => {
    const r = await fetch(`${srv.base}/api/config/get`, { method: "POST", headers: { "Content-Type": "application/json", "X-MC": "1" }, body: "{}" });
    assert.match(r.headers.get("server-timing") || "", /^app;dur=\d+(\.\d)?$/);
  });

  test("session:bootstrap traz usuário, unidades e config numa ida só, igual às três rotas de antes", async () => {
    const b = await admin.ok("session:bootstrap");
    assert.deepEqual(b.user, await admin.ok("auth:me"));
    assert.deepEqual(b.units, await admin.ok("units:list"));
    assert.deepEqual(b.config, await admin.ok("config:get"));
    assert.deepEqual(b.units.map((x) => x.nome_curto), ["Centro", "Porto"]);
    assert.ok(b.config.hoje && b.config.fornecedor);

    // sem sessão: vai para o login, como antes
    const r = await client(srv.base)("session:bootstrap");
    assert.equal(r.ok, false);
    assert.equal(r.code, "SESSION");

    // senha temporária: recebe o usuário (a tela leva ao primeiro acesso) e nenhuma unidade
    const { senha } = await admin.ok("users:create", { nome: "Téo", email: "teo@barrilfacil.test", cargo: "operador", unidadeIds: [u.centro] });
    const teo = client(srv.base);
    await teo.ok("auth:login", { identifier: "teo@barrilfacil.test", password: senha });
    const bt = await teo.ok("session:bootstrap");
    assert.equal(bt.user.trocarSenha, true);
    assert.deepEqual(bt.units, []);
  });

  test("unidades liberadas guardadas na sessão: tirar o acesso, desativar e criar unidade valem na hora", async () => {
    const op = await makeUser(srv.base, admin, { nome: "Olga", email: "olga@barrilfacil.test", cargo: "operador", unidadeIds: [u.centro, u.porto] });
    const ids = async (who) => (await who.ok("session:bootstrap")).units.map((x) => x.id);
    assert.deepEqual(await ids(op), [u.centro, u.porto]);
    await op.ok("barris:list", { unitId: u.porto }); // usa o que ficou guardado

    await admin.ok("users:setUnits", { id: (await admin.ok("users:list")).find((x) => x.nome === "Olga").id, unidadeIds: [u.centro] });
    assert.deepEqual(await ids(op), [u.centro]);
    await op.fail("barris:list", { unitId: u.porto }, /não tem acesso a esta unidade/);

    // o administrador vê todas as ativas: desativar e criar mudam a lista dele (e a dos outros) sem esperar
    assert.deepEqual(await ids(admin), [u.centro, u.porto]);
    await admin.ok("units:toggle", { id: u.porto });
    assert.deepEqual(await ids(admin), [u.centro]);
    await admin.ok("units:toggle", { id: u.porto });
    assert.deepEqual(await ids(admin), [u.centro, u.porto]);
    const nova = (await admin.ok("units:create", { razaoSocial: "Bar Novo Bebidas Ltda", nome: "Bar Novo", nomeCurto: "Novo", cnpj: "34.028.316/0001-03", endereco: "Rua Nova, 10, Cuiabá - MT" })).id;
    assert.deepEqual(await ids(admin), [u.centro, u.porto, nova]);
    await admin.ok("units:toggle", { id: nova });
    assert.deepEqual(await ids(op), [u.centro]);
  });

  test("torneiras: o quadro usa só o engate em andamento; os detalhes da unidade contam os usos", async () => {
    await admin.ok("taps:create", { unitId: u.centro, quantidade: 2 });
    const estilo = await admin.ok("estilos:create", { nome: "Pilsen" });
    const chope = (await admin.ok("chopes:create", { nome: "Chopp Pilsen", estiloId: estilo.id })).id;
    const hoje = (await admin.ok("config:get")).hoje;
    const d = new Date(`${hoje}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 5);
    const validade = d.toISOString().slice(0, 10);
    const tap = (await admin.ok("units:details", { id: u.centro })).torneiras.find((t) => t.numero === 1).id;
    for (const codigo of ["T1", "T2", "T3"]) {
      const { id } = await admin.ok("barris:create", { codigo, chopeId: chope, tamanho: 30, validade, unitId: u.centro });
      await admin.ok("barris:use", { id, torneiraId: tap, unitId: u.centro });
      if (codigo !== "T3") await admin.ok("barris:empty", { id });
    }
    const quadro = (await admin.ok("taps:board", { unitId: u.centro })).torneiras;
    const um = quadro.find((t) => t.numero === 1);
    assert.equal(um.ocupada, true);
    assert.equal(um.codigo, "T3");
    assert.equal(quadro.find((t) => t.numero === 2).ocupada, false);

    const det = (await admin.ok("units:details", { id: u.centro })).torneiras;
    assert.equal(det.find((t) => t.numero === 1).usos, 3);
    assert.equal(det.find((t) => t.numero === 2).usos, 0);
    assert.equal(det.find((t) => t.numero === 1).ocupada, true);
  });
});
