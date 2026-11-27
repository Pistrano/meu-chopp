/* ==========================================================
   BarrilFacil — testes: relatório de perdas (saiu dos barris × vendido no caixa, entre dois inventários)
   O cenário inventado, com a conta de cabeça, está em tests/fixtures/perdas-cenario.js.
   Rodar:  npm test   (a parte com banco precisa do Supabase local; veja "Rodar os testes" no README)
   ========================================================== */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SEM_BANCO, banco, limparBanco, startServer, setupAdmin, makeUser } = require("./helpers");
const { montar } = require("./fixtures/perdas-cenario");
const perdas = require("../src/server/perdas");

const SEM_PERMISSAO = /Você não tem permissão para esta ação/;
const DINHEIRO = ["custo_litro", "reais", "sem_preco"];
const csvLinhas = (csv) => csv.replace(/^﻿/, "").split("\r\n").map((l) => (l ? l.slice(1, -1).split('";"') : []));
// Todas as chaves de um objeto, em qualquer profundidade
const chaves = (o, acc = new Set()) => {
  if (Array.isArray(o)) o.forEach((x) => chaves(x, acc));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { acc.add(k); chaves(v, acc); }
  return acc;
};
const semDinheiro = (o) => DINHEIRO.filter((k) => chaves(o).has(k));

/* ---------- Sem banco: o que o servidor faz com a resposta do banco ---------- */
describe("relatório de perdas: montagem e CSV", () => {
  const fmtTs = (t) => (t ? String(t).replace("T", " ").slice(0, 19) : "");
  const doBanco = {
    unidade: { id: 7, nome: "=Bar do Centro" },
    inventario_de: { id: 1, iniciado_em: "2026-10-05T22:00:00", concluido_em: "2026-10-05T22:40:00" },
    inventario_ate: { id: 2, iniciado_em: "2026-10-10T22:00:00", concluido_em: "2026-10-10T22:40:00" },
    de: "2026-10-05T22:40:00", ate: "2026-10-10T22:40:00",
    sem_vendas: false, dias_sem_vendas: ["2026-10-08", "2026-10-07"],
    total: { saiu: "20", vendido: "22", perda: "-2", pct: "-10", reais: "-40", estimado: true, sem_preco: ["Weiss Teste"] },
    chopes: [
      { chope_id: 1, nome: "IPA Teste", saiu: "10", vendido: "12", perda: "-2", pct: "-20", custo_litro: "20", reais: "-40", estimado: true, sem_preco: false,
        barris: [{ barril_id: 9, codigo: "BA3-7101", tamanho_l: 30, inicio: "15", inicio_estimado: true, chegou: false, recebido: null, enviado: null,
          fim: "5", fim_estimado: false, acabou: false, saiu: "10", custo_litro: "20" }] },
      { chope_id: 2, nome: "Weiss Teste", saiu: "10", vendido: "10", perda: "0", pct: "0", custo_litro: null, reais: null, estimado: false, sem_preco: true, barris: [] },
    ],
  };

  test("dias sem vendas em texto, com os dias seguidos juntos", () => {
    assert.equal(perdas.textoDias([]), "");
    assert.equal(perdas.textoDias(["2026-11-12"]), "12/11");
    assert.equal(perdas.textoDias(["2026-11-13", "2026-11-12"]), "12/11 e 13/11");
    assert.equal(perdas.textoDias(["2026-10-13", "2026-10-15"]), "13/10 e 15/10");
    assert.equal(perdas.textoDias(["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-16"]), "12/11 a 14/11 e 16/11");
    assert.equal(perdas.textoDias(["2026-10-31", "2026-11-01", "2026-11-03", "2026-11-05"]), "31/10, 01/11, 03/11 e 05/11");
  });

  test("sem \"catalogo:editar\", custo do litro, R$ e \"sem preço\" não saem do servidor", () => {
    const op = perdas.montarRelatorio(doBanco, { dinheiro: false, fmtTs });
    assert.deepEqual(semDinheiro(op), []);
    assert.equal(op.dinheiro, false);
    assert.equal(op.total.perda, -2);
    assert.equal(op.chopes[0].barris[0].inicio_estimado, true);
    const per = perdas.montarPeriodos({ inventarios: [], aberto: null, periodos: [{ inventario_de: 1, inventario_ate: 2, ...doBanco.total }] }, { dinheiro: false, fmtTs });
    assert.deepEqual(semDinheiro(per), []);

    const adm = perdas.montarRelatorio(doBanco, { dinheiro: true, fmtTs });
    assert.deepEqual(DINHEIRO.filter((k) => !chaves(adm).has(k)), []);
    assert.equal(adm.chopes[0].reais, -40);
    assert.equal(adm.chopes[1].reais, null);
    assert.equal(adm.chopes[1].sem_preco, true);
    assert.equal(adm.de, "2026-10-05 22:40:00");
    assert.equal(adm.dias_sem_vendas_texto, "07/10 e 08/10");
  });

  test("CSV no formato do Relatório de barris: \";\", vírgula, perda negativa como número e as notas", () => {
    const adm = perdas.csv(perdas.montarRelatorio(doBanco, { dinheiro: true, fmtTs }));
    assert.equal(adm.filename, "relatorio-perdas-bar-do-centro-2026-10-05-a-2026-10-10.csv");
    assert.ok(adm.csv.startsWith("﻿"), "começa com o BOM para o Excel");
    const l = csvLinhas(adm.csv);
    assert.deepEqual(l[0], ["Chope", "Saiu dos barris (L)", "Vendido no caixa (L)", "Perda (L)", "% do que saiu", "Custo do litro (R$)", "Perda (R$)", "Estimado"]);
    assert.deepEqual(l[1], ["IPA Teste", "10,00", "12,00", "-2,00", "-20,0", "20,00", "-40,00", "sim"]);
    assert.deepEqual(l[2], ["Weiss Teste", "10,00", "10,00", "0,00", "0,0", "", "", ""]);
    assert.deepEqual(l[3], ["Total", "20,00", "22,00", "-2,00", "-10,0", "", "-40,00", "sim"]);
    assert.deepEqual(l[5], ["Período", "De 05/10/2026 22:40 até 10/10/2026 22:40"]);
    assert.deepEqual(l[6], ["Unidade", "'=Bar do Centro"], "texto começando com = leva o apóstrofo");
    const texto = adm.csv;
    assert.match(texto, /Faltam as vendas de 07\/10 e 08\/10: a perda aparece maior do que é\./);
    assert.match(texto, /Fora da conta \(sem preço\): Weiss Teste/);
    assert.match(texto, /Estimado: algum barril aberto/);

    const op = csvLinhas(perdas.csv(perdas.montarRelatorio(doBanco, { dinheiro: false, fmtTs })).csv);
    assert.deepEqual(op[0], ["Chope", "Saiu dos barris (L)", "Vendido no caixa (L)", "Perda (L)", "% do que saiu", "Estimado"]);
    assert.ok(!op.flat().some((c) => /R\$|Fora da conta/.test(c)), "sem dinheiro no CSV de quem não vê dinheiro");

    const sv = perdas.csv(perdas.montarRelatorio({ ...doBanco, sem_vendas: true, total: { saiu: 20 }, chopes: [] }, { dinheiro: true, fmtTs })).csv;
    assert.match(sv, /Faltam as vendas deste período: a perda não foi calculada/);
    assert.doesNotMatch(sv, /Faltam as vendas de 07/);
  });
});

/* ---------- Com banco: a conta do banco e as rotas ---------- */
describe("relatório de perdas", { skip: SEM_BANCO }, () => {
  let srv, admin, gerente, operador, id;
  const u = {};

  const consulta = async (q) => {
    const { data, error } = await q;
    assert.ifError(error);
    return data;
  };
  const gravar = async (tabela, linha) => (await consulta(banco().from(tabela).insert(linha).select("id").single())).id;
  const relatorio = (de, ate, c = admin, unitId = u.centro) => c.ok("perdas:relatorio", { unitId, inventarioDe: id[de], inventarioAte: id[ate] });
  const chope = (rel, nome) => rel.chopes.find((c) => c.nome === nome);
  const barril = (c, codigo) => c.barris.find((b) => b.codigo === codigo);

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    u.centro = (await admin.ok("units:create", { razaoSocial: "Bar do Centro Bebidas Ltda", nome: "Bar do Centro", nomeCurto: "Centro", cnpj: "11.222.333/0001-81", endereco: "Av. Brasil, 100, Centro, Cuiabá - MT" })).id;
    u.porto = (await admin.ok("units:create", { razaoSocial: "Bar do Porto Bebidas Ltda", nome: "Bar do Porto", nomeCurto: "Porto", cnpj: "11.444.777/0001-61", endereco: "Rua do Porto, 200, Cuiabá - MT" })).id;
    gerente = await makeUser(srv.base, admin, { nome: "Gina", email: "gina@barrilfacil.test", cargo: "gerente", unidadeIds: [u.centro] });
    operador = await makeUser(srv.base, admin, { nome: "Quiosque Centro", email: "quiosque@barrilfacil.test", cargo: "operador", unidadeIds: [u.centro] });
    const usuario = (await consulta(banco().from("usuarios").select("id").eq("cargo", "admin")))[0].id;
    id = await montar(gravar, { centro: u.centro, porto: u.porto, usuario });
  });
  after(async () => { if (srv) await srv.stop(); });

  test("A → B: saiu, vendido, perda, % e R$ por chope e no total", async () => {
    const r = await relatorio("A", "B");
    assert.equal(r.unidade.nome, "Bar do Centro");
    assert.equal(r.de, "2026-10-05 22:40:00");
    assert.equal(r.ate, "2026-10-10 22:40:00");
    assert.equal(r.dinheiro, true);
    assert.deepEqual(r.chopes.map((c) => c.nome), ["Pilsen Teste", "IPA Teste", "Weiss Teste"], "quem saiu mais vem primeiro");
    const linha = (c) => ({ saiu: c.saiu, vendido: c.vendido, perda: c.perda, pct: c.pct, custo_litro: c.custo_litro, reais: c.reais, estimado: c.estimado, sem_preco: c.sem_preco });
    assert.deepEqual(linha(chope(r, "Pilsen Teste")), { saiu: 74, vendido: 60, perda: 14, pct: 18.9189, custo_litro: 11.473, reais: 160.62, estimado: false, sem_preco: false });
    assert.deepEqual(linha(chope(r, "IPA Teste")), { saiu: 10, vendido: 12, perda: -2, pct: -20, custo_litro: 20, reais: -40, estimado: true, sem_preco: false });
    assert.deepEqual(linha(chope(r, "Weiss Teste")), { saiu: 10, vendido: 8, perda: 2, pct: 20, custo_litro: null, reais: null, estimado: false, sem_preco: true });
    assert.deepEqual(r.total, { saiu: 94, vendido: 80, perda: 14, pct: 14.8936, estimado: true, reais: 120.62, sem_preco: ["Weiss Teste"] });
    assert.equal(r.sem_vendas, false);
    assert.deepEqual(r.dias_sem_vendas, []);
  });

  test("barril por barril: no início, chegou, recebido, enviado, no fim e acabou", async () => {
    const p = chope(await relatorio("A", "B"), "Pilsen Teste");
    const ver = (codigo) => {
      const b = barril(p, codigo);
      assert.ok(b, `${codigo} deveria estar na lista`);
      return { inicio: b.inicio, chegou: b.chegou, recebido: b.recebido, enviado: b.enviado, fim: b.fim, acabou: b.acabou, saiu: b.saiu };
    };
    // aberto, pesado na balança nos dois inventários
    assert.deepEqual(ver("BA5-7001"), { inicio: 30, chegou: false, recebido: null, enviado: null, fim: 10, acabou: false, saiu: 20 });
    // acabou no período
    assert.deepEqual(ver("BA3-7002"), { inicio: 12, chegou: false, recebido: null, enviado: null, fim: null, acabou: true, saiu: 12 });
    // chegou cheio (50 L) e ficou pela metade
    assert.deepEqual(ver("BA5-7003"), { inicio: null, chegou: true, recebido: null, enviado: null, fim: 25, acabou: false, saiu: 25 });
    // enviado ao Porto com o nível da retirada (8 L)
    assert.deepEqual(ver("BA2-7005"), { inicio: 15, chegou: false, recebido: null, enviado: 8, fim: null, acabou: false, saiu: 7 });
    assert.equal(barril(p, "BA2-7005").enviado_para, "Bar do Porto");
    // recebido do Porto com o nível da pesagem de lá (16 L)
    assert.deepEqual(ver("BA2-7006"), { inicio: null, chegou: false, recebido: 16, enviado: null, fim: 6, acabou: false, saiu: 10 });
    assert.equal(barril(p, "BA2-7006").recebido_de, "Bar do Porto");
    assert.equal(barril(p, "BA2-7006").custo_litro, 15, "custo do litro pelo tamanho do barril");
    // cheio fechado nos dois (100%) e transferência cancelada: não saiu nada e não aparece
    assert.equal(barril(p, "BA5-7004"), undefined);
    assert.equal(p.barris.reduce((s, b) => s + b.saiu, 0), p.saiu, "a soma dos barris é o total do chope");
  });

  test("venda exatamente em tA entra e em tB não entra; barril que chegou exatamente em tB entra", async () => {
    // 5 L exatamente em A entram; 4 L exatamente em B ficam para o período seguinte
    assert.equal(chope(await relatorio("A", "B"), "Pilsen Teste").vendido, 60);
    const bc = await relatorio("B", "C");
    assert.equal(chope(bc, "Pilsen Teste").vendido, 13);
    // BA3-7102 chegou exatamente em B: conta como "chegou" em A → B (sem ele o IPA sairia -20) e não chega de novo em B → C
    const ab = await relatorio("A", "B");
    assert.equal(chope(ab, "IPA Teste").saiu, 10);
    assert.equal(barril(chope(ab, "IPA Teste"), "BA3-7102"), undefined, "cheio no fim: não saiu nada");
    const b = barril(chope(bc, "IPA Teste"), "BA3-7102");
    assert.deepEqual({ inicio: b.inicio, chegou: b.chegou, fim: b.fim, saiu: b.saiu }, { inicio: 30, chegou: false, fim: 22, saiu: 8 });
  });

  test("estimado: só barril aberto medido a olho; o cheio de 100% não marca", async () => {
    const ab = await relatorio("A", "B");
    assert.equal(chope(ab, "Pilsen Teste").estimado, false, "BA5-7004 cheio (100%) nos dois inventários");
    assert.equal(chope(ab, "IPA Teste").estimado, true, "BA3-7101 em 50% no inventário A");
    assert.equal(barril(chope(ab, "IPA Teste"), "BA3-7101").inicio_estimado, true);
    assert.equal(barril(chope(ab, "IPA Teste"), "BA3-7101").fim_estimado, false);
    const bc = await relatorio("B", "C");
    assert.equal(bc.total.estimado, false, "BA3-7102 cheio (100%) no inventário B");
    assert.equal(barril(chope(bc, "IPA Teste"), "BA3-7102").inicio_estimado, false);
  });

  test("perda negativa volta negativa (no relatório e no CSV)", async () => {
    const ipa = chope(await relatorio("A", "B"), "IPA Teste");
    assert.equal(ipa.perda, -2);
    assert.equal(ipa.pct, -20);
    assert.equal(ipa.reais, -40);
    const { csv } = await admin.ok("perdas:csv", { unitId: u.centro, inventarioDe: id.A, inventarioAte: id.B });
    assert.deepEqual(csvLinhas(csv).find((l) => l[0] === "IPA Teste"), ["IPA Teste", "10,00", "12,00", "-2,00", "-20,0", "20,00", "-40,00", "sim"]);
  });

  test("período sem vendas, dias sem importação e importação cancelada", async () => {
    // C → D: nenhuma importação cobre esses dias
    const cd = await relatorio("C", "D");
    assert.equal(cd.sem_vendas, true);
    assert.deepEqual([cd.total.vendido, cd.total.perda, cd.total.pct, cd.total.reais], [null, null, null, null]);
    assert.ok(cd.total.saiu > 0, "o que saiu dos barris continua aparecendo");
    assert.ok(cd.chopes.every((c) => c.vendido === null && c.perda === null && c.reais === null));
    // B → C: a importação 1 vai até 12/10 e a 3 só tem 14/10
    const bc = await relatorio("B", "C");
    assert.equal(bc.sem_vendas, false);
    assert.deepEqual(bc.dias_sem_vendas, ["2026-10-13", "2026-10-15"]);
    assert.equal(bc.dias_sem_vendas_texto, "13/10 e 15/10");
    // A → B: os 100 L da importação cancelada não contam (seriam 160)
    const ab = await relatorio("A", "B");
    assert.deepEqual(ab.dias_sem_vendas, []);
    assert.equal(chope(ab, "Pilsen Teste").vendido, 60);
  });

  test("chope sem preço: R$ vazio e o nome em \"fora da conta\"", async () => {
    const ab = await relatorio("A", "B");
    const w = chope(ab, "Weiss Teste");
    assert.equal(w.reais, null);
    assert.equal(w.custo_litro, null);
    assert.equal(w.sem_preco, true);
    assert.deepEqual(ab.total.sem_preco, ["Weiss Teste"]);
    assert.equal(ab.total.reais, 120.62, "o total em R$ fica só com os chopes com preço (160,62 - 40,00)");
    const { csv } = await admin.ok("perdas:csv", { unitId: u.centro, inventarioDe: id.A, inventarioAte: id.B });
    assert.deepEqual(csvLinhas(csv).find((l) => l[0] === "Weiss Teste"), ["Weiss Teste", "10,00", "8,00", "2,00", "20,0", "", "", ""]);
    assert.match(csv, /Fora da conta \(sem preço\): Weiss Teste/);
  });

  test("operador vê litros e %, sem custo nem R$; o gerente vê o dinheiro; CSV só para o administrador", async () => {
    const adm = await relatorio("A", "B");
    const op = await relatorio("A", "B", operador);
    assert.deepEqual(semDinheiro(op), [], "nenhum campo de dinheiro sai do servidor para o operador");
    assert.equal(op.dinheiro, false);
    assert.deepEqual(op.chopes.map((c) => [c.nome, c.saiu, c.vendido, c.perda, c.pct]), adm.chopes.map((c) => [c.nome, c.saiu, c.vendido, c.perda, c.pct]));
    assert.deepEqual(semDinheiro(await operador.ok("perdas:periodos", { unitId: u.centro })), []);

    const ger = await relatorio("A", "B", gerente);
    assert.equal(ger.dinheiro, true);
    assert.equal(ger.total.reais, 120.62);

    const exportacoes = async () => consulta(banco().from("auditoria").select("detalhe").eq("acao", "relatorio_perdas_exportado").order("id"));
    const antes = (await exportacoes()).length;
    for (const c of [gerente, operador])
      await c.fail("perdas:csv", { unitId: u.centro, inventarioDe: id.A, inventarioAte: id.B }, SEM_PERMISSAO);
    const r = await admin.ok("perdas:csv", { unitId: u.centro, inventarioDe: id.A, inventarioAte: id.B });
    assert.equal(r.filename, "relatorio-perdas-bar-do-centro-2026-10-05-a-2026-10-10.csv");
    const l = csvLinhas(r.csv);
    assert.deepEqual(l[0], ["Chope", "Saiu dos barris (L)", "Vendido no caixa (L)", "Perda (L)", "% do que saiu", "Custo do litro (R$)", "Perda (R$)", "Estimado"]);
    assert.deepEqual(l[1], ["Pilsen Teste", "74,00", "60,00", "14,00", "18,9", "11,47", "160,62", ""]);
    assert.deepEqual(l.find((x) => x[0] === "Total"), ["Total", "94,00", "80,00", "14,00", "14,9", "", "120,62", "sim"]);
    const aud = await exportacoes();
    assert.equal(aud.length, antes + 1, "só a exportação do administrador fica na auditoria");
    assert.equal(aud[aud.length - 1].detalhe, "Bar do Centro, de 05/10 22:40 até 10/10 22:40");

    // a unidade de quem pede é respeitada
    await operador.fail("perdas:periodos", { unitId: u.porto }, /Você não tem acesso a esta unidade/);
    await operador.fail("perdas:relatorio", { unitId: u.porto, inventarioDe: id.A, inventarioAte: id.B }, /Você não tem acesso a esta unidade/);
  });

  test("inventário aberto, de outra unidade ou fim antes do início são recusados", async () => {
    const pedir = (de, ate) => admin.fail("perdas:relatorio", { unitId: u.centro, inventarioDe: de, inventarioAte: ate });
    assert.match((await pedir(id.D, id.E)).error, /Só entra no relatório inventário concluído/);
    assert.match((await pedir(id.A, id.porto)).error, /O inventário escolhido não é desta unidade/);
    assert.match((await pedir(id.B, id.A)).error, /O inventário do fim tem de ser depois do inventário do início/);
    assert.match((await pedir(id.A, id.A)).error, /O inventário do fim tem de ser depois do inventário do início/);
    assert.match((await pedir(id.A, 99999999)).error, /Inventário não encontrado/);
    assert.match((await pedir(id.A, "")).error, /Escolha o inventário do início e o do fim/);
  });

  test("perdas:periodos: inventários concluídos, o aberto e os pares seguidos com os mesmos totais", async () => {
    const r = await admin.ok("perdas:periodos", { unitId: u.centro });
    assert.deepEqual(r.inventarios.map((i) => i.id), [id.D, id.C, id.B, id.A], "do mais novo para o mais velho, sem o aberto nem o do Porto");
    assert.equal(r.inventarios[0].concluido_em, "2026-10-25 22:40:00");
    assert.equal(r.aberto.id, id.E);
    assert.deepEqual(r.periodos.map((p) => [p.inventario_de, p.inventario_ate]), [[id.C, id.D], [id.B, id.C], [id.A, id.B]]);
    const nomes = { [id.A]: "A", [id.B]: "B", [id.C]: "C", [id.D]: "D" };
    for (const p of r.periodos) {
      const rel = await relatorio(nomes[p.inventario_de], nomes[p.inventario_ate]);
      const { inventario_de, inventario_ate, de, ate, sem_vendas, dias_sem_vendas, ...total } = p;
      assert.deepEqual(total, rel.total, `totais de ${nomes[inventario_de]} → ${nomes[inventario_ate]}`);
      assert.deepEqual([de, ate, sem_vendas, dias_sem_vendas], [rel.de, rel.ate, rel.sem_vendas, rel.dias_sem_vendas]);
    }
    // o período inteiro soma o que saiu em cada pedaço
    const ad = await relatorio("A", "D");
    assert.equal(ad.total.saiu, r.periodos.reduce((s, p) => s + p.saiu, 0));
  });
});
