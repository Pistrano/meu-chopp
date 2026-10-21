/* ==========================================================
   BarrilFacil — conexão com o servidor
   Todas as telas chamam window.api.invoke(canal, dados). Aqui isso vira
   um pedido HTTP ao servidor central; a sessão fica em um cookie seguro.
   ========================================================== */
(() => {
  if (!window.api) {
    window.api = {
      invoke: async (channel, payload) => {
        try {
          const res = await fetch("/api/" + channel.replace(":", "/"), {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-MC": "1" },
            body: JSON.stringify(payload || {}),
            credentials: "same-origin",
            cache: "no-store",
          });
          return await res.json();
        } catch (_) {
          return { ok: false, code: "OFFLINE", error: "Sem conexão com o servidor. Verifique a internet e tente de novo." };
        }
      },
    };
  }

  // Permite "instalar" o sistema no tablet/PC (precisa de HTTPS no endereço do servidor)
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
