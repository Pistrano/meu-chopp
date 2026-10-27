/* ==========================================================
   BarrilFacil — testes: apagar estilo e chope do catálogo
   Rodar:  npm test   (precisa do Supabase local; veja "Rodar os testes" no README)
   ========================================================== */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SEM_BANCO, banco, limparBanco, startServer, setupAdmin, makeUser } = require("./helpers");

const SEM_PERMISSAO = /Você não tem permissão para esta ação/;

const somaDias = (dia, n) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe("apagar estilo e chope", { skip: SEM_BANCO }, () => {
  let srv, admin, gerente, operador, unidade, hoje;
  const ids = {};

  const consulta = async (q) => { const { data, error } = await q; assert.ifError(error); return data; };
  const estilo = async (nome) => admin.ok("estilos:create", { nome });
  const chope = async (nome, estiloId) => admin.ok("chopes:create", { nome, estiloId });
  const barril = async (codigo, chopeId) => {
    await admin.ok("barris:create", { codigo, chopeId, tamanho: 30, validade: somaDias(hoje, 5), unitId: unidade });
    return (await admin.ok("barris:list", { unitId: unidade })).find((b) => b.codigo === codigo);
  };
  const ultimaAuditoria = async (acao) =>
    (await consulta(banco().from("auditoria").select("detalhe").eq("acao", acao).order("id", { ascending: false }).limit(1)))[0];

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    unidade = (await admin.ok("units:create", { razaoSocial: "Loja Centro Bebidas Ltda", nome: "Loja Centro", cnpj: "11.222.333/0001-81", endereco: "Av. Brasil, 100, Centro, Cuiabá - MT" })).id;
    await admin.ok("taps:create", { unitId: unidade, quantidade: 2 });
    hoje = (await admin.ok("config:get")).hoje;
    gerente = await makeUser(srv.base, admin, { nome: "Gina", email: "gina@barrilfacil.test", cargo: "gerente", unidadeIds: [unidade] });
    operador = await makeUser(srv.base, admin, { nome: "Otávio", email: "otavio@barrilfacil.test", cargo: "operador", unidadeIds: [unidade] });
  });
  after(async () => { if (srv) await srv.stop(); });

  test("a lista de estilos traz quantos chopes cada um tem (só para quem edita o catálogo)", async () => {
    const pilsen = await estilo("Pilsen");
    ids.pilsen = pilsen.id;
    ids.chopp = (await chope("Chopp Pilsen", pilsen.id)).id;
    ids.vazio = (await estilo("Estilo Errado")).id;
    const lista = await admin.ok("estilos:list", { todos: true });
    assert.equal(lista.find((e) => e.id === ids.pilsen).chopes, 1);
    assert.equal(lista.find((e) => e.id === ids.vazio).chopes, 0);
    assert.equal((await gerente.ok("estilos:list", {})).find((e) => e.id === ids.pilsen).chopes, 1);
    assert.equal("chopes" in (await operador.ok("estilos:list", {})).find((e) => e.id === ids.pilsen), false);
  });

  test("apaga estilo sem chopes", async () => {
    await admin.ok("estilos:delete", { id: ids.vazio });
    assert.equal((await consulta(banco().from("estilos").select("id").eq("id", ids.vazio))).length, 0);
    assert.equal((await ultimaAuditoria("estilo_apagado")).detalhe, "Estilo Errado");
    await admin.fail("estilos:delete", { id: ids.vazio }, /Estilo não encontrado/);
  });

  test("estilo com chopes e sem destino não é apagado", async () => {
    ids.chopp2 = (await chope("Chopp Claro", ids.pilsen)).id;
    await admin.ok("chopes:toggle", { id: ids.chopp2 }); // desativado também conta
    await admin.fail("estilos:delete", { id: ids.pilsen }, /O estilo "Pilsen" tem 2 chope\(s\): Chopp Claro, Chopp Pilsen\. Escolha para qual estilo eles vão/);
    await admin.fail("estilos:delete", { id: ids.pilsen, destinoId: ids.pilsen }, /outro estilo/);
    assert.equal((await consulta(banco().from("estilos").select("id").eq("id", ids.pilsen))).length, 1);
  });

  test("destino precisa ser um estilo ativo", async () => {
    ids.weiss = (await estilo("Weiss")).id;
    await admin.ok("estilos:toggle", { id: ids.weiss });
    await admin.fail("estilos:delete", { id: ids.pilsen, destinoId: ids.weiss }, /"Weiss" está desativado/);
    await admin.fail("estilos:delete", { id: ids.pilsen, destinoId: 999999 }, /não existe/);
  });

  test("com destino, os chopes passam para o outro estilo e os barris mostram o estilo novo", async () => {
    const b1 = await barril("PL1", ids.chopp);
    assert.equal(b1.estilo, "Pilsen");
    // barril antigo, sem chope do catálogo: não é deste estilo e não muda
    const { error } = await banco().from("barris").insert({ codigo: "ANT1", estilo: "Pilsen", tamanho_l: 30, unidade_id: unidade, validade: somaDias(hoje, 5) });
    assert.ifError(error);
    ids.lager = (await estilo("American Lager")).id;

    const r = await gerente.ok("estilos:delete", { id: ids.pilsen, destinoId: ids.lager });
    assert.deepEqual(r, { nome: "Pilsen", chopes: 2, barris: 1, destino: "American Lager" });
    assert.equal((await consulta(banco().from("estilos").select("id").eq("id", ids.pilsen))).length, 0);
    const chopes = await consulta(banco().from("chopes").select("nome, estilo_id, ativo").in("id", [ids.chopp, ids.chopp2]).order("nome"));
    assert.deepEqual(chopes, [
      { nome: "Chopp Claro", estilo_id: ids.lager, ativo: false },
      { nome: "Chopp Pilsen", estilo_id: ids.lager, ativo: true },
    ]);
    assert.equal((await consulta(banco().from("barris").select("estilo").eq("codigo", "PL1")))[0].estilo, "American Lager");
    assert.equal((await consulta(banco().from("barris").select("estilo").eq("codigo", "ANT1")))[0].estilo, "Pilsen");
    // Barris, Histórico e Relatório de barris já mostram o estilo novo
    assert.equal((await admin.ok("barris:list", { unitId: unidade })).find((b) => b.codigo === "PL1").estilo, "American Lager");
    assert.equal((await admin.ok("history:list", { unitId: unidade, q: "PL1" }))[0].estilo, "American Lager");
    const rel = await admin.ok("reports:barrels", { de: somaDias(hoje, -1), ate: hoje });
    const grupo = rel.grupos.find((g) => g.estilo === "American Lager");
    assert.ok(grupo && grupo.chopes.some((c) => c.chope === "Chopp Pilsen"), JSON.stringify(rel.grupos));
    assert.equal((await ultimaAuditoria("estilo_apagado")).detalhe, "Pilsen: 2 chope(s) e 1 barril(is) passaram para o estilo American Lager");
  });

  test("chope com barril não é apagado; chope sem barril é", async () => {
    const r = await admin.fail("chopes:delete", { id: ids.chopp });
    assert.match(r.error, /O chope "Chopp Pilsen" é usado por 1 barril\(is\) e não pode ser apagado\. Desative o chope/);
    assert.equal((await consulta(banco().from("chopes").select("id").eq("id", ids.chopp))).length, 1);

    const errado = await chope("Chop Pilsen", ids.lager); // digitado errado, sem barris
    await gerente.ok("chopes:delete", { id: errado.id });
    assert.equal((await consulta(banco().from("chopes").select("id").eq("id", errado.id))).length, 0);
    assert.equal((await ultimaAuditoria("chope_apagado")).detalhe, "Chop Pilsen (American Lager)");
    await admin.fail("chopes:delete", { id: errado.id }, /Chope não encontrado/);
  });

  test("operador não apaga estilo nem chope (o servidor recusa)", async () => {
    const ipa = await estilo("IPA");
    const hop = await chope("Hop IPA", ipa.id);
    await operador.fail("chopes:delete", { id: hop.id }, SEM_PERMISSAO);
    await operador.fail("estilos:delete", { id: ipa.id, destinoId: ids.lager }, SEM_PERMISSAO);
    assert.equal((await consulta(banco().from("chopes").select("id").eq("id", hop.id))).length, 1);
    assert.equal((await consulta(banco().from("estilos").select("id").eq("id", ipa.id))).length, 1);
  });
});
