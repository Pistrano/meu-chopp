/* ==========================================================
   MeuChopp — cabeçalho compartilhado (menu, unidade, alertas, usuário)
   Uso em cada página: const ctx = await MCLayout.init("barris");
   ========================================================== */
const MCLayout = (() => {
  const NAV = [
    { id: "dashboard", label: "Dashboard", href: "dashboard.html" },
    { id: "barris", label: "Barris", href: "barris.html" },
    { id: "transferencias", label: "Transferências", href: "transferencias.html" },
    { id: "historico", label: "Histórico", href: "historico.html" },
    { id: "usuarios", label: "Usuários", href: "usuarios.html", admin: true },
  ];

  const ICON_PIN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s7-7.58 7-12A7 7 0 0 0 5 10c0 4.42 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  const ICON_BELL = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  const ICON_WARN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';

  const ctx = { user: null, units: [], unitId: null, onUnitChange: () => {} };

  function buildHeader(pageId) {
    const nav = NAV.filter((n) => !n.admin || ctx.user.cargo === "admin")
      .map((n) => `<a href="${n.href}" class="${n.id === pageId ? "active" : ""}">${n.label}</a>`)
      .join("");

    document.getElementById("appHeader").innerHTML = `
      <div class="brand-logo">
        <img src="assets/icon-64.png" width="32" height="32" alt="">
        <span class="brand-name">MeuChopp</span>
      </div>
      <nav class="app-nav" aria-label="Navegação principal">${nav}</nav>
      <div class="app-header-spacer"></div>
      <div class="app-header-actions">
        <div class="dropdown">
          <button class="unit-select dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
            ${ICON_PIN}<span id="unitLabel" class="unit-select-text">Unidade</span>
          </button>
          <ul id="unitMenu" class="dropdown-menu dropdown-menu-end unit-menu"></ul>
        </div>
        <div class="dropdown">
          <button class="alerts-btn" type="button" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Ver alertas">
            ${ICON_BELL}<span id="alertsBadge" class="alerts-badge d-none">0</span>
          </button>
          <div id="alertsMenu" class="dropdown-menu dropdown-menu-end alerts-menu"></div>
        </div>
        <div class="dropdown">
          <button class="user-chip dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
            <span class="user-avatar">${MC.esc(ctx.user.iniciais)}</span>
            <span class="user-info">
              <span class="user-name">${MC.esc(ctx.user.nome)}</span>
              <span class="user-role">${MC.esc(ctx.user.cargoLabel)}</span>
            </span>
          </button>
          <ul class="dropdown-menu dropdown-menu-end">
            <li><button class="dropdown-item" id="btnChangePwd" type="button">Alterar minha senha</button></li>
            <li><button class="dropdown-item" id="btnLogout" type="button">Sair</button></li>
          </ul>
        </div>
      </div>`;

    document.getElementById("btnLogout").addEventListener("click", () => MeuChoppAuth.logout());
    document.getElementById("btnChangePwd").addEventListener("click", changePassword);
  }

  function changePassword() {
    return MC.dialog({
      title: "Alterar minha senha",
      intro: "Use ao menos 8 caracteres, com letras e números.",
      fields: [
        { id: "atual", label: "Senha atual", type: "password", autocomplete: "current-password" },
        { id: "nova", label: "Nova senha", type: "password", autocomplete: "new-password" },
        { id: "confirma", label: "Repita a nova senha", type: "password", autocomplete: "new-password" },
      ],
      rules: "nova",
      submitLabel: "Salvar senha",
      onSubmit: async (v) => {
        if (v.nova !== v.confirma) throw new Error("As senhas novas não são iguais.");
        await MC.call("auth:changePassword", { atual: v.atual, nova: v.nova });
        MC.toast("Senha alterada com sucesso.");
      },
    });
  }

  /* Encerra a sessão após 15 min sem uso; enquanto há atividade, avisa o sistema (ping) */
  const IDLE_MS = 15 * 60 * 1000;
  function watchInactivity() {
    let idleTimer, lastPing = Date.now();
    const arm = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(async () => {
        try { await window.api.invoke("auth:logout"); } catch (_) {}
        window.location.href = "index.html?expirada=1";
      }, IDLE_MS);
    };
    const onActivity = () => {
      arm();
      if (Date.now() - lastPing > 60000) {
        lastPing = Date.now();
        window.api.invoke("auth:ping");
      }
    };
    ["click", "keydown", "mousemove", "touchstart"].forEach((ev) => document.addEventListener(ev, onActivity, { passive: true }));
    arm();
  }

  function renderUnitMenu() {
    const current = ctx.units.find((u) => u.id === ctx.unitId);
    document.getElementById("unitLabel").textContent = current ? current.nome_curto : "Unidade";
    document.getElementById("unitMenu").innerHTML = ctx.units
      .map(
        (u) => `<li><button type="button" class="dropdown-item unit-option" data-unit-id="${u.id}">
          <span class="unit-check">${u.id === ctx.unitId ? "✓" : ""}</span><span>${MC.esc(u.nome)}</span></button></li>`
      )
      .join("");
    document.querySelectorAll(".unit-option").forEach((btn) =>
      btn.addEventListener("click", () => selectUnit(Number(btn.dataset.unitId)))
    );
  }

  async function renderAlerts() {
    const badge = document.getElementById("alertsBadge");
    const menu = document.getElementById("alertsMenu");
    let alerts = [];
    try { alerts = await MC.call("alerts:list", { unitId: ctx.unitId }); } catch (_) {}

    if (!alerts.length) {
      badge.classList.add("d-none");
      menu.innerHTML = `<div class="alerts-menu-header">Alertas</div><p class="alerts-empty">Nenhum alerta no momento.</p>`;
      return;
    }
    badge.textContent = String(alerts.length);
    badge.classList.remove("d-none");
    menu.innerHTML =
      `<div class="alerts-menu-header">Alertas</div>` +
      alerts.map((a) => `<div class="alert-item"><span class="alert-icon">${ICON_WARN}</span><span>${MC.esc(a.texto)}</span></div>`).join("");
  }

  function selectUnit(id) {
    ctx.unitId = id;
    localStorage.setItem("mc_unit", String(id));
    renderUnitMenu();
    renderAlerts();
    ctx.onUnitChange(id);
  }

  async function init(pageId) {
    try {
      ctx.user = await MC.call("auth:me");
    } catch (_) {
      ctx.user = null;
    }
    if (!ctx.user) { window.location.href = "index.html"; return null; }
    if (ctx.user.trocarSenha) { window.location.href = "primeiro-acesso.html"; return null; }
    if (pageId === "usuarios" && ctx.user.cargo !== "admin") { window.location.href = "dashboard.html"; return null; }

    ctx.units = await MC.call("units:list");
    const saved = Number(localStorage.getItem("mc_unit"));
    ctx.unitId = ctx.units.some((u) => u.id === saved) ? saved : ctx.units[0].id;

    buildHeader(pageId);
    watchInactivity();
    renderUnitMenu();
    renderAlerts();
    return ctx;
  }

  return { init, ctx, refreshAlerts: renderAlerts };
})();
