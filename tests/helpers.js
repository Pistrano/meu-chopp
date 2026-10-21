/* ==========================================================
   BarrilFacil — utilitários dos testes automatizados
   Sobe o servidor de verdade (porta aleatória)
   e conversa com ele por HTTP, como as telas fazem.
   ========================================================== */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { start } = require("../src/server/server");

function tempDir(prefix = "barrilfacil-teste-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startServer() {
  const { server, port } = await start({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
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
    if (setCookie) cookie = setCookie.split(";")[0];
    return res.json();
  };
  /* Espera sucesso e devolve os dados */
  call.ok = async (channel, payload) => {
    const r = await call(channel, payload);
    assert.equal(r.ok, true, `${channel} deveria funcionar, mas falhou: ${r.error}`);
    return r.data;
  };
  /* Espera falha e devolve a mensagem */
  call.fail = async (channel, payload, pattern) => {
    const r = await call(channel, payload);
    assert.equal(r.ok, false, `${channel} deveria falhar, mas funcionou`);
    if (pattern) assert.match(r.error, pattern);
    return r.error;
  };
  return call;
}

/* Cria um operador pelo administrador e faz o primeiro acesso dele */
async function makeOperator(base, admin, { nome, email, unidadeIds }) {
  const { senha } = await admin.ok("users:create", { nome, email, cargo: "operador", unidadeIds });
  const op = client(base);
  await op.ok("auth:login", { identifier: email, password: senha });
  await op.ok("auth:completeProfile", { nova: "SenhaForte123" });
  return op;
}

/* Lê o banco direto do arquivo (para conferir restrições e dados gravados) */
async function openDbFile(file) {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  return new SQL.Database(fs.readFileSync(file));
}
function rows(rawDb, sql, params = []) {
  const st = rawDb.prepare(sql);
  st.bind(params);
  const out = [];
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
}

module.exports = { tempDir, startServer, client, makeOperator, openDbFile, rows };
