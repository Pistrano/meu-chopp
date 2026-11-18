/* ==========================================================
   BarrilFacil — testes: chope só com o nome (sem estilo), relatório de barris por chope, CSVs e apagar chope
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
// Primeira linha do CSV (sem o BOM), coluna por coluna
const cabecalho = (csv) => csv.replace(/^﻿/, "").split("\r\n")[0].split(";").map((c) => c.replace(/^"|"$/g, ""));

describe("chope sem estilo, relatório por chope e apagar chope", { skip: SEM_BANCO }, () => {
  let srv, admin, gerente, operador, unidade, hoje;
  const ids = {};

  const consulta = async (q) => { const { data, error } = await q; assert.ifError(error); return data; };
  const barril = async (codigo, chopeId, tamanho = 30) => {
    await admin.ok("barris:create", { codigo, chopeId, tamanho, validade: somaDias(hoje, 5), unitId: unidade });
    return (await admin.ok("barris:list", { unitId: unidade })).find((b) => b.codigo === codigo);
  };
  const engatar = async (b) => {
    const t = (await admin.ok("taps:board", { unitId: unidade })).torneiras.find((x) => !x.ocupada);
    await admin.ok("barris:use", { id: b.id, torneiraId: t.id });
  };
  const ultimaAuditoria = async (acao) =>
    (await consulta(banco().from("auditoria").select("detalhe").eq("acao", acao).order("id", { ascending: false }).limit(1)))[0];
  const periodo = () => ({ de: somaDias(hoje, -1), ate: hoje, unidadeId: unidade });

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    unidade = (await admin.ok("units:create", { razaoSocial: "Loja Centro Bebidas Ltda", nome: "Loja Centro", cnpj: "11.222.333/0001-81", endereco: "Av. Brasil, 100, Centro, Cuiabá - MT" })).id;
    await admin.ok("taps:create", { unitId: unidade, quantidade: 3 });
    hoje = (await admin.ok("config:get")).hoje;
    gerente = await makeUser(srv.base, admin, { nome: "Gina", email: "gina@barrilfacil.test", cargo: "gerente", unidadeIds: [unidade] });
    operador = await makeUser(srv.base, admin, { nome: "Otávio", email: "otavio@barrilfacil.test", cargo: "operador", unidadeIds: [unidade] });
  });
  after(async () => { if (srv) await srv.stop(); });

  test("chope é criado sem estilo, e as rotas de estilo não existem mais", async () => {
    const c = await admin.ok("chopes:create", { nome: "Louvada Pilsen", custoLitro: 12 });
    ids.pilsen = c.id;
    assert.deepEqual(c, { id: c.id, nome: "Louvada Pilsen" });
    const [row] = await consulta(banco().from("chopes").select("nome, estilo_id").eq("id", c.id));
    assert.deepEqual(row, { nome: "Louvada Pilsen", estilo_id: null });
    assert.equal((await ultimaAuditoria("chope_criado")).detalhe, "Louvada Pilsen");
    assert.deepEqual(Object.keys((await admin.ok("chopes:list")).find((x) => x.id === c.id)).sort(), ["ativo", "id", "nome"]);
    for (const canal of ["estilos:list", "estilos:create", "estilos:update", "estilos:toggle", "estilos:delete"])
      await admin.fail(canal, { nome: "Pilsen" }, /Operação desconhecida/);
  });

  test("o barril grava o nome do chope em barris.estilo, e renomear o chope atualiza os barris", async () => {
    ids.ipa = (await admin.ok("chopes:create", { nome: "Louvada IPA", custoLitro: 14 })).id;
    const b = await barril("PL1", ids.pilsen);
    assert.equal(b.chope_nome, "Louvada Pilsen");
    assert.equal(b.estilo, "Louvada Pilsen");
    assert.match((await ultimaAuditoria("barril_cadastrado")).detalhe, /^Barril #PL1 \(Louvada Pilsen, 30 L, validade \d\d\/\d\d\/\d{4}\)$/);
    await gerente.ok("chopes:update", { id: ids.pilsen, nome: "Pilsen da Casa" });
    const [row] = await consulta(banco().from("barris").select("chope_nome, estilo").eq("codigo", "PL1"));
    assert.deepEqual(row, { chope_nome: "Pilsen da Casa", estilo: "Pilsen da Casa" });
    assert.equal((await ultimaAuditoria("chope_editado")).detalhe, "Louvada Pilsen → Pilsen da Casa");
    await gerente.ok("chopes:update", { id: ids.pilsen, nome: "Louvada Pilsen" });
  });

  test("barril antigo sem chope aparece pelo estilo antigo na lista, na busca e no relatório", async () => {
    // Antes do catálogo: só o texto do estilo, sem chope_id nem chope_nome
    const { error } = await banco().from("barris")
      .insert({ codigo: "ANT1", estilo: "Weiss Antiga", tamanho_l: 50, unidade_id: unidade, validade: somaDias(hoje, 5) });
    assert.ifError(error);
    const lista = await admin.ok("barris:list", { unitId: unidade, q: "weiss" });
    assert.deepEqual(lista.map((b) => b.codigo), ["ANT1"]);
    // A busca é por código ou chope: o estilo gravado no barril do catálogo não entra
    await consulta(banco().from("barris").update({ estilo: "Estilo Velho" }).eq("codigo", "PL1"));
    assert.deepEqual((await admin.ok("barris:list", { unitId: unidade, q: "estilo velho" })).map((b) => b.codigo), []);
    assert.deepEqual((await admin.ok("barris:list", { unitId: unidade, q: "pilsen" })).map((b) => b.codigo), ["PL1"]);
    await consulta(banco().from("barris").update({ estilo: "Louvada Pilsen" }).eq("codigo", "PL1"));

    const ant = (await admin.ok("barris:list", { unitId: unidade })).find((b) => b.codigo === "ANT1");
    await engatar(ant);
    const rel = await admin.ok("reports:barrels", periodo());
    const linha = rel.chopes.find((c) => c.chope === "Weiss Antiga");
    assert.ok(linha, JSON.stringify(rel.chopes));
    assert.equal(linha.utilizados, 1);
    assert.equal(linha.litros, 50);
    const detalhe = await admin.ok("reports:barrelsDetail", { ...periodo(), chope: "Weiss Antiga" });
    assert.deepEqual(detalhe.map((b) => b.codigo), ["ANT1"]);
  });

  test("relatório de barris: uma linha por chope, sem estilo e sem total por estilo, com o total geral", async () => {
    const p2 = await barril("PL2", ids.pilsen);
    await engatar(p2);
    await admin.ok("barris:empty", { id: p2.id });
    await barril("IP1", ids.ipa, 20);
    // Barril antigo com chope_nome igual ao de um chope do catálogo cai na mesma linha
    const { error } = await banco().from("barris")
      .insert({ codigo: "ANT2", estilo: "Pilsen", chope_nome: "louvada pilsen", tamanho_l: 30, unidade_id: unidade, validade: somaDias(hoje, 5) });
    assert.ifError(error);

    const rel = await admin.ok("reports:barrels", periodo());
    assert.equal("grupos" in rel, false);
    assert.deepEqual(rel.chopes.map((c) => c.chope), ["Louvada IPA", "Louvada Pilsen", "Weiss Antiga"]);
    const pilsen = rel.chopes.find((c) => c.chope === "Louvada Pilsen");
    assert.deepEqual(Object.keys(pilsen).sort(),
      ["chope", "em_transferencia", "engatados", "estoque", "esvaziados", "litros", "recebidos", "recolhidos", "utilizados", "vazios"]);
    assert.equal(pilsen.recebidos, 2); // PL1 e PL2 (o ANT2 entrou direto no banco, sem movimentação)
    assert.equal(pilsen.utilizados, 1);
    assert.equal(pilsen.esvaziados, 1);
    assert.equal(pilsen.estoque, 2); // PL1 e ANT2
    assert.equal(pilsen.vazios, 1);
    const soma = (k) => rel.chopes.reduce((s, c) => s + c[k], 0);
    for (const k of ["recebidos", "utilizados", "litros", "esvaziados", "estoque", "engatados", "vazios"]) assert.equal(rel.total[k], soma(k), k);

    const detalhe = await admin.ok("reports:barrelsDetail", { ...periodo(), chope: "Louvada Pilsen" });
    assert.deepEqual(detalhe.map((b) => b.codigo), ["PL2"]);
    await admin.fail("reports:barrelsDetail", { ...periodo(), chope: "" }, /Escolha o chope/);

    const csv = await admin.ok("reports:barrelsExport", periodo());
    assert.deepEqual(cabecalho(csv.csv), ["Chope", "Recebidos", "Utilizados", "Litros utilizados", "Esvaziados", "Recolhidos",
      "Em estoque agora", "Engatados agora", "Vazios aguardando recolhimento", "Em transferência agora"]);
    const linhas = csv.csv.split("\r\n");
    assert.ok(linhas.some((l) => l.startsWith('"Louvada Pilsen";"2";"1"')), csv.csv);
    assert.ok(linhas.some((l) => l.startsWith('"Total geral";')), csv.csv);
    assert.equal(linhas.some((l) => /Total Louvada|Estilo/.test(l)), false, csv.csv);
    assert.ok(linhas.includes('"Chope";"Barril";"Tamanho (L)";"Validade";"Engatado em";"Retirado em";"Torneira";"Unidade";"Funcionário (engate)";"Funcionário (retirada)"'), csv.csv);
    assert.equal(csv.total, 3);
  });

  test("CSV do estoque e do histórico sem a coluna Estilo", async () => {
    const estoque = await admin.ok("barris:exportStock", { unitId: unidade });
    assert.deepEqual(cabecalho(estoque.csv), ["Barril", "Chope", "Tamanho (L)", "Situação", "Validade", "Unidade", "Torneira", "Funcionário"]);
    const linhas = estoque.csv.split("\r\n");
    assert.ok(linhas.some((l) => l.startsWith('"#PL1";"Louvada Pilsen";"30"')), estoque.csv);
    assert.ok(linhas.some((l) => l.startsWith('"#ANT1";"Weiss Antiga";"50"')), estoque.csv);

    const hist = await admin.ok("history:export", { unitId: unidade });
    assert.deepEqual(cabecalho(hist.csv),
      ["Data/Hora", "Barril", "Chope", "Operação", "Origem", "Destino", "Torneira", "Responsável", "Funcionário", "Observação"]);
    assert.ok(hist.csv.split("\r\n").some((l) => /^"[^"]+";"#ANT1";"Weiss Antiga";"Utilização"/.test(l)), hist.csv);
  });

  test("chope com barril não é apagado; chope sem barril é, com os preços dele", async () => {
    const r = await admin.fail("chopes:delete", { id: ids.pilsen });
    assert.match(r.error, /O chope "Louvada Pilsen" é usado por 2 barril\(is\) e não pode ser apagado\. Desative o chope/);
    assert.equal((await consulta(banco().from("chopes").select("id").eq("id", ids.pilsen))).length, 1);

    const errado = await admin.ok("chopes:create", { nome: "Chop Pilsen", custoLitro: 10 }); // digitado errado, sem barris
    assert.equal((await consulta(banco().from("custos_chope").select("id").eq("chope_id", errado.id))).length, 1);
    await gerente.ok("chopes:delete", { id: errado.id });
    assert.equal((await consulta(banco().from("chopes").select("id").eq("id", errado.id))).length, 0);
    assert.equal((await consulta(banco().from("custos_chope").select("id").eq("chope_id", errado.id))).length, 0);
    assert.equal((await ultimaAuditoria("chope_apagado")).detalhe, "Chop Pilsen");
    await admin.fail("chopes:delete", { id: errado.id }, /Chope não encontrado/);
  });

  test("operador não apaga nem edita chope (o servidor recusa)", async () => {
    const hop = await admin.ok("chopes:create", { nome: "Hop IPA", custoLitro: 15 });
    await operador.fail("chopes:delete", { id: hop.id }, SEM_PERMISSAO);
    await operador.fail("chopes:update", { id: hop.id, nome: "Outro" }, SEM_PERMISSAO);
    await operador.fail("chopes:toggle", { id: hop.id }, SEM_PERMISSAO);
    assert.equal((await consulta(banco().from("chopes").select("id").eq("id", hop.id))).length, 1);
  });
});
