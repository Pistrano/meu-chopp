/* ==========================================================
   BarrilFacil — testes: funcionários do quiosque e quem fez cada ação
   Rodar:  npm test   (precisa do Supabase local; veja "Rodar os testes" no README)
   ========================================================== */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SEM_BANCO, banco, limparBanco, startServer, setupAdmin, makeUser } = require("./helpers");

const SEM_PERMISSAO = /Você não tem permissão para esta ação/;
const ESCOLHA = /Escolha quem está fazendo antes de salvar/;

const somaDias = (dia, n) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// CSV do app: ";" entre as células, cada célula entre aspas, linhas com \r\n
const csvLinhas = (csv) => csv.replace(/^﻿/, "").split("\r\n").map((l) => (l ? l.slice(1, -1).split('";"') : []));

describe("funcionários do quiosque e quem fez cada ação", { skip: SEM_BANCO }, () => {
  let srv, admin, gerente, quiosque, quiosquePantanal, hoje, validade;
  const u = {};
  const f = {};   // funcionários
  const t = {};   // torneiras
  let chope;

  const consulta = async (q) => { const { data, error } = await q; assert.ifError(error); return data; };
  const barril = async (who, unitId, codigo) => (await who.ok("barris:list", { unitId })).find((b) => b.codigo === codigo);
  const cadastrar = (who, unitId, codigo, extra = {}) =>
    who.ok("barris:create", { codigo, chopeId: chope, tamanho: 30, validade, unitId, ...extra });
  const historico = async (unitId, codigo) =>
    (await admin.ok("history:list", { unitId, q: codigo })).filter((m) => m.codigo === codigo).reverse(); // mais antigo primeiro
  const ultimaAuditoria = async (acao) =>
    (await consulta(banco().from("auditoria").select("detalhe").eq("acao", acao).order("id", { ascending: false }).limit(1)))[0];

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    u.centro = (await admin.ok("units:create", { razaoSocial: "Bar do Centro Bebidas Ltda", nome: "Bar do Centro", nomeCurto: "Centro", cnpj: "11.222.333/0001-81", endereco: "Av. Brasil, 100, Centro, Cuiabá - MT" })).id;
    u.pantanal = (await admin.ok("units:create", { razaoSocial: "Bar Pantanal Bebidas Ltda", nome: "Bar Pantanal", nomeCurto: "Pantanal", cnpj: "11.444.777/0001-61", endereco: "Av. do Pantanal, 200, Cuiabá - MT" })).id;
    u.vazia = (await admin.ok("units:create", { razaoSocial: "Bar Novo Bebidas Ltda", nome: "Bar Novo", nomeCurto: "Novo", cnpj: "34.028.316/0001-03", endereco: "Rua Nova, 10, Centro, Cuiabá - MT" })).id;
    await admin.ok("taps:create", { unitId: u.centro, quantidade: 2 });
    await admin.ok("taps:create", { unitId: u.vazia, quantidade: 1 });
    const torneiras = (await admin.ok("units:details", { id: u.centro })).torneiras;
    t.um = torneiras.find((x) => x.numero === 1).id;
    t.dois = torneiras.find((x) => x.numero === 2).id;
    t.vazia = (await admin.ok("units:details", { id: u.vazia })).torneiras[0].id;
    const estilo = await admin.ok("estilos:create", { nome: "Pilsen" });
    chope = (await admin.ok("chopes:create", { nome: "Chopp Pilsen", estiloId: estilo.id })).id;
    hoje = (await admin.ok("config:get")).hoje;
    validade = somaDias(hoje, 5);
    gerente = await makeUser(srv.base, admin, { nome: "Gina", email: "gina@barrilfacil.test", cargo: "gerente", unidadeIds: [u.centro] });
    quiosque = await makeUser(srv.base, admin, { nome: "Quiosque Centro", email: "quiosque@barrilfacil.test", cargo: "operador", unidadeIds: [u.centro, u.vazia] });
    quiosquePantanal = await makeUser(srv.base, admin, { nome: "Quiosque Pantanal", email: "pantanal@barrilfacil.test", cargo: "operador", unidadeIds: [u.pantanal] });
  });
  after(async () => { if (srv) await srv.stop(); });

  /* ---------------- Cadastro ---------------- */
  test("gerente cadastra funcionário só nas unidades dele; nome não repete; auditoria", async () => {
    f.ana = (await gerente.ok("funcionarios:create", { nome: "  Ana   Souza ", unidadeIds: [u.centro] })).id;
    assert.equal((await consulta(banco().from("funcionarios").select("nome, ativo").eq("id", f.ana)))[0].nome, "Ana Souza");
    assert.equal((await ultimaAuditoria("funcionario_criado")).detalhe, "Ana Souza (Centro)");
    await gerente.fail("funcionarios:create", { nome: "Bruno", unidadeIds: [u.pantanal] }, /não tem acesso a esta unidade/);
    await gerente.fail("funcionarios:create", { nome: "Bruno", unidadeIds: [u.centro, u.pantanal] }, /não tem acesso a esta unidade/);
    assert.equal((await consulta(banco().from("funcionarios").select("id").eq("nome", "Bruno"))).length, 0);
    await gerente.fail("funcionarios:create", { nome: "ana souza", unidadeIds: [u.centro] }, /Já existe um funcionário chamado "Ana Souza"/);
    await gerente.fail("funcionarios:create", { nome: "Bruno", unidadeIds: [] }, /Escolha ao menos uma unidade/);
    await gerente.fail("funcionarios:create", { nome: "B", unidadeIds: [u.centro] }, /de 2 a 60 caracteres/);
    f.bruno = (await gerente.ok("funcionarios:create", { nome: "Bruno", unidadeIds: [u.centro] })).id;
    f.carla = (await admin.ok("funcionarios:create", { nome: "Carla", unidadeIds: [u.pantanal] })).id;
    f.davi = (await admin.ok("funcionarios:create", { nome: "Davi", unidadeIds: [u.centro, u.pantanal] })).id;
  });

  test("lista por unidade: quem cadastra vê todos com as unidades dele; operador vê só id e nome dos ativos", async () => {
    const doAdmin = await admin.ok("funcionarios:list", { unitId: u.centro });
    assert.deepEqual(doAdmin.map((x) => x.nome), ["Ana Souza", "Bruno", "Davi"]);
    assert.deepEqual(doAdmin.find((x) => x.id === f.davi).unidades, ["Centro", "Pantanal"]);
    // o gerente não vê as unidades que não são dele
    const daGerente = await gerente.ok("funcionarios:list", { unitId: u.centro });
    assert.deepEqual(daGerente.find((x) => x.id === f.davi).unidadeIds, [u.centro]);
    await gerente.fail("funcionarios:list", { unitId: u.pantanal }, /não tem acesso a esta unidade/);
    const doQuiosque = await quiosque.ok("funcionarios:list", { unitId: u.centro });
    assert.deepEqual(doQuiosque, [{ id: f.ana, nome: "Ana Souza" }, { id: f.bruno, nome: "Bruno" }, { id: f.davi, nome: "Davi" }]);
    assert.deepEqual(await quiosque.ok("funcionarios:list", { unitId: u.vazia }), []);
  });

  test("editar: o gerente troca nome e unidades dele, e as unidades de outros continuam", async () => {
    await gerente.ok("funcionarios:update", { id: f.davi, nome: "Davi Lima", unidadeIds: [u.centro] });
    const un = await consulta(banco().from("funcionario_unidades").select("unidade_id").eq("funcionario_id", f.davi).order("unidade_id"));
    assert.deepEqual(un.map((x) => x.unidade_id), [u.centro, u.pantanal]);
    assert.equal((await ultimaAuditoria("funcionario_editado")).detalhe, "Davi → Davi Lima, unidades Centro");
    await gerente.fail("funcionarios:update", { id: f.carla, nome: "Carla", unidadeIds: [u.centro] }, /não tem acesso a este funcionário/);
    await gerente.fail("funcionarios:update", { id: f.ana, nome: "Bruno", unidadeIds: [u.centro] }, /Já existe um funcionário chamado "Bruno"/);
    await gerente.fail("funcionarios:update", { id: f.ana, nome: "Ana Souza", unidadeIds: [u.pantanal] }, /não tem acesso a esta unidade/);
  });

  test("operador não cadastra, não edita e não desativa funcionários", async () => {
    await quiosque.fail("funcionarios:create", { nome: "Zé", unidadeIds: [u.centro] }, SEM_PERMISSAO);
    await quiosque.fail("funcionarios:update", { id: f.ana, nome: "Zé", unidadeIds: [u.centro] }, SEM_PERMISSAO);
    await quiosque.fail("funcionarios:toggle", { id: f.ana }, SEM_PERMISSAO);
  });

  /* ---------------- Quem está fazendo ---------------- */
  test("operador sem funcionário é recusado quando a unidade tem funcionários; outra unidade e desativado também", async () => {
    await quiosque.fail("barris:create", { codigo: "F1", chopeId: chope, tamanho: 30, validade, unitId: u.centro }, ESCOLHA);
    await quiosque.fail("barris:create", { codigo: "F1", chopeId: chope, tamanho: 30, validade, unitId: u.centro, funcionarioId: f.carla },
      /Carla não está cadastrado nesta unidade/);
    f.edu = (await admin.ok("funcionarios:create", { nome: "Edu", unidadeIds: [u.centro] })).id;
    await admin.ok("funcionarios:toggle", { id: f.edu });
    assert.equal((await ultimaAuditoria("funcionario_desativado")).detalhe, "Edu");
    await quiosque.fail("barris:create", { codigo: "F1", chopeId: chope, tamanho: 30, validade, unitId: u.centro, funcionarioId: f.edu },
      /Edu está desativado/);
    assert.equal((await consulta(banco().from("barris").select("id").eq("codigo", "F1"))).length, 0, "nada foi gravado");
    // desativado some da lista do quiosque e reativado volta
    assert.equal((await quiosque.ok("funcionarios:list", { unitId: u.centro })).some((x) => x.id === f.edu), false);
    await gerente.ok("funcionarios:toggle", { id: f.edu });
    assert.equal((await quiosque.ok("funcionarios:list", { unitId: u.centro })).some((x) => x.id === f.edu), true);
  });

  test("cadastro, engate e retirada gravam o funcionário e aparecem no histórico e na torneira", async () => {
    await cadastrar(quiosque, u.centro, "F1", { funcionarioId: f.ana });
    const b = await barril(quiosque, u.centro, "F1");
    await quiosque.fail("barris:use", { id: b.id, torneiraId: t.um }, ESCOLHA);
    await quiosque.ok("barris:use", { id: b.id, torneiraId: t.um, funcionarioId: f.bruno });
    await quiosque.fail("barris:empty", { id: b.id }, ESCOLHA);
    await quiosque.ok("barris:empty", { id: b.id, funcionarioId: f.davi });

    const e = (await consulta(banco().from("engates").select("engatado_func_id, retirado_func_id").eq("barril_id", b.id)))[0];
    assert.deepEqual(e, { engatado_func_id: f.bruno, retirado_func_id: f.davi });
    const movs = await consulta(banco().from("movimentacoes").select("operacao, funcionario_id").eq("barril_id", b.id).order("id"));
    assert.deepEqual(movs, [
      { operacao: "entrada", funcionario_id: f.ana },
      { operacao: "utilizacao", funcionario_id: f.bruno },
      { operacao: "esgotado", funcionario_id: f.davi },
    ]);
    // Histórico: "Quem fez" é o funcionário; a conta logada continua registrada
    const h = await historico(u.centro, "F1");
    assert.deepEqual(h.map((m) => m.responsavel), ["Ana Souza", "Bruno", "Davi Lima"]);
    assert.ok(h.every((m) => m.usuario === "Quiosque Centro"));
    // filtro por funcionário
    const doBruno = await admin.ok("history:list", { unitId: u.centro, funcionarioId: f.bruno });
    assert.deepEqual(doBruno.map((m) => `${m.codigo} ${m.operacao}`), ["F1 utilizacao"]);
    // histórico da torneira: quem engatou e quem retirou
    const th = (await quiosque.ok("taps:history", { torneiraId: t.um })).engates[0];
    assert.equal(th.engatado_por, "Bruno");
    assert.equal(th.retirado_por, "Davi Lima");
    // auditoria com o nome do funcionário
    assert.equal((await ultimaAuditoria("barril_em_uso")).detalhe, "Barril #F1 engatado na Torneira 1 (Bar do Centro) · funcionário Bruno");
  });

  test("a torneira ocupada mostra quem engatou; CSV do histórico, do estoque e do relatório têm o funcionário", async () => {
    await cadastrar(quiosque, u.centro, "F2", { funcionarioId: f.ana });
    const b = await barril(quiosque, u.centro, "F2");
    await quiosque.ok("barris:use", { id: b.id, torneiraId: t.dois, funcionarioId: f.ana });
    const quadro = await quiosque.ok("taps:board", { unitId: u.centro });
    assert.equal(quadro.torneiras.find((x) => x.id === t.dois).engatado_por, "Ana Souza");

    const hist = csvLinhas((await admin.ok("history:export", { unitId: u.centro, q: "F1" })).csv);
    const cab = hist[0];
    assert.deepEqual(cab.slice(8, 10), ["Responsável", "Funcionário"]);
    const retirada = hist.find((l) => l[4] === "Vazio");
    assert.equal(retirada[8], "Quiosque Centro");
    assert.equal(retirada[9], "Davi Lima");

    const estoque = csvLinhas((await admin.ok("barris:exportStock", { unitId: u.centro })).csv);
    assert.equal(estoque[0].at(-1), "Funcionário");
    assert.equal(estoque.find((l) => l[0] === "#F2").at(-1), "Ana Souza");   // engatou (última ação)
    assert.equal(estoque.find((l) => l[0] === "#F1").at(-1), "Davi Lima");   // retirou

    const periodo = { unidadeId: u.centro, de: somaDias(hoje, -1), ate: hoje };
    const detalhe = await admin.ok("reports:barrelsDetail", { ...periodo, chopeId: chope });
    const d1 = detalhe.find((x) => x.codigo === "F1");
    assert.deepEqual([d1.engatado_por, d1.retirado_por], ["Bruno", "Davi Lima"]);
    assert.equal(detalhe.find((x) => x.codigo === "F2").retirado_por, null);
    const rel = csvLinhas((await admin.ok("reports:barrelsExport", periodo)).csv);
    const inicio = rel.findIndex((l) => l[0] === "Barris utilizados no período");
    assert.ok(inicio > 0, "o CSV do relatório tem a lista de barris");
    assert.deepEqual(rel[inicio + 1].slice(-2), ["Funcionário (engate)", "Funcionário (retirada)"]);
    const linhaF1 = rel.slice(inicio + 2).find((l) => l[2] === "#F1");
    assert.deepEqual(linhaF1.slice(-2), ["Bruno", "Davi Lima"]);
  });

  test("recolhimento e transferências (criar, confirmar e cancelar) gravam o funcionário", async () => {
    const f1 = await barril(quiosque, u.centro, "F1");
    await quiosque.fail("barris:collect", { ids: [f1.id], unitId: u.centro }, ESCOLHA);
    await quiosque.ok("barris:collect", { ids: [f1.id], unitId: u.centro, funcionarioId: f.bruno });
    assert.equal((await consulta(banco().from("movimentacoes").select("funcionario_id").eq("barril_id", f1.id).eq("operacao", "recolhimento")))[0].funcionario_id, f.bruno);

    await cadastrar(quiosque, u.centro, "T1", { funcionarioId: f.ana });
    await cadastrar(quiosque, u.centro, "T2", { funcionarioId: f.ana });
    const t1 = await barril(quiosque, u.centro, "T1");
    const t2 = await barril(quiosque, u.centro, "T2");
    await quiosque.fail("transfer:create", { barrilId: t1.id, destinoId: u.pantanal }, ESCOLHA);
    await quiosque.ok("transfer:create", { barrilId: t1.id, destinoId: u.pantanal, funcionarioId: f.ana });
    await quiosque.ok("transfer:create", { barrilId: t2.id, destinoId: u.pantanal, funcionarioId: f.bruno });
    const pend = await quiosquePantanal.ok("transfer:list", { unitId: u.pantanal });
    const tr1 = pend.find((x) => x.codigo === "T1");
    assert.equal(tr1.solicitante, "Ana Souza");
    // quem recebe é da unidade de destino: Carla e Davi trabalham no Pantanal, Ana não
    await quiosquePantanal.fail("transfer:confirm", { id: tr1.id, funcionarioId: f.ana }, /Ana Souza não está cadastrado nesta unidade/);
    await quiosquePantanal.ok("transfer:confirm", { id: tr1.id, funcionarioId: f.carla });
    await quiosque.ok("transfer:cancel", { id: pend.find((x) => x.codigo === "T2").id, funcionarioId: f.davi });
    const tr = await consulta(banco().from("transferencias").select("barril_id, solicitante_func_id, recebedor_func_id, status").in("barril_id", [t1.id, t2.id]).order("barril_id"));
    assert.deepEqual(tr, [
      { barril_id: t1.id, solicitante_func_id: f.ana, recebedor_func_id: f.carla, status: "confirmada" },
      { barril_id: t2.id, solicitante_func_id: f.bruno, recebedor_func_id: null, status: "cancelada" },
    ]);
    assert.equal((await quiosquePantanal.ok("transfer:list", { unitId: u.pantanal })).find((x) => x.codigo === "T1").recebedor, "Carla");
    const cancel = await consulta(banco().from("movimentacoes").select("funcionario_id, observacao").eq("barril_id", t2.id).order("id", { ascending: false }).limit(1));
    assert.equal(cancel[0].funcionario_id, f.davi);
    assert.match(cancel[0].observacao, /cancelada/);
  });

  test("administrador e gerente registram no próprio nome, sem funcionário (mesmo se mandarem um)", async () => {
    await cadastrar(admin, u.centro, "A1");
    await cadastrar(gerente, u.centro, "G1", { funcionarioId: f.ana });
    const g1 = await barril(gerente, u.centro, "G1");
    await gerente.ok("barris:use", { id: g1.id, torneiraId: t.um });
    const movs = await consulta(banco().from("movimentacoes").select("funcionario_id, barris!inner(codigo)").in("barris.codigo", ["A1", "G1"]));
    assert.ok(movs.length >= 3 && movs.every((m) => m.funcionario_id === null));
    const h = await historico(u.centro, "G1");
    assert.ok(h.every((m) => m.responsavel === "Gina" && m.funcionario === null));
    assert.equal((await historico(u.centro, "A1"))[0].responsavel, "Eduardo");
  });

  test("unidade sem funcionários ativos aceita a ação do operador sem funcionário", async () => {
    await cadastrar(quiosque, u.vazia, "V1");
    const v1 = await barril(quiosque, u.vazia, "V1");
    await quiosque.ok("barris:use", { id: v1.id, torneiraId: t.vazia });
    await quiosque.ok("barris:empty", { id: v1.id });
    const h = await historico(u.vazia, "V1");
    assert.equal(h.length, 3);
    assert.ok(h.every((m) => m.responsavel === "Quiosque Centro" && m.funcionario === null));
  });

  test("o Painel avisa admin e gerente quando a unidade não tem funcionários; o operador não vê o aviso", async () => {
    assert.equal((await admin.ok("dashboard:get", { unitId: u.vazia })).semFuncionarios, "Bar Novo");
    assert.equal((await admin.ok("dashboard:get", { unitId: u.centro })).semFuncionarios, null);
    assert.equal((await gerente.ok("dashboard:get", { unitId: u.centro })).semFuncionarios, null);
    assert.equal((await quiosque.ok("dashboard:get", { unitId: u.vazia })).semFuncionarios, null);
    // só funcionário desativado também conta como "sem funcionários"
    const z = (await admin.ok("funcionarios:create", { nome: "Zélia", unidadeIds: [u.vazia] })).id;
    assert.equal((await admin.ok("dashboard:get", { unitId: u.vazia })).semFuncionarios, null);
    await admin.ok("funcionarios:toggle", { id: z });
    assert.equal((await admin.ok("dashboard:get", { unitId: u.vazia })).semFuncionarios, "Bar Novo");
  });
});
