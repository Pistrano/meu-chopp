/* ==========================================================
   BarrilFacil — testes: pesagem dos barris (cálculo de perdas, parte 1)
   Retirada com chope (balança ou estimativa), saldo do barril, litros no engate, taras e inventário.
   Rodar:  npm test   (precisa do Supabase local; veja "Rodar os testes" no README)
   ========================================================== */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SEM_BANCO, banco, limparBanco, startServer, setupAdmin, makeUser } = require("./helpers");

const SEM_PERMISSAO = /Você não tem permissão para esta ação/;
const ESCOLHA = /Escolha quem está fazendo antes de salvar/;
const DENSIDADE = 1.01;
const litrosDe = (bruto, tara) => Math.round(((bruto - tara) / DENSIDADE) * 100) / 100;

const somaDias = (dia, n) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const csvLinhas = (csv) => csv.replace(/^﻿/, "").split("\r\n").map((l) => (l ? l.slice(1, -1).split('";"') : []));

describe("pesagem dos barris", { skip: SEM_BANCO }, () => {
  let srv, admin, gerente, quiosque, chope, validade;
  const u = {};
  const f = {};

  const consulta = async (q) => {
    const { data, error } = await q;
    assert.ifError(error);
    return data;
  };
  const barrilDb = async (id) => (await consulta(banco().from("barris").select("*").eq("id", id)))[0];
  const engatesDe = async (id) => consulta(banco().from("engates").select("*").eq("barril_id", id).order("id"));
  const pesagensDe = async (id) => consulta(banco().from("pesagens").select("*").eq("barril_id", id).order("id"));
  const movsDe = async (id) => consulta(banco().from("movimentacoes").select("operacao, observacao, pesagem_id, torneira_numero, funcionario_id").eq("barril_id", id).order("id"));
  const ultimaAuditoria = async (acao) => (await consulta(banco().from("auditoria").select("detalhe").eq("acao", acao).order("id", { ascending: false }).limit(1)))[0];
  const torneiraLivre = async (c, unitId) => (await c.ok("taps:board", { unitId })).torneiras.find((t) => !t.ocupada);
  const novoBarril = async (codigo, tamanho = 50, c = admin, unitId = u.centro, extra = {}) =>
    (await c.ok("barris:create", { codigo, chopeId: chope, tamanho, validade, unitId, ...extra })).id;
  const engatar = async (id, c = admin, unitId = u.centro, extra = {}) => {
    const tap = await torneiraLivre(c, unitId);
    await c.ok("barris:use", { id, torneiraId: tap.id, unitId, ...extra });
    return tap;
  };
  const naLista = async (id, unitId = u.centro) => (await admin.ok("barris:list", { unitId })).find((b) => b.id === id);

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    u.centro = (await admin.ok("units:create", { razaoSocial: "Bar do Centro Bebidas Ltda", nome: "Bar do Centro", nomeCurto: "Centro", cnpj: "11.222.333/0001-81", endereco: "Av. Brasil, 100, Centro, Cuiabá - MT" })).id;
    u.porto = (await admin.ok("units:create", { razaoSocial: "Bar do Porto Bebidas Ltda", nome: "Bar do Porto", nomeCurto: "Porto", cnpj: "11.444.777/0001-61", endereco: "Rua do Porto, 200, Cuiabá - MT" })).id;
    await admin.ok("taps:create", { unitId: u.centro, quantidade: 6 });
    await admin.ok("taps:create", { unitId: u.porto, quantidade: 2 });
    chope = (await admin.ok("chopes:create", { nome: "Chopp Pilsen", custoLitro: 12 })).id;
    validade = somaDias((await admin.ok("config:get")).hoje, 10);
    gerente = await makeUser(srv.base, admin, { nome: "Gina", email: "gina@barrilfacil.test", cargo: "gerente", unidadeIds: [u.centro] });
    quiosque = await makeUser(srv.base, admin, { nome: "Quiosque Centro", email: "quiosque@barrilfacil.test", cargo: "operador", unidadeIds: [u.centro] });
    f.ana = (await admin.ok("funcionarios:create", { nome: "Ana", unidadeIds: [u.centro] })).id;
  });
  after(async () => { if (srv) await srv.stop(); });

  test("a densidade do chope vem na config do servidor", async () => {
    assert.equal((await admin.ok("config:get")).densidade, DENSIDADE);
  });

  test("primeira pesagem sem tara exige a tara, e a tara informada fica salva", async () => {
    const id = await novoBarril("P1");
    await engatar(id);
    const r = await admin.fail("barris:retirarComChope", { id, metodo: "balanca", pesoBruto: "32,4" },
      /Primeira pesagem de barril de 50 L: informe o peso do vasilhame vazio \(kg\)/);
    assert.equal(r.code, undefined);
    // peso menor que a tara nova: nada é gravado, nem a tara
    await admin.fail("barris:retirarComChope", { id, metodo: "balanca", pesoBruto: "12", taraNovaKg: "13,5" }, /menor que a tara.*Confira o peso e a tara/);
    assert.equal((await consulta(banco().from("taras").select("id"))).length, 0, "a tara não fica salva se a pesagem falhou");
    assert.equal((await barrilDb(id)).status, "em_uso");

    const ok = await admin.ok("barris:retirarComChope", { id, metodo: "balanca", pesoBruto: "32,4", taraNovaKg: "13,5" });
    assert.equal(ok.litros, litrosDe(32.4, 13.5));
    const taras = await consulta(banco().from("taras").select("tamanho_l, peso_kg, ativo, descricao"));
    assert.deepEqual(taras, [{ tamanho_l: 50, peso_kg: 13.5, ativo: true, descricao: "Cadastrada na primeira pesagem" }]);
    assert.match((await ultimaAuditoria("tara_cadastrada")).detalhe, /Vasilhame de 50 L: 13,5 kg/);
    // a próxima pesagem de 50 L usa a tara salva (a padrão do tamanho)
    const lista = await quiosque.ok("taras:list");
    assert.equal(lista.length, 1);
    assert.equal(lista[0].padrao, true);
  });

  test("retirada com chope pela balança grava a pesagem, o saldo do barril e os litros do fim do engate", async () => {
    const id = await novoBarril("P2");
    const tap = await engatar(id);
    const tara = (await admin.ok("taras:list")).find((t) => t.tamanho_l === 50);
    const r = await admin.ok("barris:retirarComChope", { id, metodo: "balanca", pesoBruto: 31.9, taraId: tara.id });
    const litros = litrosDe(31.9, 13.5);
    assert.deepEqual(r, { codigo: "P2", unidade: "Bar do Centro", torneira: tap.numero, litros, estimado: false });

    const b = await barrilDb(id);
    assert.deepEqual([b.status, b.saldo_l, b.saldo_estimado], ["disponivel", litros, false]);
    const [e] = await engatesDe(id);
    assert.ok(e.retirado_em, "o engate foi fechado");
    assert.deepEqual([e.litros_inicio, e.inicio_estimado, e.litros_fim, e.fim_estimado], [50, false, litros, false]);
    const [p] = await pesagensDe(id);
    assert.deepEqual(
      [p.motivo, p.metodo, p.peso_bruto_kg, p.tara_id, p.tara_kg, p.densidade, p.nivel_pct, p.litros, p.unidade_id, p.inventario_id],
      ["retirada", "balanca", 31.9, tara.id, 13.5, DENSIDADE, null, litros, u.centro, null]
    );
    // torneira liberada, movimentação "Retirado com chope" e auditoria
    assert.equal((await admin.ok("taps:board", { unitId: u.centro })).torneiras.find((t) => t.id === tap.id).ocupada, false);
    const mov = (await movsDe(id)).at(-1);
    assert.equal(mov.operacao, "retirada_com_chope");
    assert.equal(mov.pesagem_id, p.id);
    assert.equal(mov.observacao, `Retirado da Torneira ${tap.numero} com 18,2 L (pesado) (torneira liberada)`);
    assert.match((await ultimaAuditoria("barril_retirado_com_chope")).detalhe, new RegExp(`Barril #P2 retirado da Torneira ${tap.numero} com 18,2 L \\(pesado\\)`));
    // a lista de barris traz o saldo
    const l = await naLista(id);
    assert.deepEqual([l.status, l.saldo_l, l.saldo_estimado], ["disponivel", litros, false]);
  });

  test("estimativa de 50% grava a metade do tamanho; engatar de novo grava litros_inicio igual ao saldo", async () => {
    const id = await novoBarril("P3", 30);
    await engatar(id);
    await admin.fail("barris:retirarComChope", { id, metodo: "estimativa", nivel: 60 }, /100%, 75%, 50% ou 25%/);
    const r = await admin.ok("barris:retirarComChope", { id, metodo: "estimativa", nivel: 50 });
    assert.deepEqual([r.litros, r.estimado], [15, true]);
    const [p] = await pesagensDe(id);
    assert.deepEqual([p.metodo, p.nivel_pct, p.litros, p.peso_bruto_kg, p.tara_id, p.densidade], ["estimativa", 50, 15, null, null, null]);
    const b = await barrilDb(id);
    assert.deepEqual([b.status, b.saldo_l, b.saldo_estimado], ["disponivel", 15, true]);
    assert.deepEqual((await engatesDe(id)).map((e) => [e.litros_fim, e.fim_estimado]), [[15, true]]);

    // engata de novo em outra torneira: começa com o saldo (estimado)
    const tap = await engatar(id);
    const [, segundo] = await engatesDe(id);
    assert.deepEqual([segundo.litros_inicio, segundo.inicio_estimado, segundo.litros_fim], [15, true, null]);
    assert.equal((await movsDe(id)).at(-1).observacao, `Engatado na Torneira ${tap.numero} com 15 L (estimado)`);

    // e retirado vazio depois: litros_fim 0 e o saldo zera
    await admin.ok("barris:empty", { id });
    const [, fim] = await engatesDe(id);
    assert.deepEqual([fim.litros_fim, fim.fim_estimado], [0, false]);
    const b2 = await barrilDb(id);
    assert.deepEqual([b2.status, b2.saldo_l, b2.saldo_estimado], ["esgotado", 0, false]);
  });

  test("retirada como vazio grava litros_fim 0; o barril cheio começa com o tamanho", async () => {
    const id = await novoBarril("P4", 20);
    await engatar(id);
    const [e] = await engatesDe(id);
    assert.deepEqual([e.litros_inicio, e.inicio_estimado], [20, false]);
    await admin.ok("barris:empty", { id });
    const [fim] = await engatesDe(id);
    assert.deepEqual([fim.litros_fim, fim.fim_estimado], [0, false]);
    assert.equal((await pesagensDe(id)).length, 0, "retirada vazia não grava pesagem");
  });

  test("peso menor que a tara e litros acima do tamanho são recusados; 0,5 L ou menos pede para retirar vazio", async () => {
    const id = await novoBarril("P5");
    await engatar(id);
    await admin.fail("barris:retirarComChope", { id, metodo: "balanca", pesoBruto: 10 }, /O peso informado \(10 kg\) é menor que a tara do vasilhame \(13,5 kg\)\. Confira o peso e a tara\./);
    // 50 L + 5% = 52,5 L; 13,5 + 53 × 1,01 = 67,03 kg
    await admin.fail("barris:retirarComChope", { id, metodo: "balanca", pesoBruto: 67.1 }, /mais do que cabe no barril de 50 L\. Confira o peso e a tara/);
    await admin.fail("barris:retirarComChope", { id, metodo: "balanca", pesoBruto: "" }, /Informe o peso do barril/);
    await admin.fail("barris:retirarComChope", { id, metodo: "outro" }, /balança ou estimar/);
    const quase = await admin.fail("barris:retirarComChope", { id, metodo: "balanca", pesoBruto: "13,9" }, /Retire como vazio/);
    assert.equal(quase.code, "QUASE_VAZIO");
    assert.equal(quase.info.litros, litrosDe(13.9, 13.5));
    // nada foi gravado: continua engatado, sem pesagem
    assert.equal((await barrilDb(id)).status, "em_uso");
    assert.equal((await pesagensDe(id)).length, 0);
    assert.equal((await engatesDe(id))[0].retirado_em, null);
    // tara de outro tamanho é recusada
    const t30 = await admin.ok("taras:create", { tamanho: 30, pesoKg: "10,2" });
    await admin.fail("barris:retirarComChope", { id, metodo: "balanca", pesoBruto: 30, taraId: t30.id }, /tara é de vasilhame de 30 L, e o barril é de 50 L/);
    await admin.ok("barris:empty", { id });
  });

  test("operador sem funcionário é recusado; com funcionário, a pesagem fica no nome dele", async () => {
    const id = await novoBarril("P6", 50, quiosque, u.centro, { funcionarioId: f.ana });
    await engatar(id, quiosque, u.centro, { funcionarioId: f.ana });
    await quiosque.fail("barris:retirarComChope", { id, metodo: "estimativa", nivel: 25 }, ESCOLHA);
    assert.equal((await barrilDb(id)).status, "em_uso");
    await quiosque.ok("barris:retirarComChope", { id, metodo: "estimativa", nivel: 25, funcionarioId: f.ana });
    const [p] = await pesagensDe(id);
    assert.equal(p.funcionario_id, f.ana);
    assert.equal((await movsDe(id)).at(-1).funcionario_id, f.ana);
    await quiosque.fail("pesagens:registrar", { barrilId: id, metodo: "estimativa", nivel: 25 }, ESCOLHA);
  });

  test("taras: qualquer cargo cadastra; editar, desativar e apagar só administrador e gerente; usada não é apagada", async () => {
    const t = await quiosque.ok("taras:create", { tamanho: 20, pesoKg: "8,4", descricao: "Barril inox" });
    await quiosque.fail("taras:create", { tamanho: 25, pesoKg: "8" }, /tamanho de barril cadastrado/);
    await quiosque.fail("taras:create", { tamanho: 20, pesoKg: "0" }, /peso do vasilhame vazio/);
    await quiosque.fail("taras:update", { id: t.id, pesoKg: "8,5" }, SEM_PERMISSAO);
    await quiosque.fail("taras:toggle", { id: t.id }, SEM_PERMISSAO);
    await quiosque.fail("taras:delete", { id: t.id }, SEM_PERMISSAO);
    await gerente.ok("taras:update", { id: t.id, pesoKg: "8,5", descricao: "Barril inox" });
    assert.match((await ultimaAuditoria("tara_editada")).detalhe, /Vasilhame de 20 L: 8,4 kg \(Barril inox\) → 8,5 kg/);

    // duas ativas no mesmo tamanho: a padrão é a mais recente
    const nova = await admin.ok("taras:create", { tamanho: 20, pesoKg: "8,1" });
    const de20 = (await admin.ok("taras:list")).filter((x) => x.tamanho_l === 20);
    assert.deepEqual(de20.map((x) => [x.id, x.padrao]), [[nova.id, true], [t.id, false]]);
    // desativada sai da lista do diálogo e a outra vira a padrão
    await gerente.ok("taras:toggle", { id: nova.id });
    assert.deepEqual((await admin.ok("taras:list")).filter((x) => x.tamanho_l === 20).map((x) => [x.id, x.padrao]), [[t.id, true]]);
    assert.equal((await admin.ok("taras:list", { todos: true })).find((x) => x.id === nova.id).ativo, 0);
    // desativada não serve para pesar
    const id = await novoBarril("P7", 20);
    await engatar(id);
    await admin.fail("barris:retirarComChope", { id, metodo: "balanca", pesoBruto: 15, taraId: nova.id }, /tara foi desativada/);

    // usada em pesagem: não apaga; nunca usada: apaga
    await admin.ok("barris:retirarComChope", { id, metodo: "balanca", pesoBruto: 15, taraId: t.id });
    await gerente.fail("taras:delete", { id: t.id }, /já foi usada em 1 pesagem\(ns\) e não pode ser apagada/);
    await gerente.ok("taras:delete", { id: nova.id });
    assert.equal((await consulta(banco().from("taras").select("id").eq("id", nova.id))).length, 0);
    // mudar o peso da tara depois não muda a pesagem antiga (cópia)
    await admin.ok("taras:update", { id: t.id, pesoKg: "9" });
    assert.equal((await pesagensDe(id))[0].tara_kg, 8.5);
  });

  test("inventário: não conclui com barril sem pesagem; disponíveis cheios entram como 100%; saldo novo e status igual", async () => {
    // Unidade Porto: um engatado, um disponível com saldo, um disponível cheio
    const emUso = await novoBarril("I1", 50, admin, u.porto);
    await engatar(emUso, admin, u.porto);
    const comSaldo = await novoBarril("I2", 30, admin, u.porto);
    await engatar(comSaldo, admin, u.porto);
    await admin.ok("barris:retirarComChope", { id: comSaldo, metodo: "estimativa", nivel: 75 });
    const cheio = await novoBarril("I3", 50, admin, u.porto);

    assert.equal((await admin.ok("inventarios:atual", { unitId: u.porto })).inventario, null);
    const inv = await admin.ok("inventarios:iniciar", { unitId: u.porto });
    assert.ok(inv.inventario.id);
    assert.equal((await admin.ok("inventarios:iniciar", { unitId: u.porto })).inventario.id, inv.inventario.id, "começar de novo devolve o aberto");
    assert.deepEqual(inv.barris.map((b) => [b.codigo, b.precisa, b.pesagem]), [["I1", true, null], ["I2", true, null], ["I3", false, null]]);
    assert.equal(inv.barris[0].torneira_numero, 1);
    // o gerente do Centro não tem acesso ao Porto
    await gerente.fail("inventarios:atual", { unitId: u.porto }, /não tem acesso/);
    await gerente.fail("inventarios:concluir", { id: inv.inventario.id }, /não tem acesso/);

    await admin.fail("inventarios:concluir", { id: inv.inventario.id }, /Falta pesar 2 barril\(is\): #I1, #I2/);
    await admin.ok("pesagens:registrar", { barrilId: emUso, inventarioId: inv.inventario.id, metodo: "balanca", pesoBruto: 40 });
    await admin.fail("inventarios:concluir", { id: inv.inventario.id }, /Falta pesar 1 barril\(is\): #I2\./);
    // barril de outra unidade não entra neste inventário
    const doCentro = await novoBarril("I9");
    await admin.fail("pesagens:registrar", { barrilId: doCentro, inventarioId: inv.inventario.id, metodo: "estimativa", nivel: 100 }, /não é da unidade deste inventário/);
    await admin.ok("pesagens:registrar", { barrilId: comSaldo, inventarioId: inv.inventario.id, metodo: "estimativa", nivel: 25 });

    const atual = await admin.ok("inventarios:atual", { unitId: u.porto });
    assert.deepEqual(atual.barris.map((b) => [b.codigo, b.pesagem && b.pesagem.litros]), [["I1", litrosDe(40, 13.5)], ["I2", 7.5], ["I3", null]]);

    const r = await admin.ok("inventarios:concluir", { id: inv.inventario.id });
    assert.deepEqual([r.pesados, r.cheios], [2, 1]);
    const pes = await consulta(banco().from("pesagens").select("barril_id, motivo, metodo, nivel_pct, litros, inventario_id").eq("inventario_id", inv.inventario.id).order("id"));
    assert.deepEqual(pes.map((p) => [p.barril_id, p.motivo, p.metodo, p.nivel_pct, p.litros]), [
      [emUso, "inventario", "balanca", null, litrosDe(40, 13.5)],
      [comSaldo, "inventario", "estimativa", 25, 7.5],
      [cheio, "inventario", "estimativa", 100, 50],
    ]);
    // status igual; o disponível com saldo tem o saldo novo; o engatado e o cheio não mudam de saldo
    assert.deepEqual([(await barrilDb(emUso)).status, (await barrilDb(emUso)).saldo_l], ["em_uso", null]);
    assert.deepEqual([(await barrilDb(comSaldo)).status, (await barrilDb(comSaldo)).saldo_l, (await barrilDb(comSaldo)).saldo_estimado], ["disponivel", 7.5, true]);
    assert.deepEqual([(await barrilDb(cheio)).status, (await barrilDb(cheio)).saldo_l], ["disponivel", null]);
    // concluído: não pesa mais nele e um novo pode começar
    await admin.fail("inventarios:concluir", { id: inv.inventario.id }, /já foi concluído/);
    await admin.fail("pesagens:registrar", { barrilId: emUso, inventarioId: inv.inventario.id, metodo: "estimativa", nivel: 50 }, /já foi concluído/);
    const depois = await admin.ok("inventarios:atual", { unitId: u.porto });
    assert.equal(depois.inventario, null);
    assert.equal(depois.ultimo.id, inv.inventario.id);
    assert.match((await ultimaAuditoria("inventario_concluido")).detalhe, /Bar do Porto \(inventário \d+\): 2 barril\(is\) pesado\(s\), 1 cheio\(s\) sem pesar/);
  });

  test("pesagem avulsa: disponível ganha saldo, engatado só registra; vazio não pesa", async () => {
    const disp = await novoBarril("A1", 30);
    const r = await admin.ok("pesagens:registrar", { barrilId: disp, metodo: "estimativa", nivel: 75 });
    assert.deepEqual([r.litros, r.estimado], [22.5, true]);
    assert.deepEqual([(await barrilDb(disp)).saldo_l, (await barrilDb(disp)).saldo_estimado], [22.5, true]);
    const p = (await pesagensDe(disp))[0];
    assert.deepEqual([p.motivo, p.inventario_id], ["avulsa", null]);
    const mov = (await movsDe(disp)).at(-1);
    assert.deepEqual([mov.operacao, mov.observacao, mov.pesagem_id], ["pesagem", "Pesagem avulsa: 22,5 L (estimado)", p.id]);

    const uso = await novoBarril("A2");
    const tap = await engatar(uso);
    await admin.ok("pesagens:registrar", { barrilId: uso, metodo: "balanca", pesoBruto: 50 });
    assert.equal((await barrilDb(uso)).saldo_l, null, "engatado não ganha saldo");
    assert.equal((await movsDe(uso)).at(-1).observacao, `Pesagem avulsa: ${(litrosDe(50, 13.5)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} L (pesado) · engatado na Torneira ${tap.numero}`);
    await admin.ok("barris:empty", { id: uso });
    await admin.fail("pesagens:registrar", { barrilId: uso, metodo: "estimativa", nivel: 25 }, /Só dá para pesar barril engatado ou disponível/);
  });

  test("histórico e CSV mostram as pesagens e o 'Retirado com chope'; o estoque mostra o saldo", async () => {
    const lista = await admin.ok("history:list", { unitId: u.centro, operacao: "retirada_com_chope" });
    assert.ok(lista.length >= 3);
    const p2 = lista.find((m) => m.codigo === "P2");
    assert.deepEqual([p2.litros, p2.estimado], [litrosDe(31.9, 13.5), false]);
    const pes = await admin.ok("history:list", { unitId: u.centro, operacao: "pesagem", q: "A1" });
    assert.deepEqual(pes.map((m) => [m.codigo, m.litros, m.estimado, m.responsavel]), [["A1", 22.5, true, "Eduardo"]]);

    const csv = csvLinhas((await admin.ok("history:export", { unitId: u.centro })).csv);
    const ops = new Set(csv.slice(1).map((l) => l[3]));
    assert.ok(ops.has("Retirado com chope") && ops.has("Pesagem"), [...ops].join(", "));

    const estoque = csvLinhas((await admin.ok("barris:exportStock", { unitId: u.centro })).csv);
    const linha = estoque.find((l) => l[0] === "#A1");
    assert.equal(linha[3], "Disponível · ≈ 22,5 L");
    assert.equal(estoque.find((l) => l[0] === "#P2")[3], "Disponível · 18,2 L");
  });

  test("apagar usuário passa as pesagens e os inventários para quem recebe o histórico", async () => {
    const gina = (await consulta(banco().from("usuarios").select("id").eq("email", "gina@barrilfacil.test")))[0].id;
    const id = await novoBarril("D1", 50, gerente);
    await engatar(id, gerente);
    await gerente.ok("barris:retirarComChope", { id, metodo: "estimativa", nivel: 50 });
    await gerente.ok("taras:create", { tamanho: 30, pesoKg: "10" });
    const prev = await admin.ok("users:deletePreview", { id: gina });
    assert.equal(prev.pesagens, 1);
    assert.equal(prev.total, prev.engates + prev.movimentacoes + prev.transferencias + prev.pesagens + prev.inventarios);
    const eu = (await consulta(banco().from("usuarios").select("id").eq("email", "eduardo@barrilfacil.test")))[0].id;
    const r = await admin.ok("users:delete", { id: gina, destinoId: eu });
    assert.equal(r.pesagens, 1);
    assert.equal((await pesagensDe(id))[0].usuario_id, eu);
    assert.equal((await consulta(banco().from("taras").select("id").eq("criado_por", gina))).length, 0);
  });
});
