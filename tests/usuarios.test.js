/* ==========================================================
   BarrilFacil — testes: cargos e permissões (administrador, gerente, operador), trocar cargo e apagar usuário
   Rodar:  npm test   (precisa do Supabase local; veja "Rodar os testes" no README)
   ========================================================== */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SEM_BANCO, banco, limparBanco, startServer, client, setupAdmin, makeUser } = require("./helpers");

const ADMIN = { identifier: "eduardo@barrilfacil.test", password: "Administrador1" };
const SEM_PERMISSAO = /Você não tem permissão para esta ação/;
const ULTIMO_ADMIN = /último administrador ativo/;

const somaDias = (dia, n) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe("cargos, permissões, trocar cargo e apagar usuário", { skip: SEM_BANCO }, () => {
  let srv, admin, gerente, operador, hoje, validade;
  const u = {};   // unidades
  const ids = {}; // usuários, chopes, estilos e barris criados nos testes

  const consulta = async (q) => { const { data, error } = await q; assert.ifError(error); return data; };
  const idDe = async (email) => (await consulta(banco().from("usuarios").select("id").eq("email", email)))[0].id;
  const criar = (dados) => makeUser(srv.base, admin, dados);
  const entrar = async (identifier, password = "SenhaForte123") => {
    const c = client(srv.base);
    await c.ok("auth:login", { identifier, password });
    return c;
  };
  const tapLivre = async (who, unitId) => (await who.ok("taps:board", { unitId })).torneiras.find((t) => !t.ocupada);
  const barril = async (who, unitId, codigo) => (await who.ok("barris:list", { unitId })).find((b) => b.codigo === codigo);
  // Cadastra, engata e retira um barril: o dia a dia que todos os cargos fazem
  const usarBarril = async (who, unitId, codigo) => {
    await who.ok("barris:create", { codigo, chopeId: ids.pilsen, tamanho: 30, validade, unitId });
    const b = await barril(who, unitId, codigo);
    const t = await tapLivre(who, unitId);
    await who.ok("barris:use", { id: b.id, torneiraId: t.id });
    assert.equal((await barril(who, unitId, codigo)).status, "em_uso");
    await who.ok("barris:empty", { id: b.id });
    assert.equal((await barril(who, unitId, codigo)).status, "esgotado");
    return b.id;
  };
  const periodo = () => ({ de: somaDias(hoje, -1), ate: hoje });

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    u.centro = (await admin.ok("units:create", { nome: "Loja Centro", cnpj: "11.222.333/0001-81", endereco: "Av. Brasil, 100, Centro, Cuiabá - MT" })).id;
    u.pantanal = (await admin.ok("units:create", { nome: "Loja Pantanal", cnpj: "11.444.777/0001-61", endereco: "Av. do Pantanal, 200, Cuiabá - MT" })).id;
    await admin.ok("taps:create", { unitId: u.centro, quantidade: 3 });
    await admin.ok("taps:create", { unitId: u.pantanal, quantidade: 2 });
    const pilsen = await admin.ok("estilos:create", { nome: "Pilsen" });
    ids.estiloPilsen = pilsen.id;
    ids.pilsen = (await admin.ok("chopes:create", { nome: "Louvada Pilsen", estiloId: pilsen.id })).id;
    hoje = (await admin.ok("config:get")).hoje;
    validade = somaDias(hoje, 5);
    gerente = await criar({ nome: "Gina Gerente", email: "gina@barrilfacil.test", cargo: "gerente", unidadeIds: [u.centro] });
    operador = await criar({ nome: "Otávio Operador", email: "otavio@barrilfacil.test", cargo: "operador", unidadeIds: [u.centro] });
    ids.eduardo = await idDe(ADMIN.identifier);
    ids.gina = await idDe("gina@barrilfacil.test");
    ids.otavio = await idDe("otavio@barrilfacil.test");
  });
  after(async () => { if (srv) await srv.stop(); });

  /* ---------------- Permissões ---------------- */
  test("a sessão traz o cargo, o rótulo e as permissões de cada um", async () => {
    const a = await admin.ok("auth:me");
    assert.equal(a.cargoLabel, "Administrador");
    assert.deepEqual(a.permissoes, ["usuarios", "unidades", "auditoria", "exportar", "catalogo:editar", "funcionarios"]);
    const g = await gerente.ok("auth:me");
    assert.equal(g.cargo, "gerente");
    assert.equal(g.cargoLabel, "Gerente");
    assert.deepEqual(g.permissoes, ["catalogo:editar", "funcionarios"]);
    const o = await operador.ok("auth:me");
    assert.equal(o.cargoLabel, "Operador");
    assert.deepEqual(o.permissoes, []);
  });

  test("o banco aceita só os cargos admin, gerente e operador", async () => {
    const { error } = await banco().from("usuarios").update({ cargo: "chefe" }).eq("id", ids.otavio);
    assert.equal(error && error.code, "23514");
  });

  test("gerente edita estilo e chope e vê os desativados", async () => {
    await gerente.ok("estilos:update", { id: ids.estiloPilsen, nome: "Pilsen Clássica" });
    await gerente.ok("chopes:update", { id: ids.pilsen, nome: "Louvada Pilsen", estiloId: ids.estiloPilsen });
    const ale = await gerente.ok("estilos:create", { nome: "Ale" });
    await gerente.ok("estilos:toggle", { id: ale.id });
    assert.equal((await gerente.ok("estilos:list", { todos: true })).find((e) => e.id === ale.id).ativo, 0);
    await gerente.ok("estilos:toggle", { id: ale.id });
    const audit = await consulta(banco().from("auditoria").select("acao").eq("usuario_id", ids.gina).eq("acao", "estilo_editado"));
    assert.equal(audit.length, 1);
  });

  test("gerente vê o relatório, engata e retira", async () => {
    const rel = await gerente.ok("reports:barrels", periodo());
    assert.equal(rel.unidade, "Todas as minhas unidades");
    await gerente.ok("reports:barrelsDetail", { ...periodo(), chopeId: ids.pilsen });
    await usarBarril(gerente, u.centro, "G1");
  });

  test("gerente não exporta (estoque, histórico e relatório de barris)", async () => {
    await gerente.fail("barris:exportStock", { unitId: u.centro }, SEM_PERMISSAO);
    await gerente.fail("history:export", { unitId: u.centro }, SEM_PERMISSAO);
    await gerente.fail("reports:barrelsExport", periodo(), SEM_PERMISSAO);
  });

  test("gerente não mexe em usuários, torneiras, unidades nem auditoria", async () => {
    await gerente.fail("users:create", { nome: "X", email: "x@barrilfacil.test", cargo: "operador", unidadeIds: [u.centro] }, SEM_PERMISSAO);
    await gerente.fail("users:list", {}, SEM_PERMISSAO);
    await gerente.fail("users:setRole", { id: ids.otavio, cargo: "gerente", unidadeIds: [u.centro] }, SEM_PERMISSAO);
    await gerente.fail("users:deletePreview", { id: ids.otavio }, SEM_PERMISSAO);
    await gerente.fail("users:delete", { id: ids.otavio }, SEM_PERMISSAO);
    await gerente.fail("taps:create", { unitId: u.centro, quantidade: 1 }, SEM_PERMISSAO);
    await gerente.fail("units:adminList", {}, SEM_PERMISSAO);
    await gerente.fail("units:details", { id: u.centro }, SEM_PERMISSAO);
    await gerente.fail("units:create", { nome: "Z", cnpj: "34.028.316/0001-03", endereco: "Rua Z, 1, Cuiabá - MT" }, SEM_PERMISSAO);
    await gerente.fail("audit:list", {}, SEM_PERMISSAO);
  });

  test("gerente vê só as unidades liberadas para ele", async () => {
    assert.deepEqual((await gerente.ok("units:list")).map((x) => x.id), [u.centro]);
    await gerente.fail("barris:list", { unitId: u.pantanal }, /não tem acesso a esta unidade/);
    await gerente.fail("reports:barrels", { ...periodo(), unidadeId: u.pantanal }, /não tem acesso a esta unidade/);
    // o administrador libera mais uma unidade para o gerente (vale na hora)
    await admin.ok("users:setUnits", { id: ids.gina, unidadeIds: [u.centro, u.pantanal] });
    assert.deepEqual((await gerente.ok("units:list")).map((x) => x.id), [u.centro, u.pantanal]);
    await admin.ok("users:setUnits", { id: ids.gina, unidadeIds: [u.centro] });
  });

  test("operador vê o relatório, engata e retira, mas não exporta nem edita o catálogo", async () => {
    await operador.ok("reports:barrels", periodo());
    await usarBarril(operador, u.centro, "O1");
    await operador.fail("barris:exportStock", { unitId: u.centro }, SEM_PERMISSAO);
    await operador.fail("history:export", { unitId: u.centro }, SEM_PERMISSAO);
    await operador.fail("reports:barrelsExport", periodo(), SEM_PERMISSAO);
    await operador.fail("estilos:update", { id: ids.estiloPilsen, nome: "Outro" }, SEM_PERMISSAO);
    await operador.fail("chopes:toggle", { id: ids.pilsen }, SEM_PERMISSAO);
    // "todos" (inclui desativados) só para quem edita o catálogo
    const ale = (await admin.ok("estilos:list", { todos: true })).find((e) => e.nome === "Ale");
    await admin.ok("estilos:toggle", { id: ale.id });
    assert.equal((await operador.ok("estilos:list", { todos: true })).some((e) => e.id === ale.id), false);
    await admin.ok("estilos:toggle", { id: ale.id });
  });

  test("o administrador continua exportando", async () => {
    await admin.ok("barris:exportStock", { unitId: u.centro });
    await admin.ok("history:export", { unitId: u.centro });
    await admin.ok("reports:barrelsExport", periodo());
  });

  /* ---------------- Criar e trocar cargo ---------------- */
  test("criar gerente exige ao menos uma unidade", async () => {
    await admin.fail("users:create", { nome: "Sem Loja", email: "semloja@barrilfacil.test", cargo: "gerente", unidadeIds: [] }, /ao menos uma unidade para o gerente/);
    await admin.fail("users:create", { nome: "Chefe", email: "chefe@barrilfacil.test", cargo: "chefe" }, /Cargo inválido/);
  });

  test("trocar operador para gerente vale na próxima chamada, sem sair", async () => {
    const paula = await criar({ nome: "Paula", email: "paula@barrilfacil.test", cargo: "operador", unidadeIds: [u.centro] });
    const id = await idDe("paula@barrilfacil.test");
    await paula.fail("estilos:update", { id: ids.estiloPilsen, nome: "Pilsen Clássica" }, SEM_PERMISSAO);
    await admin.ok("users:setRole", { id, cargo: "gerente", unidadeIds: [u.centro, u.pantanal] });
    const me = await paula.ok("auth:me");
    assert.equal(me.cargo, "gerente");
    assert.deepEqual(me.permissoes, ["catalogo:editar", "funcionarios"]);
    await paula.ok("estilos:update", { id: ids.estiloPilsen, nome: "Pilsen Clássica" });
    assert.deepEqual((await paula.ok("units:list")).map((x) => x.id), [u.centro, u.pantanal]);
    const audit = await consulta(banco().from("auditoria").select("detalhe").eq("acao", "cargo_alterado"));
    assert.equal(audit.at(-1).detalhe, `paula@barrilfacil.test: Operador → Gerente, unidades ${u.centro}, ${u.pantanal}`);

    // gerente → administrador: vê todas as unidades e a lista de unidades sai
    await admin.ok("users:setRole", { id, cargo: "admin" });
    assert.equal((await paula.ok("auth:me")).cargo, "admin");
    assert.equal((await consulta(banco().from("usuario_unidades").select("unidade_id").eq("usuario_id", id))).length, 0);
    // administrador → operador precisa de unidade
    await admin.fail("users:setRole", { id, cargo: "operador", unidadeIds: [] }, /ao menos uma unidade para o operador/);
    await admin.fail("users:setRole", { id, cargo: "admin" }, /já é Administrador/);
    await admin.fail("users:setRole", { id, cargo: "chefe" }, /Cargo inválido/);
    await admin.ok("users:setRole", { id, cargo: "operador", unidadeIds: [u.pantanal] });
    assert.deepEqual((await paula.ok("units:list")).map((x) => x.id), [u.pantanal]);
  });

  test("ninguém troca o próprio cargo, se desativa ou se apaga", async () => {
    await admin.fail("users:setRole", { id: ids.eduardo, cargo: "gerente", unidadeIds: [u.centro] }, /próprio cargo/);
    await admin.fail("users:toggle", { id: ids.eduardo }, /próprio usuário/);
    await admin.fail("users:deletePreview", { id: ids.eduardo }, /próprio usuário/);
    await admin.fail("users:delete", { id: ids.eduardo }, /próprio usuário/);
    assert.equal((await admin.ok("auth:me")).cargo, "admin");
  });

  test("o último administrador ativo não é apagado, desativado nem rebaixado", async () => {
    // Segunda administradora. Eduardo entra de novo (sessão nova) e é rebaixado direto no banco: por até 60 s a
    // sessão dele ainda é de administrador, mas a Bia já é a única administradora ativa.
    await criar({ nome: "Bia Admin", email: "bia@barrilfacil.test", cargo: "admin" });
    const bia = await idDe("bia@barrilfacil.test");
    const ed = await entrar(ADMIN.identifier, ADMIN.password);
    await consulta(banco().from("usuarios").update({ cargo: "gerente" }).eq("id", ids.eduardo).select("id"));
    try {
      await ed.fail("users:toggle", { id: bia }, ULTIMO_ADMIN);
      await ed.fail("users:setRole", { id: bia, cargo: "operador", unidadeIds: [u.centro] }, ULTIMO_ADMIN);
      await ed.fail("users:deletePreview", { id: bia }, ULTIMO_ADMIN);
      await ed.fail("users:delete", { id: bia }, ULTIMO_ADMIN); // a trava da função do banco
      const { error } = await banco().rpc("fn_usuario_apagar", { p_usuario: bia, p_destino: null, p_admin: ids.gina });
      assert.match(error && error.message, ULTIMO_ADMIN);
    } finally {
      await consulta(banco().from("usuarios").update({ cargo: "admin" }).eq("id", ids.eduardo).select("id"));
    }
    const b = await consulta(banco().from("usuarios").select("cargo, ativo").eq("id", bia));
    assert.deepEqual(b, [{ cargo: "admin", ativo: true }]);
    // com outro administrador ativo, desativar e rebaixar funcionam
    await admin.ok("users:toggle", { id: bia });
    await admin.ok("users:toggle", { id: bia });
    await admin.ok("users:setRole", { id: bia, cargo: "gerente", unidadeIds: [u.centro] });
  });

  /* ---------------- Apagar ---------------- */
  test("apaga usuário sem histórico; a auditoria dele fica com o e-mail", async () => {
    const caio = await criar({ nome: "Caio", email: "caio@barrilfacil.test", cargo: "operador", unidadeIds: [u.centro] });
    const id = await idDe("caio@barrilfacil.test");
    const prev = await admin.ok("users:deletePreview", { id });
    assert.deepEqual([prev.engates, prev.movimentacoes, prev.transferencias, prev.total], [0, 0, 0, 0]);
    assert.equal(prev.usuario.email, "caio@barrilfacil.test");
    assert.ok(!prev.outros.some((o) => o.id === id));
    assert.ok(prev.outros.some((o) => o.id === ids.eduardo && o.email === ADMIN.identifier && o.ativo === 1));

    await admin.ok("users:delete", { id });
    assert.equal((await consulta(banco().from("usuarios").select("id").eq("id", id))).length, 0);
    assert.equal((await consulta(banco().from("usuario_unidades").select("unidade_id").eq("usuario_id", id))).length, 0);
    // a sessão de quem foi apagado cai na hora
    const r = await caio.fail("auth:me");
    assert.equal(r.code, "SESSION");
    assert.equal((await consulta(banco().from("sessoes").select("token_hash").eq("usuario_id", id))).length, 0);
    // a auditoria do Caio (login, primeiro acesso) fica sem usuário, com o e-mail no detalhe
    const aud = await consulta(banco().from("auditoria").select("usuario_id, detalhe").like("detalhe", "%[usuário apagado: caio@barrilfacil.test]"));
    assert.ok(aud.length >= 2);
    assert.ok(aud.every((a) => a.usuario_id === null));
    const meu = await consulta(banco().from("auditoria").select("detalhe").eq("acao", "usuario_apagado"));
    assert.equal(meu.at(-1).detalhe, "caio@barrilfacil.test");
  });

  test("conta com histórico: sem destino não apaga; com destino o histórico passa para a outra conta", async () => {
    // A mesma pessoa com duas contas (a primeira com o e-mail errado)
    const errada = await criar({ nome: "Paulo (e-mail errado)", email: "paulo@errado.test", cargo: "operador", unidadeIds: [u.centro, u.pantanal] });
    await criar({ nome: "Paulo Silva", email: "paulo@barrilfacil.test", cargo: "operador", unidadeIds: [u.centro, u.pantanal] });
    const id = await idDe("paulo@errado.test");
    const destino = await idDe("paulo@barrilfacil.test");
    await usarBarril(errada, u.centro, "E1");
    await errada.ok("barris:create", { codigo: "E2", chopeId: ids.pilsen, tamanho: 30, validade, unitId: u.centro });
    const e2 = await barril(errada, u.centro, "E2");
    await errada.ok("transfer:create", { barrilId: e2.id, destinoId: u.pantanal });
    const t = (await errada.ok("transfer:list", { unitId: u.pantanal })).find((x) => x.codigo === "E2");
    await errada.ok("transfer:confirm", { id: t.id });

    const conta = async (tabela, filtro) => (await consulta(filtro(banco().from(tabela).select("id")))).length;
    const engates = await conta("engates", (q) => q.or(`engatado_por.eq.${id},retirado_por.eq.${id}`));
    const movs = await conta("movimentacoes", (q) => q.eq("usuario_id", id));
    const transf = await conta("transferencias", (q) => q.or(`solicitante_id.eq.${id},recebedor_id.eq.${id}`));
    assert.ok(engates === 1 && movs >= 4 && transf === 1, `${engates} ${movs} ${transf}`);

    const prev = await admin.ok("users:deletePreview", { id });
    assert.deepEqual([prev.engates, prev.movimentacoes, prev.transferencias], [engates, movs, transf]);
    assert.equal(prev.total, engates + movs + transf);

    // sem destino: recusa com as contagens e não apaga nada
    await admin.fail("users:delete", { id }, new RegExp(`tem histórico \\(${engates} engate\\(s\\), ${movs} movimentação\\(ões\\), ${transf} transferência\\(s\\)\\)`));
    await admin.fail("users:delete", { id, destinoId: id }, /outro usuário/);
    await admin.fail("users:delete", { id, destinoId: 999999 }, /não existe/);
    assert.equal((await consulta(banco().from("usuarios").select("id").eq("id", id))).length, 1);

    const r = await admin.ok("users:delete", { id, destinoId: destino });
    assert.equal(r.total, engates + movs + transf);
    assert.equal((await consulta(banco().from("usuarios").select("id").eq("id", id))).length, 0);
    assert.equal(await conta("engates", (q) => q.eq("engatado_por", destino)), 1);
    assert.equal(await conta("engates", (q) => q.eq("retirado_por", destino)), 1);
    assert.equal(await conta("movimentacoes", (q) => q.eq("usuario_id", destino)), movs);
    assert.equal(await conta("transferencias", (q) => q.eq("solicitante_id", destino)), 1);
    assert.equal(await conta("transferencias", (q) => q.eq("recebedor_id", destino)), 1);
    // a auditoria da conta errada (login, primeiro acesso...) agora é da outra conta
    assert.ok((await consulta(banco().from("auditoria").select("id").eq("usuario_id", destino).eq("acao", "primeiro_acesso"))).length === 2);
    const aud = await consulta(banco().from("auditoria").select("detalhe").eq("acao", "usuario_apagado"));
    assert.equal(aud.at(-1).detalhe, `paulo@errado.test, histórico passado para paulo@barrilfacil.test (${engates + movs + transf} registros)`);
    // o engate aparece no Histórico com o nome da outra conta
    const hist = (await admin.ok("history:list", { unitId: u.centro, q: "E1" })).filter((m) => m.codigo === "E1");
    assert.ok(hist.length >= 3 && hist.every((m) => m.responsavel === "Paulo Silva"), JSON.stringify(hist));
  });

  test("operador e gerente não apagam ninguém; usuário inexistente dá aviso", async () => {
    await operador.fail("users:delete", { id: ids.gina }, SEM_PERMISSAO);
    await admin.fail("users:deletePreview", { id: 999999 }, /Usuário não encontrado/);
    await admin.fail("users:delete", { id: 999999 }, /Usuário não encontrado/);
  });
});
