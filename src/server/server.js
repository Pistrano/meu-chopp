/* ==========================================================
   BarrilFacil — servidor central
   Entrega as telas (src/renderer) e a API (/api/...).
   Um único servidor para todas as unidades; os dados ficam no Supabase
   e tablets, telas e PCs apenas se conectam a este servidor.

   Variáveis de ambiente (as do Supabase ficam no .env, veja .env.example):
     PORT=3000          porta
     HOST=0.0.0.0       endereço de escuta
     TRUST_PROXY=1      use quando estiver atrás de Caddy/Nginx (HTTPS)
   ========================================================== */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { initDatabase } = require("./db");
const { registerHandlers, dispatch } = require("./api");

const STATIC_DIR = path.join(__dirname, "..", "renderer");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
};
// 'inline-speculation-rules': deixa o layout.js pedir o pré-carregamento das abas do menu (só isso; JS inline continua bloqueado)
const CSP = [
  "default-src 'self'", "script-src 'self' 'inline-speculation-rules'", "style-src 'self' 'unsafe-inline'",
  "font-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");
const MAX_BODY = 64 * 1024;
const LENTO_MS = 300; // chamadas da API acima disso vão para o log (canal e tempo)

/* ---------- Versão dos arquivos das telas ----------
   Ao iniciar, um hash curto do conteúdo de js/, css/, vendor/ e assets/. Ao servir um .html, os <script src> e
   <link href> locais dessas pastas ganham ?v=<versão>. Pedido com a versão atual = cache longo (o arquivo daquela
   versão nunca muda); qualquer mudança nos arquivos gera outra versão ao reiniciar o servidor (o deploy reinicia). */
const PASTAS_VERSIONADAS = ["js", "css", "vendor", "assets"];
const versionavel = (rel) => /^\/?(?:\.\/)?(?:js|css|vendor|assets)\//.test(rel); // as mesmas pastas de PASTAS_VERSIONADAS
function calcularVersao(dir = STATIC_DIR) {
  const h = crypto.createHash("sha256");
  const ler = (pasta) => {
    if (!fs.existsSync(pasta)) return;
    fs.readdirSync(pasta, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .forEach((d) => {
        const p = path.join(pasta, d.name);
        if (d.isDirectory()) ler(p);
        else if (d.isFile()) h.update(path.relative(dir, p)).update("\0").update(fs.readFileSync(p));
      });
  };
  PASTAS_VERSIONADAS.forEach((d) => ler(path.join(dir, d)));
  return h.digest("hex").slice(0, 10);
}
// <script src="js/x.js"> e <link href="css/x.css"> locais ganham ?v=; endereços externos e outras pastas ficam iguais
const versionarHtml = (html, versao) =>
  html.replace(/(<(?:script|link)\b[^>]*?\s(?:src|href)=")([^"?#]+)(")/gi,
    (tudo, antes, url, depois) => (versionavel(url) ? `${antes}${url}?v=${versao}${depois}` : tudo));
/* Resposta do /healthz. O aplicativo Windows confere esse texto antes de salvar o endereço do servidor.
   A segunda linha deixa os aplicativos instalados antes da troca de nome (que procuram o nome antigo)
   continuarem conseguindo se conectar; pode sair quando todos estiverem com o instalador novo. */
const HEALTH_TEXT = "BarrilFacil ok\nMeuChopp ok";

function createServer({ trustProxy = false } = {}) {
  const VERSAO = calcularVersao();
  const transformados = new Map(); // .html e sw.js já com a versão: arquivo -> { mtimeMs, body, etag }
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
    const inicio = process.hrtime.bigint();
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

    const canal = `${m[1]}:${m[2]}`;
    const result = await dispatch(canal, payload, parseCookies(req).mc_session, { ip: clientIp(req) });
    // Tempo da chamada no servidor: aparece no DevTools (Network > Timing) e, se passar de 300 ms, no log
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    res.setHeader("Server-Timing", `app;dur=${ms.toFixed(1)}`);
    if (ms > LENTO_MS) console.log(`[lento] ${canal} ${Math.round(ms)} ms`);
    const flags = `Path=/; HttpOnly; SameSite=Strict${isSecure(req) ? "; Secure" : ""}`;
    if (result.setToken) res.setHeader("Set-Cookie", `mc_session=${result.setToken}; ${flags}`);
    else if (result.clearToken) res.setHeader("Set-Cookie", `mc_session=; ${flags}; Max-Age=0`);
    sendJson(res, 200, result.body);
  }

  // ETag pedido de novo e igual: 304, sem corpo
  const naoMudou = (req, etag) => String(req.headers["if-none-match"] || "").split(",").some((t) => t.trim() === etag || t.trim() === "*");

  /* Arquivos das telas:
     - .html e sw.js: lidos com a versão aplicada (no .html, nos <script>/<link>; no sw.js, no nome do cache);
     - pedido com ?v= igual à versão atual: Cache-Control longo e immutable;
     - o resto: como antes (no-cache para .html/.js/.css/.webmanifest, 1 dia para imagens e fontes), agora com ETag e 304. */
  function serveStatic(req, res, pathname, query) {
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

      if (ext === ".html" || rel === "/sw.js") {
        let t = transformados.get(file);
        if (!t || t.mtimeMs !== st.mtimeMs) {
          let texto;
          try { texto = fs.readFileSync(file, "utf8"); } catch (_) { res.writeHead(404); return res.end("Não encontrado"); }
          texto = ext === ".html" ? versionarHtml(texto, VERSAO) : texto.replace(/__VERSAO__/g, VERSAO);
          const body = Buffer.from(texto, "utf8");
          // ETag fraco (W/): o Caddy comprime (gzip) e um ETag forte poderia ser trocado ou descartado no caminho
          t = { mtimeMs: st.mtimeMs, body, etag: `W/"${crypto.createHash("sha1").update(body).digest("hex").slice(0, 20)}"` };
          transformados.set(file, t);
        }
        if (naoMudou(req, t.etag)) { res.writeHead(304, { ETag: t.etag, "Cache-Control": cache }); return res.end(); }
        res.writeHead(200, { "Content-Type": MIME[ext], "Content-Length": t.body.length, "Cache-Control": cache, ETag: t.etag });
        return res.end(req.method === "HEAD" ? undefined : t.body);
      }

      const headers = { "Content-Type": MIME[ext], "Content-Length": st.size };
      if (versionavel(rel) && new URLSearchParams(query).get("v") === VERSAO) {
        headers["Cache-Control"] = "public, max-age=31536000, immutable";
      } else {
        const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
        if (naoMudou(req, etag)) { res.writeHead(304, { ETag: etag, "Cache-Control": cache }); return res.end(); }
        Object.assign(headers, { "Cache-Control": cache, ETag: etag });
      }
      res.writeHead(200, headers);
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  return http.createServer((req, res) => {
    baseHeaders(req, res);
    const [pathname, query = ""] = (req.url || "/").split("?");
    if (pathname === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); return res.end(HEALTH_TEXT); }
    if (pathname.startsWith("/api/")) {
      return handleApi(req, res, pathname).catch((err) => {
        console.error("[erro]", err);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Erro interno do servidor." });
      });
    }
    serveStatic(req, res, pathname, query);
  });
}

async function start(opts = {}) {
  const port = opts.port !== undefined ? opts.port : Number(process.env.PORT) || 3000;
  const host = opts.host || process.env.HOST || "0.0.0.0";
  const trustProxy = opts.trustProxy !== undefined ? opts.trustProxy : process.env.TRUST_PROXY === "1";

  await initDatabase();
  registerHandlers();

  const server = createServer({ trustProxy });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  return { server, port: server.address().port };
}

module.exports = { start, calcularVersao, versionarHtml };

if (require.main === module) {
  start()
    .then(({ port }) => {
      console.log(`BarrilFacil no ar: http://localhost:${port}`);
      const stop = () => { console.log("Encerrando..."); process.exit(0); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((err) => { console.error("Não foi possível iniciar o servidor:", err.message); process.exit(1); });
}
