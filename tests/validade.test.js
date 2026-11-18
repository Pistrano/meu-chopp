/* ==========================================================
   BarrilFacil — testes: aviso de validade (sino e selos) conforme a situação do barril
   Avisa: disponível e em transferência. Não avisa: engatado (em uso), vazio e recolhido.
   Rodar:  npm test   (precisa do Supabase local; veja "Rodar os testes" no README)
   ========================================================== */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SEM_BANCO, banco, limparBanco, startServer, setupAdmin } = require("./helpers");

const somaDias = (dia, n) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe("aviso de validade", { skip: SEM_BANCO }, () => {
  let srv, admin, hoje, chope;
  const u = {};

  // Avisos de validade do sino para um barril (os outros alertas, como estoque baixo, não interessam aqui)
  const avisosDe = async (unitId, codigo) =>
    (await admin.ok("alerts:list", { unitId })).filter((a) => a.texto.startsWith(`Barril #${codigo} `) && /venc/.test(a.texto));
  const naLista = async (unitId, codigo) => (await admin.ok("barris:list", { unitId })).find((b) => b.codigo === codigo);
  const noQuadro = async (unitId, codigo) => (await admin.ok("taps:board", { unitId })).torneiras.find((t) => t.codigo === codigo);
  const torneiraLivre = async (unitId) => (await admin.ok("taps:board", { unitId })).torneiras.find((t) => !t.ocupada);
  const cadastrar = async (codigo, validade, unitId = u.centro) =>
    (await admin.ok("barris:create", { codigo, chopeId: chope, tamanho: 30, validade, unitId })).id;
  // O cadastro não aceita data no passado: o barril "vencido" é cadastrado e a validade é trocada direto no banco
  const vencer = async (id, dias = 1) => {
    const { error } = await banco().from("barris").update({ validade: somaDias(hoje, -dias) }).eq("id", id);
    assert.ifError(error);
  };

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    u.centro = (await admin.ok("units:create", { razaoSocial: "Bar do Centro Bebidas Ltda", nome: "Bar do Centro", nomeCurto: "Centro", cnpj: "11.222.333/0001-81", endereco: "Av. Brasil, 100, Centro, Cuiabá - MT" })).id;
    u.porto = (await admin.ok("units:create", { razaoSocial: "Bar do Porto Bebidas Ltda", nome: "Bar do Porto", nomeCurto: "Porto", cnpj: "11.444.777/0001-61", endereco: "Rua do Porto, 200, Cuiabá - MT" })).id;
    await admin.ok("taps:create", { unitId: u.centro, quantidade: 2 });
    chope = (await admin.ok("chopes:create", { nome: "Chopp Pilsen", custoLitro: 12 })).id;
    hoje = (await admin.ok("config:get")).hoje;
  });
  after(async () => { if (srv) await srv.stop(); });

  test("disponível vencendo amanhã avisa; engatado não avisa nem tem selo; vazio continua sem aviso", async () => {
    const id = await cadastrar("V1", somaDias(hoje, 1));

    // Disponível: aviso no sino e selo na aba Barris
    assert.deepEqual((await avisosDe(u.centro, "V1")).map((a) => a.texto), [`Barril #V1 (Chopp Pilsen) vence amanhã (${somaDias(hoje, 1).slice(8, 10)}/${somaDias(hoje, 1).slice(5, 7)}).`]);
    assert.equal((await naLista(u.centro, "V1")).situacao_validade, "vence_amanha");

    // Engatado: some do sino, da aba Barris, do cartão da torneira e da escolha de torneira (a data continua no cartão)
    const tap = await torneiraLivre(u.centro);
    await admin.ok("barris:use", { id, torneiraId: tap.id, unitId: u.centro });
    assert.deepEqual(await avisosDe(u.centro, "V1"), []);
    assert.equal((await naLista(u.centro, "V1")).status, "em_uso");
    assert.equal((await naLista(u.centro, "V1")).situacao_validade, null);
    const cartao = await noQuadro(u.centro, "V1");
    assert.equal(cartao.validade, somaDias(hoje, 1), "o cartão da torneira continua com a data");
    assert.equal(cartao.situacao_validade, null);
    assert.equal((await admin.ok("taps:forBarril", { barrilId: id })).barril.situacao_validade, null);
    assert.equal((await admin.ok("units:details", { id: u.centro })).torneiras.find((t) => t.codigo === "V1").situacao_validade, null);

    // Retirado como vazio: continua sem aviso
    await admin.ok("barris:empty", { id });
    assert.deepEqual(await avisosDe(u.centro, "V1"), []);
    assert.equal((await naLista(u.centro, "V1")).situacao_validade, null);
  });

  test("engatado e vencido continua sem aviso; a regra está na função do banco (o sino não filtra de novo)", async () => {
    const id = await cadastrar("V2", somaDias(hoje, 3));
    await admin.ok("barris:use", { id, torneiraId: (await torneiraLivre(u.centro)).id, unitId: u.centro });
    await vencer(id, 2);
    assert.deepEqual(await avisosDe(u.centro, "V2"), []);
    assert.equal((await noQuadro(u.centro, "V2")).situacao_validade, null);

    const { data, error } = await banco().rpc("fn_alertas_validade", { p_unit: u.centro, p_hoje: hoje });
    assert.ifError(error);
    assert.ok(!data.some((b) => b.codigo === "V2"), "a função não devolve barril em uso");
    await admin.ok("barris:empty", { id });
  });

  test("em transferência e vencido avisa, com selo vermelho", async () => {
    const id = await cadastrar("V3", somaDias(hoje, 3));
    await admin.ok("transfer:create", { barrilId: id, destinoId: u.porto });
    await vencer(id);
    const avisos = await avisosDe(u.centro, "V3");
    assert.equal(avisos.length, 1);
    assert.equal(avisos[0].nivel, "erro");
    assert.match(avisos[0].texto, /^Barril #V3 \(Chopp Pilsen\) venceu em /);
    const b = await naLista(u.centro, "V3");
    assert.equal(b.status, "em_transferencia");
    assert.equal(b.situacao_validade, "vencido");
  });

  test("engatar barril disponível vencido continua pedindo confirmação e registra na auditoria", async () => {
    const id = await cadastrar("V4", somaDias(hoje, 3));
    await vencer(id);
    assert.equal((await avisosDe(u.centro, "V4"))[0].nivel, "erro");
    assert.equal((await naLista(u.centro, "V4")).situacao_validade, "vencido");

    const tap = await torneiraLivre(u.centro);
    const r = await admin.fail("barris:use", { id, torneiraId: tap.id, unitId: u.centro }, /venceu em .* Engatar mesmo assim\?/);
    assert.equal(r.code, "BARRIL_VENCIDO");
    assert.equal((await naLista(u.centro, "V4")).status, "disponivel", "sem confirmação não engata");

    await admin.ok("barris:use", { id, torneiraId: tap.id, unitId: u.centro, confirmarVencido: true });
    const { data, error } = await banco().from("auditoria").select("detalhe").eq("acao", "engate_barril_vencido");
    assert.ifError(error);
    assert.ok(data.some((a) => /V4/.test(a.detalhe)), "o engate do vencido fica na auditoria");

    // Engatado, o vencido deixa de avisar
    assert.deepEqual(await avisosDe(u.centro, "V4"), []);
    assert.equal((await noQuadro(u.centro, "V4")).situacao_validade, null);
  });
});
