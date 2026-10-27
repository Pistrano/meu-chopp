/* ==========================================================
   BarrilFacil — utilitários dos testes automáticos
   Os testes rodam contra um Supabase LOCAL (npx supabase start), nunca contra o banco das lojas nem
   contra o de testes do beta: cada arquivo de teste começa apagando todas as tabelas.
   O servidor de verdade sobe num processo separado (porta livre) e os testes conversam com ele por HTTP,
   como as telas fazem. "Reiniciar o servidor" = parar esse processo e subir outro.

   Variáveis (o "npx supabase start" mostra os valores):
     TEST_SUPABASE_URL         ex.: http://127.0.0.1:54321
     TEST_SUPABASE_SECRET_KEY  a chave secreta (Secret key / service_role key) do Supabase local
   ========================================================== */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const URL_TESTE = String(process.env.TEST_SUPABASE_URL || "").trim().replace(/\/+$/, "");
const CHAVE_TESTE = String(process.env.TEST_SUPABASE_SECRET_KEY || "").trim();

/* Sem as variáveis, os testes são pulados com este aviso (false = pode rodar; vai no { skip } de cada describe) */
const SEM_BANCO = URL_TESTE && CHAVE_TESTE ? false :
  "defina TEST_SUPABASE_URL e TEST_SUPABASE_SECRET_KEY com os dados do Supabase local (veja \"Rodar os testes\" no README)";

/* Trava de segurança: só um Supabase rodando neste computador. Os testes apagam as tabelas. */
if (URL_TESTE) {
  let host = "";
  try { host = new URL(URL_TESTE).hostname; } catch (_) { /* endereço inválido: cai na mensagem abaixo */ }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
    throw new Error(
      `TEST_SUPABASE_URL (${URL_TESTE}) não é um Supabase local. Os testes apagam todas as tabelas, então só rodam ` +
      "num Supabase deste computador (npx supabase start, normalmente http://127.0.0.1:54321). Nunca use o banco das lojas nem o do beta."
    );
}

/* Acesso direto ao banco local (para limpar e para conferir o que foi gravado) */
let cliente = null;
function banco() {
  if (!cliente) {
    const { createClient } = require("@supabase/supabase-js");
    cliente = createClient(URL_TESTE, CHAVE_TESTE, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return cliente;
}

/* Apaga tudo, na ordem certa (quem aponta para outra tabela sai antes dela). Roda antes de cada arquivo de teste. */
const TABELAS = [
  ["sessoes", "token_hash"], ["auditoria", "id"], ["movimentacoes", "id"], ["transferencias", "id"], ["engates", "id"],
  ["barris", "id"], ["torneiras", "id"], ["usuario_unidades", "usuario_id"], ["chopes", "id"], ["estilos", "id"],
  ["usuarios", "id"], ["unidades", "id"],
];
async function limparBanco() {
  for (const [tabela, coluna] of TABELAS) {
    const { error } = await banco().from(tabela).delete().not(coluna, "is", null);
    if (error) throw new Error(`Não foi possível limpar a tabela ${tabela} do banco local: ${error.message}`);
  }
}

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/* Sobe o servidor (src/server/server.js) num processo separado, apontando para o banco local.
   env: variáveis a mais ou diferentes (ex.: { APP_ENV: "beta" }). O .env de quem roda não passa por cima destas.
   port: para "reiniciar" no mesmo endereço (os aparelhos continuam com o cookie que já tinham). */
const SERVIDOR = path.join(__dirname, "..", "src", "server", "server.js");
async function startServer(env = {}, { port: portaFixa } = {}) {
  const port = portaFixa || (await portaLivre());
  const proc = spawn(process.execPath, [SERVIDOR], {
    env: {
      ...process.env,
      SUPABASE_URL: URL_TESTE, SUPABASE_SECRET_KEY: CHAVE_TESTE,
      PORT: String(port), HOST: "127.0.0.1", TRUST_PROXY: "", APP_TZ: "America/Cuiaba", NOME_FORNECEDOR: "Fábrica Teste", APP_ENV: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let saida = "";
  proc.stdout.on("data", (d) => { saida += d; });
  proc.stderr.on("data", (d) => { saida += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (proc.exitCode !== null) throw new Error(`O servidor de teste não subiu:\n${saida}`);
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (_) { /* ainda subindo */ }
    if (i > 150) { proc.kill(); throw new Error(`O servidor de teste não respondeu em 15 s:\n${saida}`); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    port,
    saida: () => saida,
    stop: () => new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.once("exit", () => resolve());
      proc.kill("SIGTERM");
    }),
  };
}

/* Um "aparelho": guarda o próprio cookie de sessão */
function client(base) {
  let cookie = "";
  const call = async (channel, payload = {}) => {
    const res = await fetch(`${base}/api/${channel.replace(":", "/")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MC": "1", Cookie: cookie },
      body: JSON.stringify(payload),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      call.ultimoSetCookie = setCookie;
      cookie = setCookie.split(";")[0];
    }
    return res.json();
  };
  call.ultimoSetCookie = "";
  /* Token do cookie mc_session deste aparelho (vazio se não entrou) */
  call.token = () => cookie.replace(/^mc_session=/, "");
  call.usarToken = (token) => { cookie = `mc_session=${token}`; };
  /* Espera sucesso e devolve os dados */
  call.ok = async (channel, payload) => {
    const r = await call(channel, payload);
    assert.equal(r.ok, true, `${channel} deveria funcionar, mas falhou: ${r.error}`);
    return r.data;
  };
  /* Espera falha e devolve a resposta inteira ({ ok: false, error, code }) */
  call.fail = async (channel, payload, pattern) => {
    const r = await call(channel, payload);
    assert.equal(r.ok, false, `${channel} deveria falhar, mas funcionou`);
    if (pattern) assert.match(r.error, pattern);
    return r;
  };
  return call;
}

/* Cria o primeiro administrador (banco vazio) e devolve o aparelho dele já logado */
async function setupAdmin(base, { nome = "Eduardo", email = "eduardo@barrilfacil.test", senha = "Administrador1" } = {}) {
  const admin = client(base);
  await admin.ok("auth:setup", { nome, email, senha });
  return admin;
}

/* Cria um operador pelo administrador e faz o primeiro acesso dele (senha final: SenhaForte123) */
async function makeOperator(base, admin, { nome, email, unidadeIds }) {
  const { senha } = await admin.ok("users:create", { nome, email, cargo: "operador", unidadeIds });
  const op = client(base);
  await op.ok("auth:login", { identifier: email, password: senha });
  await op.ok("auth:completeProfile", { nova: "SenhaForte123" });
  return op;
}

const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

module.exports = { SEM_BANCO, banco, limparBanco, startServer, client, setupAdmin, makeOperator, hashToken };
