/* BarrilFacil — service worker: permite instalar o app e deixa a troca de abas rápida.
   Os DADOS nunca ficam guardados aqui: a API (/api) e o /healthz sempre vão ao servidor.
   O servidor troca __VERSAO__ pela versão dos arquivos das telas (hash de js/, css/, vendor/ e assets/). Cada versão
   tem o próprio cache: quando os arquivos mudam, este arquivo muda junto, o navegador instala o service worker novo
   e o activate apaga o cache da versão anterior. */
const VERSAO = "__VERSAO__";
const CACHE = `barrilfacil-v9-${VERSAO}`;

// O que toda tela usa, guardado de uma vez na instalação (com ?v=, como as páginas pedem)
const BASICOS = [
  "vendor/bootstrap-lite.css", "vendor/bootstrap.bundle.min.js",
  "css/style.css", "css/dashboard.css", "css/app.css", "css/tema-escuro.css",
  "js/api.js", "js/common.js", "js/auth.js", "js/layout.js", "js/tema.js",
  "assets/icon-64.png", "assets/icon-192.png", "assets/icone-32.png", "assets/icone.svg",
].map((f) => `${f}?v=${VERSAO}`).concat([
  // as fontes são pedidas pelo CSS, sem ?v=
  "assets/fonts/manrope-latin.woff2", "assets/fonts/sora-latin.woff2",
]);

self.addEventListener("install", (e) => {
  // Um arquivo que falhe não impede a instalação: ele entra no cache no primeiro uso
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(BASICOS.map((f) => c.add(f).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const semConexao = () => new Response("Sem conexão com o servidor.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const guardar = (req, res) => {
  if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
  return res;
};

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname === "/healthz") return;
  // Arquivo com ?v= (e as fontes): com aquela versão o conteúdo nunca muda, então o cache vem primeiro.
  // Só guarda a versão deste service worker (uma página antiga pedindo a versão anterior vai à rede).
  const fonte = url.pathname.startsWith("/assets/fonts/");
  if (url.searchParams.has("v") || fonte) {
    const daVersao = fonte || url.searchParams.get("v") === VERSAO;
    e.respondWith(
      caches.match(e.request)
        .then((hit) => hit || fetch(e.request).then((res) => (daVersao ? guardar(e.request, res) : res)))
        .catch(semConexao)
    );
    return;
  }
  // Páginas e o resto: rede primeiro (sempre a versão mais nova); se a rede falhar, usa a cópia guardada
  e.respondWith(
    fetch(e.request)
      .then((res) => guardar(e.request, res))
      .catch(() => caches.match(e.request).then((hit) => hit || semConexao()))
  );
});
