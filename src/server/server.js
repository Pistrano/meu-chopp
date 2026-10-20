/* ==========================================================
   MeuChopp — servidor central
   Entrega as telas (src/renderer) e a API (/api/...).
   Um único servidor e um único banco para todos os quiosques;
   tablets, telas e PCs apenas se conectam a ele.

   Variáveis de ambiente (todas opcionais):
     PORT=3000          porta
     HOST=0.0.0.0       endereço de escuta
     DATA_DIR=./data    onde ficam o banco e os backups
     TRUST_PROXY=1      use quando estiver atrás de Caddy/Nginx (HTTPS)
   ========================================================== */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { initDatabase } = require("./db");
const { registerHandlers, dispatch } = require("./api");

const STATIC_DIR = path.join(__dirname, "..", "renderer");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");
const MAX_BODY = 64 * 1024;

function createServer({ trustProxy = false } = {}) {
  const isSecure = (req) => !!req.socket.encrypted || (trustProxy && req.headers["x-forwarded-proto"] === "https");
  const clientIp = (req) => {
    if (trustProxy && req.headers["x-forwarded-for"]) return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
    return req.socket.remoteAddress || "";
  };
  const hostOf = (req) => (trustProxy && req.headers["x-forwarded-host"]) || req.headers.host || "";

  function baseHeaders(req, res) {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (isSecure(req)) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  function sendJson(res, status, data) {
    const text = JSON.stringify(data);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  }

  const parseCookies = (req) => {
    const out = {};
    String(req.headers.cookie || "").split(";").forEach((part) => {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    });
    return out;
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error("Pedido grande demais."), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function handleApi(req, res, pathname) {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Método não permitido." });
    // Proteção contra pedidos vindos de outros sites (CSRF): cabeçalho próprio + mesma origem + cookie SameSite=Strict
    if (!/^application\/json/i.test(req.headers["content-type"] || "") || req.headers["x-mc"] !== "1")
      return sendJson(res, 400, { ok: false, error: "Pedido inválido." });
    if (req.headers.origin) {
      let originHost = "";
      try { originHost = new URL(req.headers.origin).host; } catch (_) { /* inválido */ }
      if (originHost !== hostOf(req)) return sendJson(res, 403, { ok: false, error: "Origem não permitida." });
    }
    const m = /^\/api\/([a-zA-Z]+)\/([a-zA-Z]+)$/.exec(pathname);
    if (!m) return sendJson(res, 404, { ok: false, error: "Operação desconhecida." });

    let payload = {};
    try {
      const raw = await readBody(req);
      if (raw) payload = JSON.parse(raw);
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("formato");
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: err.status === 413 ? "Pedido grande demais." : "Pedido inválido." });
    }

    const result = await dispatch(`${m[1]}:${m[2]}`, payload, parseCookies(req).mc_session, { ip: clientIp(req) });
    const flags = `Path=/; HttpOnly; SameSite=Strict${isSecure(req) ? "; Secure" : ""}`;
    if (result.setToken) res.setHeader("Set-Cookie", `mc_session=${result.setToken}; ${flags}`);
    else if (result.clearToken) res.setHeader("Set-Cookie", `mc_session=; ${flags}; Max-Age=0`);
    sendJson(res, 200, result.body);
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (_) { res.writeHead(400); return res.end(); }
    if (rel === "/") rel = "/index.html";
    const file = path.join(STATIC_DIR, rel);
    const ext = path.extname(file).toLowerCase();
    const hidden = rel.split("/").some((p) => p.startsWith("."));
    if (!file.startsWith(STATIC_DIR + path.sep) || hidden || !MIME[ext]) { res.writeHead(404); return res.end("Não encontrado"); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end("Não encontrado"); }
      const cache = [".html", ".js", ".css", ".webmanifest"].includes(ext) ? "no-cache" : "public, max-age=86400";
      res.writeHead(200, { "Content-Type": MIME[ext], "Content-Length": st.size, "Cache-Control": cache });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  return http.createServer((req, res) => {
    baseHeaders(req, res);
    const pathname = (req.url || "/").split("?")[0];
    if (pathname === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); return res.end("MeuChopp ok"); }
    if (pathname.startsWith("/api/")) {
      return handleApi(req, res, pathname).catch((err) => {
        console.error("[erro]", err);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Erro interno do servidor." });
      });
    }
    serveStatic(req, res, pathname);
  });
}

/* Cópia diária do banco (guarda as 14 mais recentes) */
function setupBackups(dataDir) {
  const dbFile = path.join(dataDir, "meuchopp.db");
  const dir = path.join(dataDir, "backups");
  const run = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const hoje = path.join(dir, `meuchopp-${new Date().toISOString().slice(0, 10)}.db`);
      if (fs.existsSync(dbFile) && !fs.existsSync(hoje)) fs.copyFileSync(dbFile, hoje);
      const antigos = fs.readdirSync(dir).filter((f) => /^meuchopp-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -14);
      antigos.forEach((f) => fs.unlinkSync(path.join(dir, f)));
    } catch (err) {
      console.error("[backup] falhou:", err.message);
    }
  };
  run();
  return setInterval(run, 6 * 60 * 60 * 1000).unref();
}

async function start(opts = {}) {
  const port = opts.port !== undefined ? opts.port : Number(process.env.PORT) || 3000;
  const host = opts.host || process.env.HOST || "0.0.0.0";
  const dataDir = path.resolve(opts.dataDir || process.env.DATA_DIR || path.join(process.cwd(), "data"));
  const trustProxy = opts.trustProxy !== undefined ? opts.trustProxy : process.env.TRUST_PROXY === "1";

  fs.mkdirSync(dataDir, { recursive: true });
  await initDatabase(dataDir);
  registerHandlers();
  setupBackups(dataDir);

  const server = createServer({ trustProxy });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  return { server, port: server.address().port, dataDir };
}

module.exports = { start };

if (require.main === module) {
  start()
    .then(({ port, dataDir }) => {
      console.log(`MeuChopp no ar: http://localhost:${port}  (dados em ${dataDir})`);
      const stop = () => { console.log("Encerrando..."); process.exit(0); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((err) => { console.error("Não foi possível iniciar o servidor:", err.message); process.exit(1); });
}
