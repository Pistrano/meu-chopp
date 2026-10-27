/* ==========================================================
   BarrilFacil — testes: sessões guardadas no banco e faixa do ambiente de testes
   Rodar:  npm test   (precisa do Supabase local; veja "Rodar os testes" no README)
   ========================================================== */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SEM_BANCO, banco, limparBanco, startServer, client, setupAdmin, makeOperator, hashToken } = require("./helpers");

const ADMIN = { identifier: "eduardo@barrilfacil.test", password: "Administrador1" };

describe("sessões guardadas no banco", { skip: SEM_BANCO }, () => {
  let srv, admin, unidadeId;

  const consulta = async (q) => { const { data, error } = await q; assert.ifError(error); return data; };
  const idDe = async (email) => (await consulta(banco().from("usuarios").select("id").eq("email", email)))[0].id;
  const sessoesDe = async (usuarioId) => consulta(banco().from("sessoes").select("*").eq("usuario_id", usuarioId));
  const reiniciar = async (env) => { const port = srv.port; await srv.stop(); srv = await startServer(env, { port }); };
  const operador = (nome, email) => makeOperator(srv.base, admin, { nome, email, unidadeIds: [unidadeId] });
  const entrar = async (identifier, password) => {
    const c = client(srv.base);
    await c.ok("auth:login", { identifier, password });
    return c;
  };
  const esperaSessaoEncerrada = async (c, canal = "auth:me", payload = {}) => {
    const r = await c.fail(canal, payload);
    assert.equal(r.code, "SESSION", `esperava SESSION, veio: ${r.error}`);
    return r;
  };

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    unidadeId = (await admin.ok("units:create", { nome: "Loja Centro", cnpj: "11.222.333/0001-81", endereco: "Av. Brasil, 100, Centro, Cuiabá - MT" })).id;
  });
  after(async () => { if (srv) await srv.stop(); });

  test("o login grava só o hash SHA-256 do token; o cookie continua com as mesmas flags", async () => {
    const ed = await entrar(ADMIN.identifier, ADMIN.password);
    assert.match(ed.ultimoSetCookie, /^mc_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict$/);
    const linhas = await sessoesDe(await idDe(ADMIN.identifier));
    const minha = linhas.find((s) => s.token_hash === hashToken(ed.token()));
    assert.ok(minha, "a sessão está no banco pelo hash do token");
    assert.ok(linhas.every((s) => s.token_hash !== ed.token()), "o token puro nunca vai para o banco");
    assert.equal(minha.ip, "127.0.0.1");
    assert.ok(minha.criado_em && minha.ultima_atividade);
  });

  test("novo login no mesmo aparelho troca o token e apaga a sessão anterior; sair apaga a sessão", async () => {
    const ed = await entrar(ADMIN.identifier, ADMIN.password);
    const antigo = ed.token();
    await ed.ok("auth:login", ADMIN);
    assert.notEqual(ed.token(), antigo);
    const hashes = (await sessoesDe(await idDe(ADMIN.identifier))).map((s) => s.token_hash);
    assert.ok(!hashes.includes(hashToken(antigo)));
    assert.ok(hashes.includes(hashToken(ed.token())));
    const atual = ed.token();
    await ed.ok("auth:logout");
    assert.match(ed.ultimoSetCookie, /^mc_session=; .*Max-Age=0/);
    assert.equal((await consulta(banco().from("sessoes").select("token_hash").eq("token_hash", hashToken(atual)))).length, 0);
    ed.usarToken(atual); // mesmo guardando o token antigo, ele não vale mais
    await esperaSessaoEncerrada(ed);
  });

  test("ultima_atividade não é gravada a cada chamada (no máximo uma vez por minuto)", async () => {
    const ed = await entrar(ADMIN.identifier, ADMIN.password);
    const ler = async () => (await consulta(banco().from("sessoes").select("ultima_atividade").eq("token_hash", hashToken(ed.token()))))[0].ultima_atividade;
    const antes = await ler();
    for (let i = 0; i < 5; i++) await ed.ok("auth:ping");
    assert.equal(await ler(), antes);
  });

  test("a sessão continua válida depois de reiniciar o servidor", async () => {
    await reiniciar();
    const eu = await admin.ok("auth:me");
    assert.equal(eu.nome, "Eduardo");
    assert.equal(eu.cargo, "admin");
    await admin.ok("units:list");
  });

  test("desativar um usuário derruba a sessão aberta dele", async () => {
    const maria = await operador("Maria", "maria@barrilfacil.test");
    const mariaId = await idDe("maria@barrilfacil.test");
    await maria.ok("barris:list", { unitId: unidadeId });
    await admin.ok("users:toggle", { id: mariaId });
    await esperaSessaoEncerrada(maria, "barris:list", { unitId: unidadeId });
    assert.equal((await sessoesDe(mariaId)).length, 0);
    await maria.fail("auth:login", { identifier: "maria@barrilfacil.test", password: "SenhaForte123" }, /E-mail ou senha incorretos/);
    // reativar não ressuscita a sessão antiga, mas a pessoa volta a conseguir entrar
    await admin.ok("users:toggle", { id: mariaId });
    await esperaSessaoEncerrada(maria);
    await entrar("maria@barrilfacil.test", "SenhaForte123");
  });

  test("trocar a própria senha derruba as outras sessões e mantém a atual", async () => {
    const celular = await operador("João", "joao@barrilfacil.test");
    const joaoId = await idDe("joao@barrilfacil.test");
    const computador = await entrar("joao@barrilfacil.test", "SenhaForte123");
    await computador.ok("auth:me");
    await celular.ok("auth:changePassword", { atual: "SenhaForte123", nova: "OutraSenha456" });
    assert.equal((await celular.ok("auth:me")).nome, "João", "quem trocou a senha continua dentro");
    await esperaSessaoEncerrada(computador);
    assert.deepEqual((await sessoesDe(joaoId)).map((s) => s.token_hash), [hashToken(celular.token())]);
    await entrar("joao@barrilfacil.test", "OutraSenha456");
  });

  test("o admin gerar senha temporária derruba as sessões do usuário", async () => {
    const bia = await operador("Bia", "bia@barrilfacil.test");
    const biaId = await idDe("bia@barrilfacil.test");
    const outro = await entrar("bia@barrilfacil.test", "SenhaForte123");
    const { senha } = await admin.ok("users:resetPassword", { id: biaId });
    await esperaSessaoEncerrada(bia);
    await esperaSessaoEncerrada(outro);
    assert.equal((await sessoesDe(biaId)).length, 0);
    await admin.ok("auth:me"); // a sessão de quem gerou a senha não é afetada
    // entra com a senha temporária e precisa definir uma nova antes de usar o sistema
    const nova = await entrar("bia@barrilfacil.test", senha);
    const r = await nova.fail("barris:list", { unitId: unidadeId });
    assert.equal(r.code, "MUST_CHANGE");
  });

  test("dados do usuário vêm do banco, não da cópia feita no login", async () => {
    const caio = await operador("Caio", "caio@barrilfacil.test");
    const caioId = await idDe("caio@barrilfacil.test");
    assert.equal((await caio.ok("auth:me")).nome, "Caio");
    await consulta(banco().from("usuarios").update({ nome: "Caio Souza" }).eq("id", caioId));
    // users:setUnits manda reler o usuário na próxima chamada (sem esperar os 60 s do cache)
    await admin.ok("users:setUnits", { id: caioId, unidadeIds: [unidadeId] });
    const eu = await caio.ok("auth:me");
    assert.equal(eu.nome, "Caio Souza");
    assert.equal(eu.iniciais, "C");
    // e depois de reiniciar também (o servidor novo lê tudo do banco)
    await consulta(banco().from("usuarios").update({ nome: "Caio S." }).eq("id", caioId));
    await reiniciar();
    assert.equal((await caio.ok("auth:me")).nome, "Caio S.");
  });

  test("sessão parada há mais de 15 minutos expira, com aviso e auditoria, mesmo depois de reiniciar", async () => {
    const dani = await operador("Dani", "dani@barrilfacil.test");
    const daniId = await idDe("dani@barrilfacil.test");
    const vinteMinAtras = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await consulta(banco().from("sessoes").update({ ultima_atividade: vinteMinAtras }).eq("usuario_id", daniId));
    await reiniciar(); // servidor novo: a única informação é a do banco
    const r = await esperaSessaoEncerrada(dani, "barris:list", { unitId: unidadeId });
    assert.match(r.error, /expirou por inatividade/);
    assert.equal((await sessoesDe(daniId)).length, 0);
    const aud = await consulta(banco().from("auditoria").select("acao").eq("usuario_id", daniId).eq("acao", "sessao_expirada"));
    assert.equal(aud.length, 1);
  });

  test("usuário desativado direto no banco também perde a sessão", async () => {
    const eva = await operador("Eva", "eva@barrilfacil.test");
    const evaId = await idDe("eva@barrilfacil.test");
    await consulta(banco().from("usuarios").update({ ativo: false }).eq("id", evaId));
    await reiniciar();
    await esperaSessaoEncerrada(eva);
    assert.equal((await sessoesDe(evaId)).length, 0);
  });

  test("se o banco falha ao validar a sessão, a resposta é erro técnico e a chamada não passa", async () => {
    const token = admin.token();
    const fora = await startServer({ SUPABASE_URL: "http://127.0.0.1:9" }); // nada escuta na porta 9
    try {
      const c = client(fora.base);
      c.usarToken(token);
      for (const canal of ["auth:me", "barris:list", "users:list"]) {
        const r = await c(canal, {});
        assert.equal(r.ok, false, `${canal} não pode funcionar sem validar a sessão`);
        assert.equal(r.error, "Erro inesperado. Tente novamente.");
        assert.equal(r.code, undefined);
      }
    } finally {
      await fora.stop();
    }
  });
});

describe("faixa do ambiente de testes (config:get)", { skip: SEM_BANCO }, () => {
  let srv;
  after(async () => { if (srv) await srv.stop(); });

  test("sem APP_ENV não há ambiente; sem login, config:get devolve só o ambiente", async () => {
    srv = await startServer();
    assert.deepEqual(await client(srv.base).ok("config:get"), { ambiente: null });
    const ed = await entrar(srv.base);
    const cfg = await ed.ok("config:get");
    assert.equal(cfg.ambiente, null);
    assert.equal(cfg.fornecedor, "Fábrica Teste");
    assert.match(cfg.hoje, /^\d{4}-\d{2}-\d{2}$/);
    await srv.stop();
  });

  test("com APP_ENV=beta, config:get devolve ambiente \"beta\", com e sem login", async () => {
    srv = await startServer({ APP_ENV: "beta" });
    assert.deepEqual(await client(srv.base).ok("config:get"), { ambiente: "beta" });
    const ed = await entrar(srv.base);
    const cfg = await ed.ok("config:get");
    assert.equal(cfg.ambiente, "beta");
    assert.equal(cfg.fornecedor, "Fábrica Teste");
  });

  async function entrar(base) {
    const c = client(base);
    await c.ok("auth:login", ADMIN);
    return c;
  }
});
