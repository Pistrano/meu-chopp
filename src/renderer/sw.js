/* BarrilFacil — service worker: permite instalar o app e abrir as telas mesmo com a conexão lenta.
   Os DADOS nunca ficam guardados aqui: a API (/api) sempre vai ao servidor. */
const CACHE = "barrilfacil-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname === "/healthz") return;
  // Rede primeiro (sempre a versão mais nova); se a rede falhar, usa a cópia guardada
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || new Response("Sem conexão com o servidor.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } })))
  );
});
