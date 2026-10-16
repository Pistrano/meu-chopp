/* Tela de conexão ao servidor (aplicativo Windows) */
(async () => {
  const $ = (id) => document.getElementById(id);
  const alertBox = $("formAlert");
  const cfg = await window.shell.getConfig();
  if (cfg.serverUrl) $("url").value = cfg.serverUrl;
  $("kiosk").checked = !!cfg.kiosk;

  const erro = new URLSearchParams(location.search).get("erro");
  if (erro) {
    alertBox.className = "alert alert-error";
    alertBox.textContent = erro + " Tentando de novo automaticamente…";
    if (cfg.serverUrl) setTimeout(() => window.shell.retry(), 10000); // internet caiu? volta sozinho
  }

  $("connectForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("submitBtn");
    btn.disabled = true; btn.textContent = "Conectando…";
    alertBox.className = "alert d-none";
    const r = await window.shell.connect($("url").value, $("kiosk").checked);
    if (!r.ok) {
      alertBox.className = "alert alert-error";
      alertBox.textContent = r.error;
      btn.disabled = false; btn.textContent = "Conectar";
    }
  });
})();
