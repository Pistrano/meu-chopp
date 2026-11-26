/* ==========================================================
   BarrilFacil — testes: leitura da etiqueta do barril (câmera, pistola ou digitação)
   - normalizar() e motivo() de src/renderer/js/leitor-codigo.js (rodam sem banco);
   - barris:porCodigo e a permissão da câmera no servidor (precisam do Supabase local; veja "Rodar os testes" no README).
   ========================================================== */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SEM_BANCO, limparBanco, startServer, setupAdmin, makeOperator } = require("./helpers");
const { normalizar, motivo } = require("../src/renderer/js/leitor-codigo.js");

describe("o que foi lido vira código do barril", () => {
  test("código inteiro, sem hífen, com espaço, minúsculas, # e os * do Code 39", () => {
    for (const lido of ["BA5-2630", "BA52630", "ba5 2630", "Ba5-2630", " #BA5-2630 ", "*BA5-2630*", "BA5 - 2630", "BA5\u20132630"])
      assert.deepEqual(normalizar(lido), { codigo: "BA5-2630" }, lido);
    assert.deepEqual(normalizar("ba2-1810"), { codigo: "BA2-1810" });
    assert.deepEqual(normalizar("BA31810"), { codigo: "BA3-1810" });
  });

  test("só números: procura pelo fim do código", () => {
    assert.deepEqual(normalizar("2630"), { numero: "2630" });
    assert.deepEqual(normalizar(" 1810 "), { numero: "1810" });
  });

  test("outra coisa: explica o formato", () => {
    for (const lido of ["abc", "BA-2630", "7891234567895X", "BA5-26X0", "5"])
      assert.match(normalizar(lido).erro, /não parece um código de barril\. O formato é BA5-1234\./, lido);
    assert.equal(normalizar("abc").erro, "“abc” não parece um código de barril. O formato é BA5-1234.");
    assert.match(normalizar("").erro, /Leia ou digite o código do barril/);
    assert.match(normalizar("   ").erro, /Leia ou digite o código do barril/);
  });
});

describe("o que dá para fazer com o barril lido", () => {
  const aqui = 1;
  const b = (extra) => ({ id: 10, codigo: "BA5-2630", unidade_id: aqui, unidade: "Bar do Centro", acesso: true, status: "disponivel", ...extra });

  test("disponível nesta unidade: pode engatar e enviar", () => {
    assert.equal(motivo(b(), { unitId: aqui, acao: "engatar" }), null);
    assert.equal(motivo(b(), { unitId: aqui, acao: "enviar", naLista: [11, 12] }), null);
  });

  test("cada situação tem a sua mensagem", () => {
    assert.equal(motivo(b({ unidade_id: 2, unidade: "Bar do Porto" }), { unitId: aqui }), "O barril #BA5-2630 está no Bar do Porto, não nesta loja.");
    assert.equal(motivo({ codigo: "BA5-2630", unidade_id: 3, unidade: "Bar do Bairro", acesso: false }, { unitId: aqui }),
      "O barril #BA5-2630 está no Bar do Bairro, não nesta loja.");
    assert.equal(motivo(b({ status: "em_uso", torneira_numero: 3 }), { unitId: aqui }), "O barril #BA5-2630 já está engatado na Torneira 3.");
    assert.equal(motivo(b({ status: "em_uso", torneira_numero: null }), { unitId: aqui }), "O barril #BA5-2630 já está engatado.");
    assert.equal(motivo(b({ status: "em_transferencia" }), { unitId: aqui }), "O barril #BA5-2630 está em transferência. Confirme o recebimento antes.");
    assert.equal(motivo({ codigo: "BA5-2630", unidade_id: 2, unidade: "Bar do Porto", acesso: false, status: "em_transferencia", destino_id: aqui }, { unitId: aqui }),
      "O barril #BA5-2630 está vindo para esta loja. Confirme o recebimento na aba Transferências antes.");
    assert.equal(motivo(b({ status: "esgotado" }), { unitId: aqui }), "O barril #BA5-2630 está vazio, aguardando o recolhimento.");
    assert.match(motivo(b({ status: "recolhido" }), { unitId: aqui }), /já foi recolhido pela fábrica\. Se ele voltou cheio, cadastre de novo na aba Barris\./);
  });

  test("na transferência, o mesmo barril não entra duas vezes", () => {
    assert.equal(motivo(b(), { unitId: aqui, acao: "enviar", naLista: [10] }), "O barril #BA5-2630 já está na lista.");
    assert.equal(motivo(b(), { unitId: aqui, acao: "engatar", naLista: [10] }), null);
  });
});

describe("barris:porCodigo e a câmera liberada", { skip: SEM_BANCO }, () => {
  let srv, admin, maria, joao, validade;
  const u = {};
  const ids = {};
  const porCodigo = (quem, unitId, busca) => quem.ok("barris:porCodigo", { unitId, ...busca });
  const idDe = async (unitId, codigo) => (await admin.ok("barris:list", { unitId })).find((b) => b.codigo === codigo).id;

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    u.centro = (await admin.ok("units:create", { razaoSocial: "Bar do Centro Bebidas Ltda", nome: "Bar do Centro", nomeCurto: "Centro", cnpj: "11.222.333/0001-81", endereco: "Av. Exemplo, 100, Centro, Cuiabá - MT" })).id;
    u.porto = (await admin.ok("units:create", { razaoSocial: "Bar do Porto Bebidas Ltda", nome: "Bar do Porto", nomeCurto: "Porto", cnpj: "11.444.777/0001-61", endereco: "Rua Exemplo, 200, Porto, Cuiabá - MT" })).id;
    maria = await makeOperator(srv.base, admin, { nome: "Maria", email: "maria@barrilfacil.test", unidadeIds: [u.centro] });
    joao = await makeOperator(srv.base, admin, { nome: "João", email: "joao@barrilfacil.test", unidadeIds: [u.porto] });
    ids.pilsen = (await admin.ok("chopes:create", { nome: "Pilsen Exemplo", custoLitro: 12 })).id;
    ids.ipa = (await admin.ok("chopes:create", { nome: "IPA Exemplo", custoLitro: 14 })).id;
    const hoje = (await admin.ok("config:get")).hoje;
    const d = new Date(`${hoje}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 5);
    validade = d.toISOString().slice(0, 10);
    await admin.ok("taps:create", { unitId: u.centro, quantidade: 2 });

    const cadastrar = (codigo, tamanho, unitId, chopeId = ids.pilsen) => admin.ok("barris:create", { codigo, chopeId, tamanho, validade, unitId });
    await cadastrar("BA5-2630", 50, u.centro);
    await cadastrar("BA2-1810", 20, u.centro, ids.ipa);
    await cadastrar("BA3-1810", 30, u.porto);
    await cadastrar("BA5-2488", 50, u.centro);
    await cadastrar("BA5-2590", 50, u.centro);
    await cadastrar("BA5-2700", 50, u.centro);
    await cadastrar("BA5-2900", 50, u.centro);

    // BA5-2488 engatado na Torneira 1; BA5-2700 vazio; BA5-2900 recolhido; BA5-2590 a caminho do Porto
    const torneira1 = (await admin.ok("units:details", { id: u.centro })).torneiras.find((t) => t.numero === 1 && t.ativo).id;
    const torneira2 = (await admin.ok("units:details", { id: u.centro })).torneiras.find((t) => t.numero === 2 && t.ativo).id;
    await admin.ok("barris:use", { id: await idDe(u.centro, "BA5-2488"), torneiraId: torneira1, unitId: u.centro });
    const b2700 = await idDe(u.centro, "BA5-2700");
    await admin.ok("barris:use", { id: b2700, torneiraId: torneira2, unitId: u.centro });
    await admin.ok("barris:empty", { id: b2700 });
    const b2900 = await idDe(u.centro, "BA5-2900");
    await admin.ok("barris:use", { id: b2900, torneiraId: torneira2, unitId: u.centro });
    await admin.ok("barris:empty", { id: b2900 });
    await admin.ok("barris:collect", { ids: [b2900], unitId: u.centro });
    await admin.ok("transfer:create", { barrilId: await idDe(u.centro, "BA5-2590"), destinoId: u.porto });
  });
  after(async () => { if (srv) await srv.stop(); });

  test("a página libera a câmera só para o próprio app", async () => {
    const r = await fetch(`${srv.base}/torneiras.html`);
    assert.equal(r.headers.get("permissions-policy"), "camera=(self), microphone=(), geolocation=()");
  });

  test("código inteiro: o barril com chope, tamanho, validade e unidade", async () => {
    const [b] = await porCodigo(maria, u.centro, { codigo: "BA5-2630" });
    assert.equal(b.codigo, "BA5-2630");
    assert.equal(b.status, "disponivel");
    assert.equal(b.chope_nome, "Pilsen Exemplo");
    assert.equal(Number(b.tamanho_l), 50);
    assert.equal(b.validade, validade);
    assert.equal(b.unidade_id, u.centro);
    assert.equal(b.unidade, "Bar do Centro");
    assert.equal(b.acesso, true);
    assert.equal(motivo(b, { unitId: u.centro }), null);
    assert.deepEqual(await porCodigo(maria, u.centro, { codigo: "BA5-9999" }), []); // não cadastrado
  });

  test("engatado traz a torneira; vazio e em transferência trazem a situação", async () => {
    const [engatado] = await porCodigo(maria, u.centro, { codigo: "BA5-2488" });
    assert.equal(engatado.status, "em_uso");
    assert.equal(engatado.torneira_numero, 1);
    assert.equal(motivo(engatado, { unitId: u.centro }), "O barril #BA5-2488 já está engatado na Torneira 1.");
    const [vazio] = await porCodigo(maria, u.centro, { codigo: "BA5-2700" });
    assert.equal(vazio.status, "esgotado");
    const [indo] = await porCodigo(maria, u.centro, { codigo: "BA5-2590" });
    assert.equal(indo.status, "em_transferencia");
    assert.equal(indo.destino_id, u.porto);
    assert.equal(motivo(indo, { unitId: u.centro }), "O barril #BA5-2590 está em transferência. Confirme o recebimento antes.");
  });

  test("só números: todos os barris com esse final, a unidade aberta primeiro", async () => {
    const lista = await porCodigo(admin, u.centro, { numero: "1810" });
    assert.deepEqual(lista.map((b) => b.codigo), ["BA2-1810", "BA3-1810"]);
    assert.deepEqual(lista.map((b) => b.unidade), ["Bar do Centro", "Bar do Porto"]);
    assert.deepEqual((await porCodigo(admin, u.porto, { numero: "1810" })).map((b) => b.codigo), ["BA3-1810", "BA2-1810"]);
    assert.deepEqual((await porCodigo(admin, u.centro, { numero: "2630" })).map((b) => b.codigo), ["BA5-2630"]);
  });

  test("barril de unidade sem acesso: só o código e o nome da unidade", async () => {
    const lista = await porCodigo(maria, u.centro, { numero: "1810" });
    const fora = lista.find((b) => b.codigo === "BA3-1810");
    assert.deepEqual(fora, { codigo: "BA3-1810", unidade_id: u.porto, unidade: "Bar do Porto", acesso: false });
    assert.equal(motivo(fora, { unitId: u.centro }), "O barril #BA3-1810 está no Bar do Porto, não nesta loja.");
  });

  test("a caminho desta loja: o destino vê a situação, mesmo sem acesso à origem", async () => {
    const [vindo] = await porCodigo(joao, u.porto, { codigo: "BA5-2590" });
    assert.equal(vindo.acesso, false);
    assert.equal(vindo.status, "em_transferencia");
    assert.equal(vindo.destino_id, u.porto);
    assert.equal(vindo.chope_nome, undefined);
    assert.equal(motivo(vindo, { unitId: u.porto }), "O barril #BA5-2590 está vindo para esta loja. Confirme o recebimento na aba Transferências antes.");
  });

  test("recolhido: aparece só enquanto o código não tem um ciclo novo", async () => {
    const [recolhido] = await porCodigo(admin, u.centro, { codigo: "BA5-2900" });
    assert.equal(recolhido.status, "recolhido");
    await admin.ok("barris:create", { codigo: "BA5-2900", chopeId: ids.ipa, tamanho: 50, validade, unitId: u.centro });
    const lista = await porCodigo(admin, u.centro, { codigo: "BA5-2900" });
    assert.equal(lista.length, 1);
    assert.equal(lista[0].status, "disponivel");
    assert.equal(lista[0].chope_nome, "IPA Exemplo");
  });

  test("pedido inválido ou de unidade sem acesso é recusado", async () => {
    await maria.fail("barris:porCodigo", { unitId: u.centro, codigo: "XYZ" }, /não parece um código de barril/);
    await maria.fail("barris:porCodigo", { unitId: u.centro }, /Leia ou digite o código do barril/);
    await maria.fail("barris:porCodigo", { unitId: u.centro, numero: "1" }, /Leia ou digite o código do barril/);
    await maria.fail("barris:porCodigo", { unitId: u.porto, codigo: "BA5-2630" }, /não tem acesso a esta unidade/);
  });
});
