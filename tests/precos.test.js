/* ==========================================================
   BarrilFacil — testes: tamanhos de barril cadastrados e custo por litro do chope
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

describe("tamanhos de barril e custo por litro", { skip: SEM_BANCO }, () => {
  let srv, admin, gerente, operador, unidade, hoje;
  const ids = {};

  const consulta = async (q) => { const { data, error } = await q; assert.ifError(error); return data; };
  const custos = async (chopeId) => (await consulta(banco().from("custos_chope")
    .select("tamanho_l, preco_barril, custo_litro, inicio").eq("chope_id", chopeId).order("id")))
    .map((l) => ({ ...l, tamanho_l: l.tamanho_l === null ? null : Number(l.tamanho_l),
      preco_barril: l.preco_barril === null ? null : Number(l.preco_barril), custo_litro: Number(l.custo_litro) }));
  const custoLitro = async (chope, tamanho, data) => {
    const { data: v, error } = await banco().rpc("fn_custo_litro", { p_chope: chope, p_tamanho: tamanho, p_data: data });
    assert.ifError(error);
    return v === null ? null : Number(v);
  };
  const ultimaAuditoria = async (acao) =>
    (await consulta(banco().from("auditoria").select("detalhe").eq("acao", acao).order("id", { ascending: false }).limit(1)))[0];
  const cadastrarBarril = (who, codigo, chopeId, tamanho) =>
    who("barris:create", { codigo, chopeId, tamanho, validade: somaDias(hoje, 5), unitId: unidade });

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    unidade = (await admin.ok("units:create", { razaoSocial: "Loja Centro Bebidas Ltda", nome: "Loja Centro", cnpj: "11.222.333/0001-81", endereco: "Av. Brasil, 100, Centro, Cuiabá - MT" })).id;
    hoje = (await admin.ok("config:get")).hoje;
    gerente = await makeUser(srv.base, admin, { nome: "Gina", email: "gina@barrilfacil.test", cargo: "gerente", unidadeIds: [unidade] });
    operador = await makeUser(srv.base, admin, { nome: "Otávio", email: "otavio@barrilfacil.test", cargo: "operador", unidadeIds: [unidade] });
  });
  after(async () => { if (srv) await srv.stop(); });

  /* ---------------- Tamanhos de barril ---------------- */
  test("a migration cadastra 20, 30 e 50 L com os prefixos, e todos os cargos veem os ativos", async () => {
    const lista = await operador.ok("tamanhos:list");
    assert.deepEqual(lista.map(({ id, ...t }) => t), [
      { litros: 20, prefixo: "BA2", ativo: 1 }, { litros: 30, prefixo: "BA3", ativo: 1 }, { litros: 50, prefixo: "BA5", ativo: 1 },
    ]);
    assert.equal("barris" in lista[0], false); // a contagem é só para quem edita (com todos)
  });

  test("operador não cadastra, não desativa nem vê a contagem de tamanhos", async () => {
    await operador.fail("tamanhos:create", { litros: 40 }, SEM_PERMISSAO);
    const t30 = (await admin.ok("tamanhos:list")).find((t) => t.litros === 30);
    await operador.fail("tamanhos:toggle", { id: t30.id }, SEM_PERMISSAO);
    assert.equal("barris" in (await operador.ok("tamanhos:list", { todos: true }))[0], false);
    assert.equal((await consulta(banco().from("tamanhos_barril").select("id").eq("litros", 40))).length, 0);
  });

  test("tamanho novo: litros com até uma casa, prefixo em maiúsculas, auditoria", async () => {
    await admin.fail("tamanhos:create", { litros: 0 }, /mais que 0 e até 200/);
    await admin.fail("tamanhos:create", { litros: 250 }, /mais que 0 e até 200/);
    await admin.fail("tamanhos:create", { litros: "" }, /mais que 0 e até 200/);
    await admin.fail("tamanhos:create", { litros: 7.55 }, /no máximo uma casa decimal/);
    await admin.fail("tamanhos:create", { litros: 40, prefixo: "BA 4" }, /prefixo/);
    const t = await admin.ok("tamanhos:create", { litros: 40, prefixo: " ba4 " });
    ids.t40 = t.id;
    assert.deepEqual(t, { id: t.id, litros: 40, prefixo: "BA4", ativo: 1 });
    assert.equal((await ultimaAuditoria("tamanho_barril_criado")).detalhe, "Barril de 40 L (prefixo BA4)");
    const meio = await gerente.ok("tamanhos:create", { litros: "7,5" });
    assert.equal(meio.litros, 7.5);
    assert.equal(meio.prefixo, null);
    ids.t75 = meio.id;
  });

  test("tamanho repetido é recusado", async () => {
    await admin.fail("tamanhos:create", { litros: 40 }, /^Já existe o barril de 40 L$/);
    await admin.fail("tamanhos:create", { litros: "40,0" }, /^Já existe o barril de 40 L$/);
    await admin.fail("tamanhos:create", { litros: 45, prefixo: "BA5" }, /O prefixo BA5 já é do barril de 50 L/);
    assert.equal((await consulta(banco().from("tamanhos_barril").select("id").eq("litros", 40))).length, 1);
  });

  test("tamanho novo aparece no cadastro de barril e como campo de preço", async () => {
    assert.deepEqual((await operador.ok("tamanhos:list")).map((t) => t.litros), [7.5, 20, 30, 40, 50]);
    ids.pilsen = (await admin.ok("chopes:create", { nome: "Pilsen", precoPorTamanho: true, precos: { 20: "300,00", 50: 575 } })).id;
    const info = await admin.ok("chopes:custos", { id: ids.pilsen });
    assert.deepEqual(info.tamanhos, [7.5, 20, 30, 40, 50]);
    assert.deepEqual(info.precos.find((p) => p.tamanho === 40), { tamanho: 40, precoBarril: null, custoLitro: null });
    const r = await cadastrarBarril(operador, "B40", ids.pilsen, 40);
    assert.equal(r.ok, true, r.error);
    const [b] = await consulta(banco().from("barris").select("tamanho_l, estilo").eq("codigo", "B40"));
    assert.deepEqual({ ...b, tamanho_l: Number(b.tamanho_l) }, { tamanho_l: 40, estilo: "Pilsen" });
  });

  test("barril com tamanho desativado ou inexistente é recusado", async () => {
    await admin.ok("tamanhos:toggle", { id: ids.t40 });
    assert.equal((await ultimaAuditoria("tamanho_barril_desativado")).detalhe, "Barril de 40 L (prefixo BA4)");
    assert.deepEqual((await operador.ok("tamanhos:list")).map((t) => t.litros), [7.5, 20, 30, 50]);
    const todos = await admin.ok("tamanhos:list", { todos: true });
    assert.deepEqual(todos.find((t) => t.litros === 40), { id: ids.t40, litros: 40, prefixo: "BA4", ativo: 0, barris: 1 });

    let r = await cadastrarBarril(operador, "B41", ids.pilsen, 40);
    assert.equal(r.ok, false);
    assert.match(r.error, /O barril de 40 L está desativado\. Escolha outro tamanho\./);
    r = await cadastrarBarril(admin, "B45", ids.pilsen, 45);
    assert.equal(r.ok, false);
    assert.match(r.error, /Não há barril de 45 L cadastrado\. Escolha outro tamanho\./);
    assert.equal((await consulta(banco().from("barris").select("id").in("codigo", ["B41", "B45"]))).length, 0);
    // Some também dos campos de preço; reativar volta
    assert.equal((await admin.ok("chopes:custos", { id: ids.pilsen })).tamanhos.includes(40), false);
    await gerente.ok("tamanhos:toggle", { id: ids.t40 });
    assert.equal((await ultimaAuditoria("tamanho_barril_reativado")).detalhe, "Barril de 40 L (prefixo BA4)");
    assert.equal((await cadastrarBarril(operador, "B41", ids.pilsen, 40)).ok, true);
  });

  test("a tara usa os tamanhos cadastrados e ativos", async () => {
    await admin.ok("taras:create", { tamanho: 40, pesoKg: "11,2" });
    await admin.ok("tamanhos:toggle", { id: ids.t75 });
    await admin.fail("taras:create", { tamanho: 7.5, pesoKg: 5 }, /Escolha um tamanho de barril cadastrado/);
    await admin.fail("taras:create", { tamanho: 45, pesoKg: 5 }, /Escolha um tamanho de barril cadastrado/);
  });

  test("não dá para desativar o último tamanho ativo", async () => {
    const lista = await admin.ok("tamanhos:list");
    for (const t of lista.slice(1)) await admin.ok("tamanhos:toggle", { id: t.id });
    await admin.fail("tamanhos:toggle", { id: lista[0].id }, /pelo menos um tamanho de barril ativo/);
    for (const t of lista.slice(1)) await admin.ok("tamanhos:toggle", { id: t.id });
    assert.deepEqual((await admin.ok("tamanhos:list")).map((t) => t.litros), [20, 30, 40, 50]);
  });

  /* ---------------- Custo por litro ---------------- */
  test("chope novo pela tela Chopes sem custo é recusado", async () => {
    await admin.fail("chopes:create", { nome: "Sem Preço" }, /Informe o custo por litro \(R\$\)/);
    await gerente.fail("chopes:create", { nome: "Sem Preço", custoLitro: "abc" }, /Informe o custo por litro em reais/);
    await admin.fail("chopes:create", { nome: "Sem Preço", custoLitro: 0 }, /Informe o custo por litro em reais/);
    await admin.fail("chopes:create", { nome: "Sem Preço", precoPorTamanho: true, precos: {} }, /pelo menos um tamanho de barril/);
    await admin.fail("chopes:create", { nome: "Sem Preço", precoPorTamanho: true, precos: { 20: "-5" } }, /preço do barril de 20 L/);
    assert.equal((await consulta(banco().from("chopes").select("id").eq("nome", "Sem Preço"))).length, 0);
  });

  test("preço único grava uma linha com tamanho nulo", async () => {
    const c = await gerente.ok("chopes:create", { nome: "Weiss", custoLitro: "12,50" });
    ids.weiss = c.id;
    assert.deepEqual(await custos(c.id), [{ tamanho_l: null, preco_barril: null, custo_litro: 12.5, inicio: hoje }]);
    const br = hoje.split("-").reverse().join("/");
    assert.equal((await ultimaAuditoria("chope_preco")).detalhe, `Weiss: R$ 12,50/L (qualquer tamanho) · início ${br}`);
    const item = (await gerente.ok("chopes:list", { custos: true })).find((x) => x.id === c.id);
    assert.deepEqual(item.custo, { porTamanho: false, custoLitro: 12.5, precos: [], min: 12.5, max: 12.5, semPreco: false, semPrecoTamanhos: [] });
    assert.equal(await custoLitro(c.id, 30, hoje), 12.5);
    assert.equal(await custoLitro(c.id, 50, hoje), 12.5);
  });

  test("preço por tamanho grava custo_litro = preço ÷ tamanho", async () => {
    // Pilsen: 20 L a R$ 300,00 e 50 L a R$ 575,00 (cadastrado no teste dos tamanhos)
    assert.deepEqual(await custos(ids.pilsen), [
      { tamanho_l: 20, preco_barril: 300, custo_litro: 15, inicio: hoje },
      { tamanho_l: 50, preco_barril: 575, custo_litro: 11.5, inicio: hoje },
    ]);
    const [c] = await consulta(banco().from("chopes").select("preco_por_tamanho").eq("id", ids.pilsen));
    assert.equal(c.preco_por_tamanho, true);
    const item = (await admin.ok("chopes:list", { custos: true })).find((x) => x.id === ids.pilsen);
    assert.equal(item.custo.min, 11.5);
    assert.equal(item.custo.max, 15);
    assert.equal(item.custo.semPreco, false);
    assert.deepEqual(item.custo.semPrecoTamanhos, [30, 40]); // 30 L vazio e o 40 L, novo
    assert.equal(await custoLitro(ids.pilsen, 20, hoje), 15);
    assert.equal(await custoLitro(ids.pilsen, 50, hoje), 11.5);
    assert.equal(await custoLitro(ids.pilsen, 30, hoje), null);
    assert.equal(await custoLitro(ids.pilsen, null, hoje), null);
    // 100 ÷ 30 com 4 casas
    const tres = await admin.ok("chopes:create", { nome: "Lager", precoPorTamanho: true, precos: { 30: 100 } });
    assert.equal((await custos(tres.id))[0].custo_litro, 3.3333);
  });

  test("fn_custo_litro escolhe o tamanho e a data certos e devolve o primeiro preço para barril anterior", async () => {
    const c = await admin.ok("chopes:create", { nome: "Datas", precoPorTamanho: true, precos: { 20: 200 } });
    await consulta(banco().from("custos_chope").delete().eq("chope_id", c.id));
    const linha = (tamanho_l, preco, inicio) =>
      ({ chope_id: c.id, tamanho_l, preco_barril: tamanho_l === null ? null : preco, custo_litro: tamanho_l === null ? preco : preco / tamanho_l, inicio });
    await consulta(banco().from("custos_chope").insert([
      linha(20, 200, "2026-01-01"), linha(20, 240, "2026-03-01"), linha(50, 450, "2026-02-01"),
      linha(null, 7, "2025-06-01"), // do preço único: não vale enquanto o chope é por tamanho
    ]));
    assert.equal(await custoLitro(c.id, 20, "2026-02-15"), 10);
    assert.equal(await custoLitro(c.id, 20, "2026-03-01"), 12);
    assert.equal(await custoLitro(c.id, 20, "2026-12-31"), 12);
    assert.equal(await custoLitro(c.id, 20, "2025-12-01"), 10); // barril anterior ao primeiro preço
    assert.equal(await custoLitro(c.id, 50, "2026-01-10"), 9);
    assert.equal(await custoLitro(c.id, 30, "2026-02-15"), null);
    // No mesmo início, vale a gravada por último
    await consulta(banco().from("custos_chope").insert([linha(20, 260, "2026-03-01")]));
    assert.equal(await custoLitro(c.id, 20, "2026-03-05"), 13);
    // Preço único: as linhas de tamanho nulo, para qualquer tamanho
    await consulta(banco().from("chopes").update({ preco_por_tamanho: false }).eq("id", c.id));
    assert.equal(await custoLitro(c.id, 20, "2026-02-15"), 7);
    assert.equal(await custoLitro(c.id, 50, "2020-01-01"), 7);
    assert.equal(await custoLitro(999999, 20, "2026-02-15"), null);
  });

  test("Preços: grava linhas novas sem apagar as antigas, só o que mudou, e mostra o histórico", async () => {
    let r = await admin.ok("chopes:precos", { id: ids.pilsen, precoPorTamanho: true, precos: { 20: 300, 50: 575 } });
    assert.deepEqual(r, { gravadas: 0, mudouModo: false });
    const amanha = somaDias(hoje, 1);
    r = await gerente.ok("chopes:precos", { id: ids.pilsen, precoPorTamanho: true, precos: { 20: "320,00", 30: 390, 50: 575 }, inicio: amanha });
    assert.deepEqual(r, { gravadas: 2, mudouModo: false });
    const linhas = await custos(ids.pilsen);
    assert.equal(linhas.length, 4);
    assert.deepEqual(linhas.slice(2), [
      { tamanho_l: 20, preco_barril: 320, custo_litro: 16, inicio: amanha },
      { tamanho_l: 30, preco_barril: 390, custo_litro: 13, inicio: amanha },
    ]);
    const br = amanha.split("-").reverse().join("/");
    assert.equal((await ultimaAuditoria("chope_preco")).detalhe,
      `Pilsen: barril de 20 L R$ 320,00 (R$ 16,00/L); barril de 30 L R$ 390,00 (R$ 13,00/L) · início ${br}`);
    // Barril de hoje fica com o preço antigo; o de amanhã, com o novo
    assert.equal(await custoLitro(ids.pilsen, 20, hoje), 15);
    assert.equal(await custoLitro(ids.pilsen, 20, amanha), 16);

    const info = await admin.ok("chopes:custos", { id: ids.pilsen });
    assert.equal(info.porTamanho, true);
    assert.equal(info.hoje, hoje);
    assert.deepEqual(info.historico.map((h) => [h.tamanho, h.precoBarril, h.custoLitro, h.inicio, h.criadoPor]), [
      [30, 390, 13, amanha, "Gina"], [20, 320, 16, amanha, "Gina"], [50, 575, 11.5, hoje, "Eduardo"], [20, 300, 15, hoje, "Eduardo"],
    ]);
    // O que vale hoje continua 15 no 20 L (o novo começa amanhã); o 30 L ainda não tinha preço hoje, então usa o primeiro
    assert.deepEqual(info.precos.filter((p) => [20, 30].includes(p.tamanho)),
      [{ tamanho: 20, precoBarril: 300, custoLitro: 15 }, { tamanho: 30, precoBarril: 390, custoLitro: 13 }]);

    // Trocar para preço único: grava a linha de tamanho nulo e marca o chope; as linhas por tamanho ficam
    r = await admin.ok("chopes:precos", { id: ids.pilsen, precoPorTamanho: false, custoLitro: 14 });
    assert.deepEqual(r, { gravadas: 1, mudouModo: true });
    assert.equal((await custos(ids.pilsen)).length, 5);
    assert.equal(await custoLitro(ids.pilsen, 50, hoje), 14);
    assert.match((await ultimaAuditoria("chope_preco")).detalhe, /^Pilsen: R\$ 14,00\/L \(qualquer tamanho\) · preço único · início /);
    // Voltar para por tamanho sem mudar valores: só troca o modo
    r = await admin.ok("chopes:precos", { id: ids.pilsen, precoPorTamanho: true, precos: { 20: 300, 50: 575 } });
    assert.deepEqual(r, { gravadas: 0, mudouModo: true });
    assert.equal(await custoLitro(ids.pilsen, 50, hoje), 11.5);
    await admin.fail("chopes:precos", { id: ids.pilsen, precoPorTamanho: false, custoLitro: 14, inicio: "2026-02-30" }, /Data de início inválida/);
  });

  test("operador cria chope no cadastro de barril sem preço e não recebe custos da API", async () => {
    const c = await operador.ok("chopes:create", { nome: "Chope do Operador", custoLitro: 99, precoPorTamanho: true, precos: { 20: 1 } });
    assert.deepEqual(c, { id: c.id, nome: "Chope do Operador" });
    assert.deepEqual(await custos(c.id), []);
    const [row] = await consulta(banco().from("chopes").select("preco_por_tamanho").eq("id", c.id));
    assert.equal(row.preco_por_tamanho, false);
    assert.equal((await cadastrarBarril(operador, "OP1", c.id, 30)).ok, true);

    const lista = await operador.ok("chopes:list", { custos: true, todos: true });
    for (const item of lista) assert.deepEqual(Object.keys(item).sort(), ["ativo", "id", "nome"]);
    await operador.fail("chopes:custos", { id: ids.pilsen }, SEM_PERMISSAO);
    await operador.fail("chopes:precos", { id: c.id, custoLitro: 10 }, SEM_PERMISSAO);
    // Para quem edita, ele aparece "Sem preço"
    const item = (await admin.ok("chopes:list", { custos: true })).find((x) => x.id === c.id);
    assert.equal(item.custo.semPreco, true);
    assert.equal(item.custo.custoLitro, null);
  });

  test("apagar o usuário que cadastrou tamanho e preço", async () => {
    const paula = await makeUser(srv.base, admin, { nome: "Paula", email: "paula@barrilfacil.test", cargo: "gerente", unidadeIds: [unidade] });
    const t = await paula.ok("tamanhos:create", { litros: 15 });
    const c = await paula.ok("chopes:create", { nome: "Chope da Paula", custoLitro: 9 });
    const [{ id }] = await consulta(banco().from("usuarios").select("id").eq("email", "paula@barrilfacil.test"));
    await admin.ok("users:delete", { id });
    const [tam] = await consulta(banco().from("tamanhos_barril").select("criado_por").eq("id", t.id));
    assert.equal(tam.criado_por, null);
    const [custo] = await consulta(banco().from("custos_chope").select("criado_por").eq("chope_id", c.id));
    assert.equal(custo.criado_por, null);
  });
});
