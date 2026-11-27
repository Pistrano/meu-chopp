/* ==========================================================
   BarrilFacil — testes: Painel do computador (dashboard:computador)
   A perda vem das funções do Relatório de perdas (o cenário inventado de tests/fixtures/perdas-cenario.js); aqui se
   confere o que o Painel faz com ela: os períodos, o período escolhido, o estoque por chope com a situação, o dinheiro
   só para quem pode e os casos sem perda (menos de dois inventários, período sem vendas).
   Rodar:  npm test   (a parte com banco precisa do Supabase local; veja "Rodar os testes" no README)
   ========================================================== */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SEM_BANCO, banco, limparBanco, startServer, setupAdmin, makeUser } = require("./helpers");
const { montar } = require("./fixtures/perdas-cenario");
const { montarPainelComputador } = require("../src/server/painel");
const { montarAlertas, estoquePorChope, situacaoEstoque } = require("../src/server/alertas");

const DINHEIRO = ["custo_litro", "reais", "sem_preco"];
const chaves = (o, acc = new Set()) => {
  if (Array.isArray(o)) o.forEach((x) => chaves(x, acc));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { acc.add(k); chaves(v, acc); }
  return acc;
};
const comDinheiro = (o) => DINHEIRO.filter((k) => chaves(o).has(k));
const linhaEstoque = (e) => [e.nome, e.engatados, e.disponiveis, e.saiu, e.situacao];

/* ---------- Sem banco: a montagem do Painel ---------- */
describe("Painel do computador: montagem", () => {
  const fmtTs = (t) => (t ? String(t).replace("T", " ").slice(0, 19) : "");
  const barris = (chope_id, chope_nome, status, n = 1) => Array.from({ length: n }, () => ({ chope_id, chope_nome, estilo: chope_nome, status }));
  // Quatro chopes: 0, 1, 2 e 3 disponíveis
  const estoque = [
    ...barris(1, "Pilsen", "disponivel", 3), ...barris(1, "Pilsen", "em_uso"),
    ...barris(2, "IPA", "disponivel", 2),
    ...barris(3, "Weiss", "disponivel"), ...barris(3, "Weiss", "esgotado", 2),
    ...barris(4, "Neipa", "em_uso"), ...barris(4, "Neipa", "em_transferencia"),
    ...barris(null, "Stout", "em_uso"),
  ];
  const total = { saiu: 100, vendido: 90, perda: 10, pct: 10, estimado: false, reais: 120, sem_preco: ["Neipa"] };
  const chope = (chope_id, nome, saiu) => ({ chope_id, nome, saiu, vendido: saiu - 1, perda: 1, pct: 1, custo_litro: 12, reais: 12, estimado: false, sem_preco: false, barris: [] });
  const relatorio = {
    unidade: { id: 7, nome: "Bar do Centro" },
    inventario_de: { id: 1, iniciado_em: "2026-10-05T22:00:00", concluido_em: "2026-10-05T22:40:00" },
    inventario_ate: { id: 2, iniciado_em: "2026-10-10T22:00:00", concluido_em: "2026-10-10T22:40:00" },
    de: "2026-10-05T22:40:00", ate: "2026-10-10T22:40:00", sem_vendas: false, dias_sem_vendas: [], total,
    // IPA saiu mais que Weiss; a Stout (barril antigo, sem chope do catálogo) casa pelo nome
    chopes: [chope(1, "Pilsen", 50), chope(2, "IPA", 30), chope(3, "Weiss", 12), chope(null, "Stout", 8)],
  };
  const periodos = {
    inventarios: [{ id: 3 }, { id: 2 }, { id: 1 }], aberto: null,
    periodos: [
      { inventario_de: 2, inventario_ate: 3, de: "2026-10-10T22:40:00", ate: "2026-10-15T22:40:00", sem_vendas: true, dias_sem_vendas: [], ...total, perda: null, reais: null },
      { inventario_de: 1, inventario_ate: 2, de: "2026-10-05T22:40:00", ate: "2026-10-10T22:40:00", sem_vendas: false, dias_sem_vendas: [], ...total },
    ],
  };

  test("situação: nenhum disponível = sem estoque, 1 ou 2 = acabando, 3 ou mais = ok (a mesma regra do sino)", () => {
    assert.deepEqual([0, 1, 2, 3, 9].map(situacaoEstoque), ["sem_estoque", "acabando", "acabando", "ok", "ok"]);
    const porChope = estoquePorChope(estoque);
    assert.deepEqual(porChope.map((c) => [c.nome, c.engatados, c.disponiveis, c.situacao]), [
      ["Pilsen", 1, 3, "ok"], ["IPA", 0, 2, "acabando"], ["Weiss", 0, 1, "acabando"], ["Neipa", 1, 0, "sem_estoque"], ["Stout", 1, 0, "sem_estoque"],
    ]);
    // O sino avisa exatamente os que não estão "ok"
    const avisos = montarAlertas({ unit: 7, hoje: "2026-10-20", estoque }).map((a) => [a.titulo, a.tipo]);
    assert.deepEqual(avisos, porChope.filter((c) => c.situacao !== "ok").map((c) => [c.nome, c.situacao]));
  });

  test("ordem do estoque: sem estoque, acabando, ok; dentro de cada grupo, o que mais saiu no período", () => {
    const d = montarPainelComputador({ periodos, relatorio, estoque }, { dinheiro: true, fmtTs });
    assert.deepEqual(d.estoque.map(linhaEstoque), [
      ["Stout", 1, 0, 8, "sem_estoque"], ["Neipa", 1, 0, 0, "sem_estoque"],
      ["IPA", 0, 2, 30, "acabando"], ["Weiss", 0, 1, 12, "acabando"],
      ["Pilsen", 1, 3, 50, "ok"],
    ]);
    assert.equal(d.noEstoque, 9, "disponíveis + engatados");
    assert.equal(d.vazios, 2);
    assert.deepEqual(d.periodos.map((p) => p.inventario_ate), [2, 3], "do mais velho para o mais novo");
    assert.equal(d.periodo.inventario_ate.id, 2);
    assert.deepEqual(d.periodo.total.sem_preco, ["Neipa"], "chope sem preço vai para o \"Fora da conta\"");
  });

  test("sem \"catalogo:editar\", nenhum valor em R$ sai do servidor", () => {
    const d = montarPainelComputador({ periodos, relatorio, estoque }, { dinheiro: false, fmtTs });
    assert.equal(d.dinheiro, false);
    assert.deepEqual(comDinheiro(d), []);
    assert.equal(d.periodo.total.perda, 10, "litros e % continuam");
    assert.deepEqual(comDinheiro(montarPainelComputador({ periodos, relatorio, estoque }, { dinheiro: true, fmtTs })), DINHEIRO);
  });

  test("menos de dois inventários, ou o relatório de perdas não instalado: sem períodos e sem a coluna do que saiu", () => {
    const poucos = montarPainelComputador({ periodos: { inventarios: [{ id: 1 }], aberto: null, periodos: [] }, relatorio: null, estoque }, { dinheiro: true, fmtTs });
    assert.deepEqual([poucos.periodos, poucos.periodo, poucos.inventariosConcluidos], [[], null, 1]);
    assert.ok(poucos.estoque.every((e) => e.saiu === null));
    assert.equal(poucos.estoque.length, 5, "o estoque aparece normalmente");
    const sem = montarPainelComputador({ periodos: null, relatorio: null, estoque, semPerdas: "O relatório de perdas ainda não foi instalado no banco." }, { dinheiro: true, fmtTs });
    assert.deepEqual([sem.periodos, sem.periodo], [[], null]);
    assert.match(sem.semPerdas, /ainda não foi instalado/);
  });
});

/* ---------- Com banco: a rota dashboard:computador ---------- */
describe("Painel do computador", { skip: SEM_BANCO }, () => {
  let srv, admin, gerente, operador, id, lager;
  const u = {};
  const consulta = async (q) => {
    const { data, error } = await q;
    assert.ifError(error);
    return data;
  };
  const gravar = async (tabela, linha) => (await consulta(banco().from(tabela).insert(linha).select("id").single())).id;
  const painel = (c = admin, extra = {}) => c.ok("dashboard:computador", { unitId: u.centro, ...extra });
  const chope = (d, nome) => d.periodo.chopes.find((c) => c.nome === nome);

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    const unidade = async (nome, nomeCurto, cnpj) => (await admin.ok("units:create", { razaoSocial: `${nome} Bebidas Ltda`, nome, nomeCurto, cnpj, endereco: "Rua Teste, 1, Cuiabá - MT" })).id;
    u.centro = await unidade("Bar do Centro", "Centro", "11.222.333/0001-81");
    u.porto = await unidade("Bar do Porto", "Porto", "11.444.777/0001-61");
    u.praia = await unidade("Bar da Praia", "Praia", "45.723.174/0001-10");
    gerente = await makeUser(srv.base, admin, { nome: "Gina", email: "gina@barrilfacil.test", cargo: "gerente", unidadeIds: [u.centro] });
    operador = await makeUser(srv.base, admin, { nome: "Quiosque Centro", email: "quiosque@barrilfacil.test", cargo: "operador", unidadeIds: [u.centro] });
    const usuario = (await consulta(banco().from("usuarios").select("id").eq("cargo", "admin")))[0].id;
    id = await montar(gravar, { centro: u.centro, porto: u.porto, usuario });
    // Um chope com 3 disponíveis no Centro (ok) e 1 no Porto (que tem um inventário só)
    lager = await gravar("chopes", { nome: "Lager Teste", preco_por_tamanho: false });
    for (const [codigo, unidade] of [["BA5-7301", u.centro], ["BA5-7302", u.centro], ["BA5-7303", u.centro], ["BA5-7304", u.porto]])
      await gravar("barris", { codigo, estilo: "Lager Teste", chope_nome: "Lager Teste", chope_id: lager, tamanho_l: 50, unidade_id: unidade, status: "disponivel", validade: "2026-12-31" });
    // Bar da Praia: 10 inventários concluídos, um por dia (9 períodos)
    id.praia = [];
    for (let d = 1; d <= 10; d++) {
      const dia = `2026-11-${String(d).padStart(2, "0")}`;
      id.praia.push(await gravar("inventarios", { unidade_id: u.praia, iniciado_em: `${dia}T22:00:00-04:00`, concluido_em: `${dia}T22:40:00-04:00`, usuario_id: usuario }));
    }
  });
  after(async () => { if (srv) await srv.stop(); });

  test("períodos: os pares seguidos dos inventários concluídos; ao abrir, o último", async () => {
    const d = await painel();
    assert.equal(d.inventariosConcluidos, 4);
    assert.equal(d.aberto.id, id.E);
    assert.deepEqual(d.periodos.map((p) => [p.inventario_de, p.inventario_ate]), [[id.A, id.B], [id.B, id.C], [id.C, id.D]]);
    assert.deepEqual(d.periodos.map((p) => [p.de, p.ate]), [
      ["2026-10-05 22:40:00", "2026-10-10 22:40:00"], ["2026-10-10 22:40:00", "2026-10-15 22:40:00"], ["2026-10-15 22:40:00", "2026-10-25 22:40:00"],
    ]);
    assert.deepEqual([d.periodo.inventario_de.id, d.periodo.inventario_ate.id], [id.C, id.D]);
    // Os mesmos totais do Relatório de perdas
    for (const p of d.periodos) {
      const rel = await admin.ok("perdas:relatorio", { unitId: u.centro, inventarioDe: p.inventario_de, inventarioAte: p.inventario_ate });
      const { inventario_de, inventario_ate, de, ate, sem_vendas, dias_sem_vendas, ...tot } = p;
      assert.deepEqual(tot, rel.total);
    }
  });

  test("limites: o período é escolhido pelo inventário do fim; venda exatamente em tA entra e em tB não", async () => {
    const ab = await painel(admin, { inventarioId: id.B });
    assert.deepEqual([ab.periodo.inventario_de.id, ab.periodo.inventario_ate.id], [id.A, id.B]);
    assert.equal(chope(ab, "Pilsen Teste").vendido, 60, "5 L exatamente em A entram; 4 L exatamente em B, não");
    assert.deepEqual([ab.periodo.total.saiu, ab.periodo.total.vendido, ab.periodo.total.perda, ab.periodo.total.reais], [94, 80, 14, 120.62]);
    const bc = await painel(admin, { inventarioId: id.C });
    assert.equal(chope(bc, "Pilsen Teste").vendido, 13, "os 4 L de B entram no período seguinte");
    // Inventário aberto, de outra unidade, o primeiro (sem anterior) ou que não existe: volta para o último
    for (const outro of [id.E, id.porto, id.A, 99999999, "x"])
      assert.equal((await painel(admin, { inventarioId: outro })).periodo.inventario_ate.id, id.D, `inventarioId ${outro}`);
  });

  test("estoque por chope: situação e ordem (sem estoque, acabando, ok; o que mais saiu no período primeiro)", async () => {
    // Último período (C -> D): IPA saiu 22 L e Pilsen 12 L
    const cd = await painel();
    assert.deepEqual(cd.estoque.map(linhaEstoque), [
      ["Weiss Teste", 1, 0, 3, "sem_estoque"],
      ["IPA Teste", 0, 1, 22, "acabando"], ["Pilsen Teste", 2, 1, 12, "acabando"],
      ["Lager Teste", 0, 3, 0, "ok"],
    ]);
    // A -> B: Pilsen saiu 74 L e IPA 10 L, então a ordem dentro de "acabando" muda
    const ab = await painel(admin, { inventarioId: id.B });
    assert.deepEqual(ab.estoque.map((e) => [e.nome, e.saiu]), [["Weiss Teste", 10], ["Pilsen Teste", 74], ["IPA Teste", 10], ["Lager Teste", 0]]);
    // barris no estoque = disponíveis + engatados; vazios = aguardando recolhimento
    assert.equal(cd.noEstoque, 8);
    assert.equal(cd.vazios, 3);
    // O sino avisa os mesmos chopes
    const avisos = (await admin.ok("alerts:list", { unitId: u.centro })).filter((a) => a.tipo === "sem_estoque" || a.tipo === "acabando");
    assert.deepEqual(avisos.map((a) => a.titulo).sort(), ["IPA Teste", "Pilsen Teste", "Weiss Teste"]);
  });

  test("operador não recebe nenhum valor em R$; gerente e administrador recebem", async () => {
    for (const inventarioId of [id.B, id.C, id.D]) {
      const op = await painel(operador, { inventarioId });
      assert.deepEqual(comDinheiro(op), [], `período até ${inventarioId}`);
      assert.equal(op.dinheiro, false);
    }
    const op = await painel(operador, { inventarioId: id.B });
    assert.equal(op.periodo.total.perda, 14, "litros e % para todos");
    assert.equal(op.periodo.total.pct, 14.8936);
    const ger = await painel(gerente, { inventarioId: id.B });
    assert.equal(ger.dinheiro, true);
    assert.equal(ger.periodo.total.reais, 120.62);
    assert.equal(ger.periodos[0].reais, 120.62);
    await operador.fail("dashboard:computador", { unitId: u.porto }, /Você não tem acesso a esta unidade/);
  });

  test("período sem vendas importadas: sem perda, mas com o que saiu dos barris", async () => {
    const cd = await painel();
    assert.equal(cd.periodo.sem_vendas, true);
    assert.deepEqual([cd.periodo.total.vendido, cd.periodo.total.perda, cd.periodo.total.pct, cd.periodo.total.reais], [null, null, null, null]);
    assert.equal(cd.periodo.total.saiu, 37);
    assert.equal(cd.periodos[2].sem_vendas, true);
    assert.equal(cd.periodos[2].perda, null);
  });

  test("chope sem preço aparece em \"Fora da conta\"", async () => {
    const ab = await painel(admin, { inventarioId: id.B });
    assert.deepEqual(ab.periodo.total.sem_preco, ["Weiss Teste"]);
    assert.deepEqual(ab.periodos[0].sem_preco, ["Weiss Teste"]);
    assert.equal(chope(ab, "Weiss Teste").reais, null);
  });

  test("menos de dois inventários: sem períodos; o estoque e as movimentações aparecem normalmente", async () => {
    const d = await painel(admin, { unitId: u.porto });
    assert.equal(d.inventariosConcluidos, 1);
    assert.deepEqual([d.periodos, d.periodo], [[], null]);
    assert.deepEqual(d.estoque.map(linhaEstoque), [["Lager Teste", 0, 1, null, "acabando"]]);
    assert.ok(d.movimentacoes.length > 0, "as movimentações do Porto (a entrada e a transferência)");
  });

  test("no máximo os 8 últimos períodos", async () => {
    const d = await painel(admin, { unitId: u.praia });
    assert.equal(d.inventariosConcluidos, 10);
    assert.deepEqual(d.periodos.map((p) => p.inventario_ate), id.praia.slice(2), "os 8 mais novos, do mais velho para o mais novo");
    assert.equal(d.periodo.inventario_ate.id, id.praia[9]);
    // O período que saiu da lista volta para o último
    assert.equal((await painel(admin, { unitId: u.praia, inventarioId: id.praia[1] })).periodo.inventario_ate.id, id.praia[9]);
    assert.equal((await painel(admin, { unitId: u.praia, inventarioId: id.praia[2] })).periodo.inventario_ate.id, id.praia[2]);
  });

  test("movimentações sem pesagens e o aviso de funcionários, como no Painel do celular (dashboard:get continua igual)", async () => {
    const d = await painel();
    const cel = await admin.ok("dashboard:get", { unitId: u.centro });
    assert.deepEqual(d.movimentacoes, cel.movimentacoes);
    assert.ok(d.movimentacoes.length <= 8 && d.movimentacoes.every((m) => m.operacao !== "pesagem"));
    assert.equal(d.semFuncionarios, "Bar do Centro");
    assert.equal(cel.semFuncionarios, "Bar do Centro");
    assert.equal((await painel(operador)).semFuncionarios, null, "o aviso é só para quem cadastra funcionários");
    assert.deepEqual(Object.keys(cel).sort(), ["movimentacoes", "semFuncionarios", "stats"]);
  });
});
