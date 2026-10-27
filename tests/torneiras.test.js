/* ==========================================================
   BarrilFacil — testes: unidades (CNPJ/localização), torneiras, engate e retirada
   Rodar:  npm test   (precisa do Supabase local; veja "Rodar os testes" no README)
   ========================================================== */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SEM_BANCO, banco, limparBanco, startServer, client, setupAdmin, makeOperator } = require("./helpers");

const SEM_TORNEIRA = /Não há torneiras disponíveis nesta unidade/;
const SO_ADMIN = /Apenas administradores/;
const SEM_ACESSO = /não tem acesso a esta unidade/;

const somaDias = (dia, n) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe("unidades, torneiras, engate e retirada", { skip: SEM_BANCO }, () => {
  let srv, admin, maria, joao, validade;
  const u = {};   // unidades criadas nos testes
  const ids = {}; // barris, chopes e usuários criados nos testes

  const barril = async (who, unitId, codigo) =>
    (await who.ok("barris:list", { unitId })).find((b) => b.codigo === codigo);
  const tapsOf = async (unitId) => (await admin.ok("units:details", { id: unitId })).torneiras;
  const tapByNumber = async (unitId, numero) => (await tapsOf(unitId)).find((t) => t.numero === numero && t.ativo);
  const historyOf = async (who, unitId, codigo) =>
    (await who.ok("history:list", { unitId, q: codigo })).filter((m) => m.codigo === codigo).reverse(); // mais antigo primeiro
  const linhas = async (tabela, colunas, filtro) => {
    const { data, error } = await filtro(banco().from(tabela).select(colunas));
    assert.ifError(error);
    return data;
  };
  const cadastrar = (who, codigo, chopeId, tamanho, unitId) =>
    who.ok("barris:create", { codigo, chopeId, tamanho, validade, unitId });

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    u.centro = (await admin.ok("units:create", { nome: "Louvada Estação Cuiabá", cnpj: "45.723.174/0001-10", endereco: "Av. Historiador Rubens de Mendonça, 100, Cuiabá - MT" })).id;
    u.pantanal = (await admin.ok("units:create", { nome: "Louvada Pantanal", cnpj: "11.444.777/0001-61", endereco: "Av. do Pantanal, 200, Cuiabá - MT" })).id;
    maria = await makeOperator(srv.base, admin, { nome: "Maria", email: "maria@barrilfacil.test", unidadeIds: [u.centro] });
    joao = await makeOperator(srv.base, admin, { nome: "João", email: "joao@barrilfacil.test", unidadeIds: [u.pantanal] });
    ids.maria = (await linhas("usuarios", "id", (q) => q.eq("email", "maria@barrilfacil.test")))[0].id;
    const pilsen = await admin.ok("estilos:create", { nome: "Pilsen" });
    const ipa = await admin.ok("estilos:create", { nome: "IPA" });
    ids.pilsen = (await admin.ok("chopes:create", { nome: "Louvada Pilsen", estiloId: pilsen.id })).id;
    ids.ipa = (await admin.ok("chopes:create", { nome: "Louvada IPA", estiloId: ipa.id })).id;
    validade = somaDias((await admin.ok("config:get")).hoje, 5);
  });
  after(async () => { if (srv) await srv.stop(); });

  /* ---------------- Cadastro de unidades ---------------- */
  test("cadastra unidade com dados válidos (CNPJ numérico e alfanumérico)", async () => {
    const a = await admin.ok("units:create", { nome: "Louvada Teste", cnpj: "11.222.333/0001-81", endereco: "Av. Brasil, 100, Centro, Cuiabá - MT, 78000-000" });
    const b = await admin.ok("units:create", { nome: "Louvada Nova", cnpj: "12.abc.345/01de-35", endereco: "Rua das Flores, 50, Jardim, Várzea Grande - MT" });
    u.teste = a.id;
    u.nova = b.id;
    const list = await admin.ok("units:adminList");
    const t = list.find((x) => x.id === a.id);
    assert.equal(t.cnpj, "11222333000181");
    assert.equal(t.cnpjFormatado, "11.222.333/0001-81");
    assert.equal(list.find((x) => x.id === b.id).cnpjFormatado, "12.ABC.345/01DE-35");
  });

  test("impede cadastro sem nome, sem CNPJ ou sem localização", async () => {
    const ok = { nome: "Loja X", cnpj: "34.028.316/0001-03", endereco: "Rua A, 1, Centro, Cuiabá - MT" };
    await admin.fail("units:create", { ...ok, nome: "" }, /nome da unidade/);
    await admin.fail("units:create", { ...ok, cnpj: "" }, /Informe o CNPJ/);
    await admin.fail("units:create", { ...ok, endereco: "  " }, /localização/);
  });

  test("valida o CNPJ (formato e dígitos verificadores)", async () => {
    const base = { nome: "Loja Y", endereco: "Rua B, 2, Centro, Cuiabá - MT" };
    await admin.fail("units:create", { ...base, cnpj: "11.222.333/0001-82" }, /dígitos verificadores/);
    await admin.fail("units:create", { ...base, cnpj: "11.111.111/1111-11" }, /CNPJ inválido/);
    await admin.fail("units:create", { ...base, cnpj: "123" }, /14 caracteres/);
  });

  test("impede CNPJ duplicado, mesmo digitado com outra pontuação", async () => {
    await admin.fail("units:create", { nome: "Outra loja", cnpj: "11222333000181", endereco: "Rua C, 3, Centro, Cuiabá - MT" }, /já está cadastrado na unidade "Louvada Teste"/);
    assert.equal((await admin.ok("units:adminList")).length, 4);
  });

  test("edita os dados de uma unidade existente mantendo o id", async () => {
    await admin.ok("units:update", { id: u.centro, nome: "Louvada Estação Cuiabá", nomeCurto: "Estação Cuiabá", cnpj: "45.723.174/0001-10", endereco: "Av. Historiador Rubens de Mendonça, s/n, Cuiabá - MT" });
    const x = (await admin.ok("units:adminList")).find((y) => y.id === u.centro);
    assert.equal(x.nome_curto, "Estação Cuiabá");
    assert.equal(x.cnpjFormatado, "45.723.174/0001-10");
    // edição não pode reaproveitar o CNPJ de outra unidade
    await admin.fail("units:update", { id: u.pantanal, nome: "Louvada Pantanal", cnpj: "45723174000110", endereco: "Av. X, 1, Cuiabá - MT" }, /já está cadastrado/);
  });

  test("operador não administra unidades nem torneiras", async () => {
    await maria.fail("units:create", { nome: "Z", cnpj: "34.028.316/0001-03", endereco: "Rua Z, 1, Cuiabá - MT" }, SO_ADMIN);
    await maria.fail("units:details", { id: u.centro }, SO_ADMIN);
    await maria.fail("taps:create", { unitId: u.centro, quantidade: 2 }, SO_ADMIN);
    await maria.fail("units:adminList", {}, SO_ADMIN);
  });

  /* ---------------- Cadastro de torneiras ---------------- */
  test("cadastra torneiras por unidade, com a mesma numeração em unidades diferentes", async () => {
    assert.deepEqual((await admin.ok("taps:create", { unitId: u.centro, quantidade: 3 })).numeros, [1, 2, 3]);
    assert.deepEqual((await admin.ok("taps:create", { unitId: u.pantanal, quantidade: 2 })).numeros, [1, 2]);
    const t1 = await tapsOf(u.centro);
    assert.deepEqual(t1.map((t) => [t.numero, t.ocupada, t.ativo]), [[1, false, 1], [2, false, 1], [3, false, 1]]);
    const resumo = (await admin.ok("units:adminList")).find((x) => x.id === u.centro);
    assert.equal(resumo.torneiras, 3);
    assert.equal(resumo.torneirasOcupadas, 0);
  });

  test("impede número duplicado de torneira ativa na mesma unidade", async () => {
    const t3 = await tapByNumber(u.centro, 3);
    await admin.fail("taps:update", { id: t3.id, numero: 2 }, /Já existe uma Torneira 2/);
    await admin.ok("taps:update", { id: t3.id, numero: 5 });
    assert.deepEqual((await tapsOf(u.centro)).map((t) => t.numero), [1, 2, 5]);
    await admin.fail("taps:update", { id: t3.id, numero: 0 }, /entre 1 e 999/);
  });

  test("o banco também recusa duas torneiras ativas com o mesmo número", async () => {
    const { error } = await banco().from("torneiras").insert({ unidade_id: u.centro, numero: 1 });
    assert.equal(error && error.code, "23505");
  });

  /* ---------------- Engate ---------------- */
  test("prepara barris nas unidades", async () => {
    for (const c of ["B1", "B2", "B3", "B4"]) await cadastrar(admin, c, ids.pilsen, 30, u.centro);
    await cadastrar(admin, "P1", ids.ipa, 50, u.pantanal);
    await cadastrar(admin, "N1", ids.pilsen, 30, u.nova);
    for (const c of ["B1", "B2", "B3", "B4"]) ids[c] = (await barril(admin, u.centro, c)).id;
    ids.P1 = (await barril(admin, u.pantanal, "P1")).id;
    ids.N1 = (await barril(admin, u.nova, "N1")).id;
  });

  test("engate exige a escolha de uma torneira", async () => {
    await maria.fail("barris:use", { id: ids.B1 }, /Selecione a torneira/);
    assert.equal((await barril(maria, u.centro, "B1")).status, "disponivel");
  });

  test("engata o barril na torneira livre escolhida e a torneira fica ocupada", async () => {
    const tap1 = await tapByNumber(u.centro, 1);
    const r = await maria.ok("barris:use", { id: ids.B1, torneiraId: tap1.id, unitId: u.centro });
    assert.deepEqual(r, { codigo: "B1", estilo: "Pilsen", unidade: "Louvada Estação Cuiabá", torneira: 1 });
    const b1 = await barril(maria, u.centro, "B1");
    assert.equal(b1.status, "em_uso");
    assert.equal(b1.torneira_numero, 1);
    const t = await tapByNumber(u.centro, 1);
    assert.equal(t.ocupada, true);
    assert.equal(t.codigo, "B1");
    assert.equal(t.engatado_por, "Maria");
    assert.equal((await admin.ok("units:adminList")).find((x) => x.id === u.centro).torneirasOcupadas, 1);
    // a tela de engate mostra a torneira 1 como ocupada pelo B1
    const opcoes = await maria.ok("taps:forBarril", { barrilId: ids.B2 });
    assert.equal(opcoes.unidade.nome, "Louvada Estação Cuiabá");
    assert.deepEqual(opcoes.torneiras.map((x) => [x.numero, x.ocupada, x.barril]), [[1, true, "B1"], [2, false, null], [5, false, null]]);
  });

  test("impede dois barris na mesma torneira (e nada muda no segundo barril)", async () => {
    const tap1 = await tapByNumber(u.centro, 1);
    await maria.fail("barris:use", { id: ids.B2, torneiraId: tap1.id }, /Torneira 1 está ocupada pelo barril #B1/);
    assert.equal((await barril(maria, u.centro, "B2")).status, "disponivel");
    assert.equal((await linhas("engates", "id", (q) => q.eq("barril_id", ids.B2))).length, 0);
  });

  test("impede o mesmo barril em dois engates ativos", async () => {
    const tap2 = await tapByNumber(u.centro, 2);
    await maria.fail("barris:use", { id: ids.B1, torneiraId: tap2.id }, /não pode ser engatado/);
    assert.equal((await linhas("engates", "id", (q) => q.eq("barril_id", ids.B1).is("retirado_em", null))).length, 1);
  });

  test("o banco também recusa dois engates ativos na mesma torneira ou do mesmo barril", async () => {
    const [e] = await linhas("engates", "*", (q) => q.eq("barril_id", ids.B1).is("retirado_em", null));
    const mesmaTorneira = await banco().from("engates")
      .insert({ barril_id: ids.B2, torneira_id: e.torneira_id, unidade_id: u.centro, torneira_numero: 1, engatado_por: ids.maria });
    assert.equal(mesmaTorneira.error && mesmaTorneira.error.code, "23505");
    const tap2 = await tapByNumber(u.centro, 2);
    const mesmoBarril = await banco().from("engates")
      .insert({ barril_id: ids.B1, torneira_id: tap2.id, unidade_id: u.centro, torneira_numero: 2, engatado_por: ids.maria });
    assert.equal(mesmoBarril.error && mesmoBarril.error.code, "23505");
  });

  test("respeita unidade e permissões no engate", async () => {
    const tapPantanal = await tapByNumber(u.pantanal, 1);
    // torneira de outra unidade
    await admin.fail("barris:use", { id: ids.B2, torneiraId: tapPantanal.id }, /não pertence à unidade deste barril/);
    // unidade da tela diferente da unidade do barril
    await admin.fail("barris:use", { id: ids.B2, torneiraId: (await tapByNumber(u.centro, 2)).id, unitId: u.pantanal }, /não pertence à unidade selecionada/);
    // João só tem acesso ao Pantanal
    await joao.fail("taps:forBarril", { barrilId: ids.B2 }, SEM_ACESSO);
    await joao.fail("barris:use", { id: ids.B2, torneiraId: (await tapByNumber(u.centro, 2)).id }, SEM_ACESSO);
    await joao.fail("barris:empty", { id: ids.B1 }, SEM_ACESSO);
    // mas João engata normalmente no Pantanal
    assert.equal((await joao.ok("barris:use", { id: ids.P1, torneiraId: tapPantanal.id })).torneira, 1);
    assert.equal((await barril(admin, u.centro, "B2")).status, "disponivel");
  });

  test("impede o engate quando não há torneira livre ou cadastrada", async () => {
    await maria.ok("barris:use", { id: ids.B2, torneiraId: (await tapByNumber(u.centro, 2)).id });
    await maria.ok("barris:use", { id: ids.B3, torneiraId: (await tapByNumber(u.centro, 5)).id });
    await maria.fail("barris:use", { id: ids.B4 }, SEM_TORNEIRA);
    await maria.fail("barris:use", { id: ids.B4, torneiraId: (await tapByNumber(u.centro, 1)).id }, /ocupada/);
    // unidade sem nenhuma torneira
    const semTorneira = await admin.ok("taps:forBarril", { barrilId: ids.N1 });
    assert.equal(semTorneira.torneiras.length, 0);
    await admin.fail("barris:use", { id: ids.N1 }, SEM_TORNEIRA);
    assert.equal((await barril(admin, u.centro, "B4")).status, "disponivel");
  });

  test("não deixa desativar torneira ocupada; torneira livre pode ser desativada e reativada", async () => {
    const tap1 = await tapByNumber(u.centro, 1);
    await admin.fail("taps:toggle", { id: tap1.id }, /ocupada pelo barril #B1/);
    const [livre] = (await admin.ok("taps:create", { unitId: u.pantanal, quantidade: 1 })).numeros;
    const t = await tapByNumber(u.pantanal, livre);
    await admin.ok("taps:toggle", { id: t.id });
    assert.equal((await tapsOf(u.pantanal)).find((x) => x.id === t.id).ativo, 0);
    assert.ok(!(await joao.ok("taps:forBarril", { barrilId: ids.P1 })).torneiras.some((x) => x.id === t.id), "desativada não aparece no engate");
    await admin.ok("taps:toggle", { id: t.id });
  });

  /* ---------------- Retirada ---------------- */
  test("retira o barril: identifica a torneira certa, libera a torneira e o barril fica vazio", async () => {
    const r = await maria.ok("barris:empty", { id: ids.B1 });
    assert.deepEqual(r, { codigo: "B1", unidade: "Louvada Estação Cuiabá", torneira: 1 });
    assert.equal((await barril(maria, u.centro, "B1")).status, "esgotado"); // "Vazio (aguardando recolhimento)"
    assert.equal((await tapByNumber(u.centro, 1)).ocupada, false);
    const e = await linhas("engates", "retirado_por, retirado_em", (q) => q.eq("barril_id", ids.B1));
    assert.equal(e.length, 1);
    assert.equal(e[0].retirado_por, ids.maria);
    assert.ok(e[0].retirado_em);
  });

  test("retirada repetida ou de barril que não está em uso não libera nenhuma torneira", async () => {
    await maria.fail("barris:empty", { id: ids.B1 }, /não está em uso/);
    await maria.fail("barris:empty", { id: ids.B4 }, /não está em uso/);
    assert.deepEqual((await tapsOf(u.centro)).filter((t) => t.ativo).map((t) => [t.numero, t.ocupada]), [[1, false], [2, true], [5, true]]);
  });

  test("histórico registra usuário, data, unidade e torneira do engate e da retirada", async () => {
    const h = await historyOf(admin, u.centro, "B1");
    const eng = h.find((m) => m.operacao === "utilizacao");
    const ret = h.find((m) => m.operacao === "esgotado");
    assert.equal(eng.responsavel, "Maria");
    assert.equal(eng.origem, "Louvada Estação Cuiabá");
    assert.equal(eng.torneira_numero, 1);
    assert.match(eng.criado_em, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(ret.responsavel, "Maria");
    assert.equal(ret.torneira_numero, 1);
    assert.match(ret.observacao, /Retirado da Torneira 1/);
    const csv = (await admin.ok("history:export", { unitId: u.centro, q: "B1" })).csv;
    assert.match(csv, /Torneira/);
    assert.match(csv, /Torneira 1/);
  });

  test("vários ciclos do mesmo código ficam todos registrados (recolhido e cadastrado de novo)", async () => {
    await maria.ok("barris:collect", { ids: [ids.B1], unitId: u.centro });
    await cadastrar(maria, "B1", ids.pilsen, 30, u.centro);
    const novo = (await barril(maria, u.centro, "B1")).id;
    assert.notEqual(novo, ids.B1, "o vasilhame que volta é um cadastro novo");
    await maria.ok("barris:use", { id: novo, torneiraId: (await tapByNumber(u.centro, 1)).id });
    await maria.ok("barris:empty", { id: novo });
    const e = await linhas("engates", "retirado_em, retirado_por", (q) => q.in("barril_id", [ids.B1, novo]));
    assert.equal(e.length, 2);
    assert.ok(e.every((x) => x.retirado_em && x.retirado_por));
    const h = await historyOf(admin, u.centro, "B1");
    assert.equal(h.filter((m) => m.operacao === "utilizacao").length, 2);
    assert.equal(h.filter((m) => m.operacao === "esgotado").length, 2);
    assert.equal(h.filter((m) => m.operacao === "recolhimento").length, 1);
  });

  test("renumerar uma torneira não muda o histórico anterior", async () => {
    // B2 está engatado na Torneira 2; ela é renumerada para 7 antes da retirada
    const tap2 = await tapByNumber(u.centro, 2);
    await admin.ok("taps:update", { id: tap2.id, numero: 7 });
    assert.equal((await barril(maria, u.centro, "B2")).torneira_numero, 7);
    assert.equal((await maria.ok("barris:empty", { id: ids.B2 })).torneira, 7);
    const h = await historyOf(admin, u.centro, "B2");
    assert.equal(h.find((m) => m.operacao === "utilizacao").torneira_numero, 2, "engate guarda o número da época");
    assert.equal(h.find((m) => m.operacao === "esgotado").torneira_numero, 7, "retirada guarda o número no momento da retirada");
    // e renumerar a Torneira 1 não altera os registros antigos do B1
    await admin.ok("taps:update", { id: (await tapByNumber(u.centro, 1)).id, numero: 9 });
    assert.ok((await historyOf(admin, u.centro, "B1")).filter((m) => m.torneira_numero).every((m) => m.torneira_numero === 1));
    assert.deepEqual((await linhas("engates", "torneira_numero", (q) => q.eq("barril_id", ids.B2))).map((r) => r.torneira_numero), [2]);
  });

  /* ---------------- Funcionalidades anteriores e persistência ---------------- */
  test("transferências, painel e desativação de unidade continuam funcionando", async () => {
    // barril engatado não pode ser transferido (regra atual: só disponível)
    await maria.fail("transfer:create", { barrilId: ids.B3, destinoId: u.pantanal }, /Só é possível transferir barris disponíveis/);
    await maria.ok("transfer:create", { barrilId: ids.B4, destinoId: u.pantanal });
    const t = (await joao.ok("transfer:list", { unitId: u.pantanal })).find((x) => x.codigo === "B4");
    await joao.ok("transfer:confirm", { id: t.id });
    assert.equal((await barril(joao, u.pantanal, "B4")).status, "disponivel");
    const { stats } = await admin.ok("dashboard:get", { unitId: u.centro });
    assert.deepEqual(stats, { total: 3, disponiveis: 0, emUso: 1, emTransferencia: 0, choppEsgotado: 2, vazios: 2 });
    // unidade com barril em uso não pode ser desativada (regra que já existia)
    await admin.fail("units:toggle", { id: u.centro }, /ainda tem/);
  });

  test("os dados continuam lá depois de reiniciar o servidor", async () => {
    await srv.stop();
    srv = await startServer();
    const adm = client(srv.base);
    await adm.ok("auth:login", { identifier: "eduardo@barrilfacil.test", password: "Administrador1" });
    const list = await adm.ok("units:adminList");
    assert.equal(list.length, 4);
    assert.equal(list.find((x) => x.id === u.centro).cnpjFormatado, "45.723.174/0001-10");
    const d = await adm.ok("units:details", { id: u.centro });
    assert.deepEqual(d.torneiras.filter((x) => x.ativo).map((x) => [x.numero, x.ocupada, x.codigo]).sort(), [[5, true, "B3"], [7, false, null], [9, false, null]]);
    assert.equal((await adm.ok("history:list", { unitId: u.centro })).filter((m) => m.torneira_numero).length, 7);
  });
});
