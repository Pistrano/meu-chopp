/* ==========================================================
   BarrilFacil — testes: vendas importadas da Teknisa (relatório "Vendas Realizadas no Período", XLSX)
   Arquivos inventados em tests/fixtures (vendas-teknisa.js monta e regrava os .xlsx).
   Rodar:  npm test   (precisa do Supabase local; veja "Rodar os testes" no README)
   ========================================================== */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SEM_BANCO, banco, limparBanco, startServer, setupAdmin, makeUser } = require("./helpers");
const teknisa = require("../src/server/teknisa");
const fx = require("./fixtures/vendas-teknisa");

const SEM_PERMISSAO = /Você não tem permissão para esta ação/;
const MSG_RELATORIO = "Este relatório não é aceito. Na Teknisa, exporte 'Vendas Realizadas no Período' em XLSX.";
const fixture = (nome) => fs.readFileSync(path.join(__dirname, "fixtures", nome));
const b64 = (buf) => buf.toString("base64");
const arred = (n, casas = 2) => Math.round(n * 10 ** casas) / 10 ** casas;

const somaDias = (dia, n) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const diaTeknisa = (dia) => dia.split("-").reverse().join("/"); // "2026-11-10" -> "10/11/2026"

/* Teste das funções de leitura (sem banco) */
describe("leitura do relatório da Teknisa", () => {
  test("extrai caixa, número, data e modalidade do campo Venda (pagamento, cliente e vendedor ficam de fora)", () => {
    const v = teknisa.lerVenda("Caixa : 002 | Nr. Ven.: 0000000123 | Dt. Ven.: 11/11/2026 22:18:32 | Cup./N. Fiscal: 000000456 | " +
      "Cli./Cons.: PADRAO | Vend.: OPERADOR EXEMPLO | Valor Repique: 0 | Modalidade: Terminal de Autoatendimento | CARTAO - TEF: R$51,96");
    assert.deepEqual(v, { caixa: "002", nr: "0000000123", dtVenda: "11/11/2026 22:18:32", modalidade: "Terminal de Autoatendimento" });
  });

  test("lê o cabeçalho pelo nome: com as colunas em outra ordem, o resultado é o mesmo", async () => {
    const normal = await teknisa.lerArquivo(fixture("vendas-teknisa-10a11.xlsx"), { tz: "America/Cuiaba" });
    const ordem = [...fx.CABECALHO].reverse();
    const trocado = await teknisa.lerArquivo(await fx.planilha(fx.VENDAS_10A11, { cabecalho: ordem }), { tz: "America/Cuiaba" });
    assert.equal(normal.length, 11); // a linha de totais (sem Unidade e sem Produto) fica de fora
    assert.deepEqual(trocado, normal);
  });

  test("horário: Ab. Comanda; sem ela, Dt. Ven. (no terminal, lida no horário de Brasília)", async () => {
    const itens = await teknisa.lerArquivo(fixture("vendas-teknisa-10a11.xlsx"), { tz: "America/Cuiaba" });
    const venda = (caixa, nr) => itens.find((i) => i.caixa === caixa && i.nr === nr);
    const terminal = venda("002", "0000000123"); // comanda 21:17 em Cuiabá; Dt. Ven. 22:18:32 em Brasília
    assert.equal(terminal.vendidoEm.toISOString(), "2026-11-12T01:17:00.000Z");
    assert.equal(terminal.comanda.toISOString(), "2026-11-12T01:17:00.000Z");
    assert.equal(terminal.dtVenda.toISOString(), "2026-11-12T01:18:32.000Z");
    assert.equal(terminal.dia, "2026-11-11");
    const terminalSemComanda = venda("003", "0000000045"); // 20:30 em Brasília = 19:30 em Cuiabá
    assert.equal(terminalSemComanda.comanda, null);
    assert.equal(terminalSemComanda.vendidoEm.toISOString(), "2026-11-11T23:30:00.000Z");
    const balcaoSemComanda = venda("001", "0000000102"); // 23:10 no horário da loja
    assert.equal(balcaoSemComanda.vendidoEm.toISOString(), "2026-11-11T03:10:00.000Z");
    assert.equal(balcaoSemComanda.dia, "2026-11-10");
    assert.deepEqual(itens.filter((i) => i.nr === "0000000102").map((i) => i.linha), [1, 2, 3, 4]); // posição na venda
  });

  test("sugestões de volume e de chope pelo nome do produto", () => {
    const chopes = [{ id: 1, nome: "Pilsen" }, { id: 2, nome: "German Pilsener" }, { id: 3, nome: "Hop Lager" },
      { id: 4, nome: "Goose Limão" }, { id: 5, nome: "IPA" }, { id: 6, nome: "APA Session" }];
    const s = (nome) => teknisa.sugestaoProduto(teknisa.normalizar(nome), chopes);
    assert.deepEqual(s("CHOPP PILSEN 300 ML UN"), { ignorar: false, volume: 0.36, chopeId: 1, aviso: null, parecidos: [] });
    assert.equal(s("CHOPP X 355 ML UN").volume, 0.36);
    assert.deepEqual(s("CHOPP HOPLAGER 500ML UN"), { ignorar: false, volume: 0.5, chopeId: 3, aviso: null, parecidos: [] });
    assert.deepEqual(s("CHOPP GERMAN 300 ML UN"), { ignorar: false, volume: 0.36, chopeId: 2, aviso: "Nome parecido, confira", parecidos: [2] });
    assert.deepEqual(s("CHOPP GOSE LIMAO 300 ML UN"), { ignorar: false, volume: 0.36, chopeId: 4, aviso: "Nome parecido, confira", parecidos: [4] });
    // Dois parecidos (IPA e APA Session): nenhum escolhido, os dois listados
    assert.deepEqual(s("CHOPP APA 300 ML UN"), { ignorar: false, volume: 0.36, chopeId: null, aviso: null, parecidos: [5, 6] });
    assert.equal(s("CHOPP PILSEN REFIL 1L UN").volume, 1);
    for (const nome of ["CERVEJA LATA 350ML UN", "AGUA MINERAL 500ML UN", "GROWLER PET 1 L UN", "PORCAO BATATA FRITA", "KIT 2 COPOS"])
      assert.equal(s(nome).ignorar, true, nome);
  });
});

describe("vendas da Teknisa", { skip: SEM_BANCO }, () => {
  let srv, admin, gerente, gerentePorto, operador, centro, porto, bairro, hoje;
  const chope = {};
  let impA, impB;

  const consulta = async (q) => { const { data, error } = await q; assert.ifError(error); return data; };
  const itensDb = () => consulta(banco().from("vendas_itens")
    .select("caixa, nr_venda, linha, vendido_em, dt_venda, comanda_aberta_em, modalidade, chope_id, quantidade, volume_l, litros, valor_total, importacao_id, unidade_id")
    .order("id"));
  const ultimaAuditoria = async (acao) =>
    (await consulta(banco().from("auditoria").select("detalhe").eq("acao", acao).order("id", { ascending: false }).limit(1)))[0];
  const ler = (who, buf, extra = {}) => who.ok("vendas:ler", { arquivo: b64(buf), nome: "vendas.xlsx", ...extra });
  // Escolhas da prévia, com ajustes por nome: { "CHOPP APA 300 ML UN": { chopeId: 6 } }
  const escolhas = (previa, ajustes = {}) => previa.produtos.map((p) => ({
    nome: p.nome, chopeId: p.chopeId, volume: p.volume, ignorar: p.ignorar, ...(ajustes[p.nome] || {}),
  }));
  const importar = (who, buf, previa, extra = {}) => who.ok("vendas:importar", {
    arquivo: b64(buf), nome: extra.nome || "vendas.xlsx", de: extra.de || previa.de, ate: extra.ate || previa.ate,
    unidades: extra.unidades || {}, produtos: escolhas(previa, extra.ajustes),
  });

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    const unidade = (razaoSocial, nome, cnpj) => admin.ok("units:create", { razaoSocial, nome, cnpj, endereco: "Av. Exemplo, 100, Centro, Cuiabá - MT" });
    centro = (await unidade("Loja Centro Bebidas Ltda", "Loja Centro", "11.222.333/0001-81")).id;
    porto = (await unidade("Loja Porto Bebidas Ltda", "Loja Porto", "11.444.777/0001-61")).id;
    bairro = (await unidade("Loja Bairro Bebidas Ltda", "Loja Bairro", "45.723.174/0001-10")).id;
    hoje = (await admin.ok("config:get")).hoje;
    gerente = await makeUser(srv.base, admin, { nome: "Gina", email: "gina@barrilfacil.test", cargo: "gerente", unidadeIds: [centro] });
    gerentePorto = await makeUser(srv.base, admin, { nome: "Gustavo", email: "gustavo@barrilfacil.test", cargo: "gerente", unidadeIds: [porto] });
    operador = await makeUser(srv.base, admin, { nome: "Otávio", email: "otavio@barrilfacil.test", cargo: "operador", unidadeIds: [centro] });
    for (const nome of ["Pilsen", "German Pilsener", "Hop Lager", "Goose Limão", "IPA", "APA Session"])
      chope[nome] = (await admin.ok("chopes:create", { nome, custoLitro: "10,00" })).id;
  });
  after(async () => { if (srv) await srv.stop(); });

  test("operador não usa a tela de vendas", async () => {
    await operador.fail("vendas:ler", { arquivo: b64(fixture("vendas-teknisa-10a11.xlsx")), nome: "a.xlsx" }, SEM_PERMISSAO);
    await operador.fail("vendas:importar", { arquivo: b64(fixture("vendas-teknisa-10a11.xlsx")) }, SEM_PERMISSAO);
    await operador.fail("vendas:importacoes", {}, SEM_PERMISSAO);
    await operador.fail("vendas:produtos", {}, SEM_PERMISSAO);
    await operador.fail("vendas:produtoSalvar", { id: 1 }, SEM_PERMISSAO);
  });

  test("outro relatório (ou outro tipo de arquivo) é recusado com a mensagem", async () => {
    const r = await admin.fail("vendas:ler", { arquivo: b64(fixture("outro-relatorio.xlsx")), nome: "outro.xlsx" });
    assert.equal(r.error, MSG_RELATORIO);
    assert.equal((await admin.fail("vendas:ler", { arquivo: b64(Buffer.from("Unidade;Venda;Produto\n")), nome: "a.csv" })).error, MSG_RELATORIO);
    await admin.fail("vendas:ler", {}, /Escolha o arquivo XLSX/);
  });

  test("prévia: período do arquivo, loja sem unidade, conhecidos e sugestões (parecido e dois parecidos)", async () => {
    const previa = await ler(admin, fixture("vendas-teknisa-10a11.xlsx"));
    assert.equal(previa.primeiraVenda, "2026-11-10 19:05:02");
    assert.equal(previa.ultimaVenda, "2026-11-11 21:17:00");
    assert.deepEqual([previa.de, previa.ate], ["2026-11-10", "2026-11-11"]);
    assert.equal(previa.unidades.length, 1);
    const u = previa.unidades[0];
    assert.deepEqual({ codigo: u.codigo, nome: u.nomeTeknisa, unidadeId: u.unidadeId, linhas: u.linhas, valor: u.valor },
      { codigo: "0009", nome: "LOJA EXEMPLO", unidadeId: null, linhas: 11, valor: 294.68 }); // todos os itens do arquivo
    assert.deepEqual(previa.unidadesLivres.map((x) => x.nome), ["Loja Bairro", "Loja Centro", "Loja Porto"]);
    const p = Object.fromEntries(previa.produtos.map((x) => [x.nome, x]));
    assert.equal(previa.produtos.length, 10);
    assert.ok(previa.produtos.every((x) => x.novo));
    assert.deepEqual([p["CHOPP PILSEN 300 ML UN"].chopeId, p["CHOPP PILSEN 300 ML UN"].volume, p["CHOPP PILSEN 300 ML UN"].aviso], [chope.Pilsen, 0.36, null]);
    assert.deepEqual([p["CHOPP GERMAN 300 ML UN"].chopeId, p["CHOPP GERMAN 300 ML UN"].aviso], [chope["German Pilsener"], "Nome parecido, confira"]);
    assert.deepEqual([p["CHOPP HOPLAGER 500ML UN"].chopeId, p["CHOPP HOPLAGER 500ML UN"].volume], [chope["Hop Lager"], 0.5]);
    assert.deepEqual([p["CHOPP GOSE LIMAO 300 ML UN"].chopeId, p["CHOPP GOSE LIMAO 300 ML UN"].aviso], [chope["Goose Limão"], "Nome parecido, confira"]);
    assert.equal(p["CHOPP APA 300 ML UN"].chopeId, null);
    assert.deepEqual(p["CHOPP APA 300 ML UN"].parecidos.sort(), [chope.IPA, chope["APA Session"]].sort());
    assert.equal(p["CHOPP PILSEN REFIL GROWLER 1L UN"].volume, 1);
    for (const nome of ["AGUA MINERAL 500ML UN", "CERVEJA LATA 350ML UN", "GROWLER PET 1 L UN", "PORCAO BATATA FRITA"])
      assert.equal(p[nome].ignorar, true, nome);
    // Nada é gravado na prévia
    assert.equal((await consulta(banco().from("produtos_teknisa").select("id"))).length, 0);
  });

  test("importar: grava o código na unidade, 4 canecas de 300 ML = 1,44 L e ignora cerveja, água e growler", async () => {
    const buf = fixture("vendas-teknisa-10a11.xlsx");
    const previa = await ler(admin, buf, { unidades: { "0009": centro } });
    assert.equal(previa.unidades[0].unidadeId, centro);
    // Sem escolher o chope do APA (dois parecidos), não importa
    await admin.fail("vendas:importar", {
      arquivo: b64(buf), nome: "vendas.xlsx", de: previa.de, ate: previa.ate, unidades: { "0009": centro }, produtos: escolhas(previa),
    }, /Escolha o chope de "CHOPP APA 300 ML UN" ou marque para ignorar/);
    await admin.fail("vendas:importar", {
      arquivo: b64(buf), nome: "vendas.xlsx", de: previa.de, ate: previa.ate, produtos: escolhas(previa, { "CHOPP APA 300 ML UN": { chopeId: chope["APA Session"] } }),
    }, /Escolha a unidade da loja 0009 - LOJA EXEMPLO/);
    const r = await importar(admin, buf, previa, { nome: "vendas-10a11.xlsx", unidades: { "0009": centro }, ajustes: { "CHOPP APA 300 ML UN": { chopeId: chope["APA Session"] } } });
    assert.equal(r.importacoes.length, 1);
    const imp = r.importacoes[0];
    impA = imp.importacaoId;
    assert.deepEqual({ unidade: imp.unidade, linhas: imp.linhas, novas: imp.novas, repetidas: imp.repetidas, litros: arred(imp.litros), valor: arred(imp.valor) },
      { unidade: "Loja Centro", linhas: 7, novas: 7, repetidas: 0, litros: 5.82, valor: 226.68 });

    const itens = await itensDb();
    assert.equal(itens.length, 7);
    const quatro = itens.find((i) => i.caixa === "002" && i.nr_venda === "0000000123");
    assert.deepEqual([Number(quatro.quantidade), Number(quatro.volume_l), Number(quatro.litros)], [4, 0.36, 1.44]);
    assert.equal(quatro.modalidade, "Terminal de Autoatendimento");
    assert.equal(new Date(quatro.vendido_em).toISOString(), "2026-11-12T01:17:00.000Z");
    assert.equal(new Date(quatro.dt_venda).toISOString(), "2026-11-12T01:18:32.000Z");
    assert.equal(new Date(quatro.comanda_aberta_em).toISOString(), "2026-11-12T01:17:00.000Z");
    const semComanda = itens.find((i) => i.caixa === "003");
    assert.equal(semComanda.comanda_aberta_em, null);
    assert.equal(new Date(semComanda.vendido_em).toISOString(), "2026-11-11T23:30:00.000Z");
    assert.deepEqual(itens.filter((i) => i.nr_venda === "0000000102").map((i) => i.linha), [1, 4]); // a lata e o growler ficam de fora

    const codigo = await consulta(banco().from("unidades").select("codigo_teknisa").eq("id", centro).single());
    assert.equal(codigo.codigo_teknisa, "0009");
    const produtos = await consulta(banco().from("produtos_teknisa").select("nome, codigo, chope_id, volume_l, ignorar").order("nome"));
    assert.equal(produtos.length, 10);
    assert.deepEqual(produtos.filter((x) => x.ignorar).map((x) => x.nome),
      ["AGUA MINERAL 500ML UN", "CERVEJA LATA 350ML UN", "GROWLER PET 1 L UN", "PORCAO BATATA FRITA"]);
    assert.equal(produtos.find((x) => x.nome === "CHOPP APA 300 ML UN").chope_id, chope["APA Session"]);
    assert.match((await ultimaAuditoria("vendas_importadas")).detalhe, /^Loja Centro: período 10\/11\/2026 a 11\/11\/2026, 7 itens novos, 5,82 L \(arquivo vendas-10a11\.xlsx\)$/);
    assert.match((await ultimaAuditoria("unidade_codigo_teknisa")).detalhe, /Loja Centro: código no sistema de caixa 0009 \(na importação de vendas\)/);
  });

  test("segunda importação: reaproveita o de-para e não duplica o dia em comum", async () => {
    const buf = fixture("vendas-teknisa-11a12.xlsx");
    const previa = await ler(gerente, buf);
    assert.equal(previa.unidades[0].unidadeId, centro); // a loja já tem o código
    assert.equal(previa.unidades[0].nova, false);
    const p = Object.fromEntries(previa.produtos.map((x) => [x.nome, x]));
    assert.equal(p["CHOPP APA 300 ML UN"].novo, false);
    assert.equal(p["CHOPP APA 300 ML UN"].chopeId, chope["APA Session"]); // a escolha da primeira importação
    assert.equal(p["PORCAO BATATA FRITA"].ignorar, true);
    assert.deepEqual([p["CHOPP HOP LAGER 300 ML UN"].novo, p["CHOPP HOP LAGER 300 ML UN"].chopeId, p["CHOPP HOP LAGER 300 ML UN"].volume],
      [true, chope["Hop Lager"], 0.36]);
    // Repetidos: os 4 itens de chope do dia 11 (a porção nunca foi gravada)
    const grupos = previa.unidades[0].grupos;
    assert.equal(grupos.reduce((s, g) => s + g.nr, 0), 4);
    assert.ok(grupos.filter((g) => g.dia === "2026-11-12").every((g) => g.nr === 0));

    const r = await importar(gerente, buf, previa, { nome: "vendas-11a12.xlsx" });
    const imp = r.importacoes[0];
    impB = imp.importacaoId;
    assert.deepEqual({ linhas: imp.linhas, novas: imp.novas, repetidas: imp.repetidas, litros: arred(imp.litros), valor: arred(imp.valor) },
      { linhas: 6, novas: 2, repetidas: 4, litros: 1.08, valor: 40.97 });
    const itens = await itensDb();
    assert.equal(itens.length, 9);
    assert.equal(new Set(itens.map((i) => `${i.caixa}|${i.nr_venda}|${i.linha}`)).size, 9);
    // O código do produto muda entre relatórios; o de-para é pelo nome
    const pilsen = await consulta(banco().from("produtos_teknisa").select("codigo").eq("nome", "CHOPP PILSEN 300 ML UN").single());
    assert.equal(pilsen.codigo, "9000002999");

    // Importar o mesmo arquivo de novo: nada novo, nenhuma importação criada
    const de_novo = await importar(gerente, buf, await ler(gerente, buf));
    assert.deepEqual([de_novo.importacoes[0].importacaoId, de_novo.importacoes[0].novas, de_novo.importacoes[0].repetidas], [null, 0, 6]);
    assert.equal((await consulta(banco().from("importacoes_vendas").select("id"))).length, 2);
  });

  test("Ver: litros e valor por chope e por dia, com o preço de venda por litro", async () => {
    const r = await admin.ok("vendas:resumo", { id: impA });
    assert.equal(r.unidade, "Loja Centro");
    assert.deepEqual([r.de, r.ate, r.novas, arred(r.litros)], ["2026-11-10", "2026-11-11", 7, 5.82]);
    const porChope = Object.fromEntries(r.chopes.map((c) => [c.nome, [arred(c.litros), arred(c.valor), c.precoLitro]]));
    assert.deepEqual(porChope, {
      Pilsen: [3.16, 117.84, 37.29], "APA Session": [1.08, 41.97, 38.86], "Goose Limão": [0.72, 31.98, 44.42],
      "Hop Lager": [0.5, 19.9, 39.8], "German Pilsener": [0.36, 14.99, 41.64],
    });
    assert.deepEqual(r.dias.map((d) => [d.dia, arred(d.litros), arred(d.valor)]), [["2026-11-10", 2.22, 85.78], ["2026-11-11", 3.6, 140.9]]);
  });

  test("cancelar apaga só os itens daquela importação", async () => {
    await admin.ok("vendas:cancelar", { id: impB });
    const itens = await itensDb();
    assert.equal(itens.length, 7);
    assert.ok(itens.every((i) => i.importacao_id === impA));
    const lista = await admin.ok("vendas:importacoes");
    assert.deepEqual(lista.map((x) => [x.id, x.cancelada]), [[impB, true], [impA, false]]);
    assert.equal(lista[0].canceladaPor, "Eduardo");
    await admin.fail("vendas:cancelar", { id: impB }, /já foi cancelada/);
    assert.match((await ultimaAuditoria("vendas_importacao_cancelada")).detalhe, /^Loja Centro: período 11\/11\/2026 a 12\/11\/2026, 2 itens apagados/);
    // Os itens cancelados voltam como novos numa importação seguinte
    const buf = fixture("vendas-teknisa-11a12.xlsx");
    const r = await importar(admin, buf, await ler(admin, buf));
    assert.deepEqual([r.importacoes[0].novas, r.importacoes[0].repetidas], [2, 4]);
  });

  test("período: só entram os dias de De a Até; um arquivo com duas lojas gera duas importações", async () => {
    const outra = (v, unidade) => ({ ...v, unidade });
    const vendas = [
      ...fx.VENDAS_10A11.map((v) => outra(v, "0011 - LOJA DOIS")),
      outra({ caixa: "001", nr: "0000000900", dt: "11/11/2026 20:00:00", modalidade: fx.BALCAO, comanda: "11/11/2026 19:59:00",
        itens: [["CHOPP PILSEN 300 ML UN", 1, 12.99]] }, "0012 - LOJA TRES"),
    ];
    const buf = await fx.planilha(vendas);
    const previa = await ler(admin, buf, { unidades: { "0011": porto, "0012": bairro } });
    assert.deepEqual(previa.unidades.map((u) => [u.codigo, u.unidadeId, u.nova]), [["0011", porto, true], ["0012", bairro, true]]);
    await admin.fail("vendas:ler", { arquivo: b64(buf), nome: "x.xlsx", unidades: { "0011": porto, "0012": porto } }, /unidades diferentes/);
    await admin.fail("vendas:ler", { arquivo: b64(buf), nome: "x.xlsx", unidades: { "0011": centro } }, /A unidade Loja Centro já tem o código 0009 no sistema de caixa/);
    const r = await importar(admin, buf, previa, { de: "2026-11-11", ate: "2026-11-11", unidades: { "0011": porto, "0012": bairro } });
    const doPorto = r.importacoes.find((x) => x.unidadeId === porto);
    const doBairro = r.importacoes.find((x) => x.unidadeId === bairro);
    assert.deepEqual([doPorto.novas, arred(doPorto.litros)], [4, 3.6]); // só o dia 11
    assert.deepEqual([doBairro.novas, arred(doBairro.litros)], [1, 0.36]);
    const lista = await admin.ok("vendas:importacoes");
    assert.deepEqual([lista[0].de, lista[0].ate], ["2026-11-11", "2026-11-11"]);
    await admin.fail("vendas:importar", { arquivo: b64(buf), de: "2026-11-12", ate: "2026-11-11", produtos: [] }, /De não pode ser depois/);
  });

  test("gerente só vê e importa nas unidades dele", async () => {
    const buf = fixture("vendas-teknisa-10a11.xlsx"); // loja 0009 = Loja Centro
    const previa = await ler(gerentePorto, buf);
    assert.deepEqual([previa.unidades[0].unidadeId, previa.unidades[0].acesso], [centro, false]);
    assert.deepEqual(previa.unidadesLivres, []); // a Loja Porto já tem código
    await gerentePorto.fail("vendas:importar", { arquivo: b64(buf), de: previa.de, ate: previa.ate, produtos: escolhas(previa) },
      /não tem acesso a nenhuma unidade deste arquivo/);
    const lista = await gerentePorto.ok("vendas:importacoes");
    assert.ok(lista.length > 0 && lista.every((x) => x.unidadeId === porto));
    await gerentePorto.fail("vendas:resumo", { id: impA }, /não tem acesso a esta unidade/);
    await gerentePorto.fail("vendas:cancelar", { id: impA }, /não tem acesso a esta unidade/);
  });

  test("aba Produtos: mudar chope ou volume não muda as vendas já importadas", async () => {
    const { produtos, chopes } = await admin.ok("vendas:produtos");
    assert.ok(chopes.some((c) => c.nome === "Pilsen"));
    const pilsen = produtos.find((x) => x.nome === "CHOPP PILSEN 300 ML UN");
    assert.deepEqual([pilsen.chope, pilsen.volume, pilsen.ignorar], ["Pilsen", 0.36, false]);
    assert.deepEqual(await gerente.ok("vendas:produtoSalvar", { id: pilsen.id, chopeId: chope.Pilsen, volume: "0,3", ignorar: false }), { mudou: true });
    assert.deepEqual(await gerente.ok("vendas:produtoSalvar", { id: pilsen.id, chopeId: chope.Pilsen, volume: 0.3, ignorar: false }), { mudou: false });
    await gerente.fail("vendas:produtoSalvar", { id: pilsen.id, chopeId: null, volume: 0.3, ignorar: false }, /Escolha o chope/);
    await gerente.fail("vendas:produtoSalvar", { id: pilsen.id, chopeId: chope.Pilsen, volume: "abc", ignorar: false }, /Volume inválido/);
    assert.match((await ultimaAuditoria("produto_teknisa_editado")).detalhe, /^CHOPP PILSEN 300 ML UN: Pilsen, 0,3 L por item$/);
    const vendidos = (await itensDb()).filter((i) => i.chope_id === chope.Pilsen && i.importacao_id === impA);
    assert.ok(vendidos.length && vendidos.every((i) => Number(i.volume_l) === 0.36 || Number(i.volume_l) === 1));
    // A próxima prévia já vem com o volume novo
    const previa = await ler(admin, fixture("vendas-teknisa-10a11.xlsx"));
    assert.equal(previa.produtos.find((x) => x.nome === "CHOPP PILSEN 300 ML UN").volume, 0.3);
  });

  test("tela Chopes: preço de venda por litro dos últimos 30 dias, só para quem edita", async () => {
    const ontem = diaTeknisa(somaDias(hoje, -1));
    const antigo = diaTeknisa(somaDias(hoje, -40));
    const buf = await fx.planilha([
      { unidade: "0042 - LOJA BAIRRO", caixa: "001", nr: "0000005001", dt: `${ontem} 20:00:00`, modalidade: fx.BALCAO, comanda: `${ontem} 19:50:00`,
        itens: [["CHOPP IPA 300 ML UN", 5, 15]] },
      { unidade: "0042 - LOJA BAIRRO", caixa: "001", nr: "0000004001", dt: `${antigo} 20:00:00`, modalidade: fx.BALCAO, comanda: `${antigo} 19:50:00`,
        itens: [["CHOPP IPA 300 ML UN", 1, 99]] },
    ]);
    // O código da Loja Bairro já é 0012; o admin troca na tela Unidades
    await admin.ok("units:update", { id: bairro, razaoSocial: "Loja Bairro Bebidas Ltda", nome: "Loja Bairro", cnpj: "45.723.174/0001-10",
      endereco: "Av. Exemplo, 100, Centro, Cuiabá - MT", codigoTeknisa: "0042" });
    assert.match((await ultimaAuditoria("unidade_editada")).detalhe, /, código no sistema de caixa 0042$/);
    const previa = await ler(admin, buf);
    assert.equal(previa.unidades[0].unidadeId, bairro);
    await importar(admin, buf, previa, { ajustes: { "CHOPP IPA 300 ML UN": { chopeId: chope.IPA, volume: 0.36, ignorar: false } } });
    const lista = await admin.ok("chopes:list", { todos: true, custos: true });
    const ipa = lista.find((c) => c.nome === "IPA");
    assert.deepEqual(ipa.venda, { litros: 1.8, valor: 75, precoLitro: 41.67 }); // a venda de 40 dias atrás fica de fora
    assert.ok("venda" in lista.find((c) => c.nome === "Hop Lager")); // sem venda nos 30 dias: null
    const doOperador = await operador.ok("chopes:list", { todos: true, custos: true });
    assert.equal("venda" in doOperador[0], false);
  });

  test("Unidades: código no sistema de caixa só com números e letras, sem repetir; o gerente não edita", async () => {
    const dados = { id: porto, razaoSocial: "Loja Porto Bebidas Ltda", nome: "Loja Porto", cnpj: "11.444.777/0001-61", endereco: "Av. Exemplo, 100, Centro, Cuiabá - MT" };
    await admin.fail("units:update", { ...dados, codigoTeknisa: "0009" }, /O código 0009 no sistema de caixa já está na unidade "Loja Centro"/);
    await admin.fail("units:update", { ...dados, codigoTeknisa: "00-11" }, /O código no sistema de caixa tem só números e letras/);
    await admin.ok("units:update", dados); // sem o campo: o código fica
    assert.equal((await admin.ok("units:details", { id: porto })).codigo_teknisa, "0011");
    assert.equal((await admin.ok("units:adminList")).find((u) => u.id === porto).codigo_teknisa, "0011");
    await gerente.fail("units:update", { ...dados, codigoTeknisa: "0077" }, SEM_PERMISSAO);
  });

  test("chope com venda importada não é apagado", async () => {
    await admin.fail("chopes:delete", { id: chope["German Pilsener"] }, /item\(ns\) de venda importado\(s\) da Teknisa e não pode ser apagado/);
  });

  test("arquivo grande (mais de 64 KB) passa pelo limite do pedido", async () => {
    const vendas = Array.from({ length: 1500 }, (_, i) => ({
      unidade: "0042 - LOJA BAIRRO", caixa: "001", nr: String(7000000 + i).padStart(10, "0"), dt: "05/11/2026 20:00:00",
      modalidade: fx.BALCAO, comanda: "05/11/2026 19:00:00", itens: [["CHOPP PILSEN 300 ML UN", 1, 12.99], ["AGUA MINERAL 500ML UN", 1, 5]],
    }));
    const buf = await fx.planilha(vendas);
    assert.ok(b64(buf).length > 64 * 1024);
    const previa = await ler(admin, buf);
    assert.equal(previa.unidades[0].linhas, 3000);
    const r = await importar(admin, buf, previa);
    assert.equal(r.importacoes[0].novas, 1500);
  });
});
