/* ==========================================================
   BarrilFacil — cabeçalho compartilhado (menu, unidade, alertas, usuário)
   Uso em cada página: const ctx = await MCLayout.init("barris");
   ========================================================== */
const MCLayout = (() => {
  /* principal: true = aba fixa no topo. O resto fica no botão "Mais" (toda tela nova entra lá por padrão).
     short: rótulo da barra inferior no celular. admin: só o administrador vê. */
  const NAV = [
    { id: "barris", label: "Barris", href: "barris.html", principal: true },
    { id: "torneiras", label: "Torneiras", short: "Torn.", href: "torneiras.html", principal: true },
    { id: "catalogo", label: "Chopes", href: "catalogo.html", principal: true },
    { id: "historico", label: "Histórico", short: "Hist.", href: "historico.html", principal: true },
    { id: "dashboard", label: "Painel", href: "dashboard.html" },
    { id: "transferencias", label: "Transferências", href: "transferencias.html" },
    { id: "quiosques", label: "Unidades", href: "quiosques.html", admin: true },
    { id: "usuarios", label: "Usuários", href: "usuarios.html", admin: true },
  ];
  const ADMIN_PAGES = ["usuarios", "quiosques"]; // telas que só o administrador abre
  const SEM_UNIDADE = ["usuarios", "quiosques", "catalogo"]; // telas que funcionam sem unidade liberada

  const ICON_PIN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s7-7.58 7-12A7 7 0 0 0 5 10c0 4.42 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  const ICON_BELL = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  const ICON_WARN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';

  // config: dados do servidor para as telas (ex.: config.fornecedor, nome de quem entrega os barris)
  const ctx = { user: null, units: [], unitId: null, config: { fornecedor: "Fornecedor" }, onUnitChange: () => {} };

  function buildNav(pageId) {
    const itens = NAV.filter((n) => !n.admin || ctx.user.cargo === "admin");
    const aba = (n) => `<a href="${n.href}" class="nav-tab${n.id === pageId ? " active" : ""}"${n.id === pageId ? ' aria-current="page"' : ""}>` +
      (n.short ? `<span class="nav-full">${n.label}</span><span class="nav-short">${n.short}</span>` : n.label) + "</a>";
    const mais = itens.filter((n) => !n.principal);
    const atual = mais.find((n) => n.id === pageId);
    const menu = mais.map((n) => `<li><a class="dropdown-item${n.id === pageId ? " active" : ""}" href="${n.href}"${n.id === pageId ? ' aria-current="page"' : ""}>${n.label}</a></li>`).join("");
    // Se a tela atual está dentro do "Mais", o botão fica destacado e mostra o nome dela
    return itens.filter((n) => n.principal).map(aba).join("") + (mais.length ? `
      <div class="dropdown nav-more">
        <button class="nav-tab nav-more-btn dropdown-toggle${atual ? " active" : ""}" type="button" data-bs-toggle="dropdown" aria-expanded="false" aria-label="${atual ? `${atual.label}: mais telas` : "Mais telas"}">
          <span class="nav-full">${atual ? atual.label : "Mais"}</span><span class="nav-short" aria-hidden="true">☰</span>
        </button>
        <ul class="dropdown-menu nav-more-menu">${menu}</ul>
      </div>` : "");
  }

  function buildHeader(pageId) {
    const nav = buildNav(pageId);

    document.getElementById("appHeader").innerHTML = `
      <a class="brand-logo" href="dashboard.html" title="Ir para o Painel">
        <img src="assets/icon-64.png" width="32" height="32" alt="">
        <span class="brand-name">BarrilFacil</span>
      </a>
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
            <li><button class="dropdown-item" id="btnTema" type="button"></button></li>
            <li><button class="dropdown-item" id="btnChangePwd" type="button">Alterar minha senha</button></li>
            <li><button class="dropdown-item" id="btnLogout" type="button">Sair</button></li>
          </ul>
        </div>
      </div>`;

    document.getElementById("btnLogout").addEventListener("click", () => BarrilFacilAuth.logout());
    document.getElementById("btnChangePwd").addEventListener("click", changePassword);

    // Tema: Automático (segue o Windows) -> Claro -> Escuro. Fica salvo só neste aparelho.
    const btnTema = document.getElementById("btnTema");
    const rotuloTema = () => { btnTema.textContent = `Tema: ${window.BFTema ? window.BFTema.rotulo() : "Automático"}`; };
    rotuloTema();
    btnTema.addEventListener("click", () => {
      if (!window.BFTema) return;
      const modo = window.BFTema.proximo();
      rotuloTema();
      MC.toast(`Tema: ${window.BFTema.rotulo(modo)}.`);
    });
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
        MC.clearRemembered();
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
      alerts.map((a) => `<div class="alert-item${a.nivel === "erro" ? " alert-item--erro" : ""}"><span class="alert-icon">${ICON_WARN}</span><span>${MC.esc(a.texto)}</span></div>`).join("");
  }

  function selectUnit(id) {
    ctx.unitId = id;
    localStorage.setItem("mc_unit", String(id));
    renderUnitMenu();
    renderAlerts();
    ctx.onUnitChange(id);
  }

  /* Sem conexão com o servidor: não manda para o login (a sessão continua válida), só pede para tentar de novo */
  function showOffline() {
    document.body.innerHTML = `<main class="dashboard-main"><div class="panel text-center">
      <h2 class="panel-title">Sem conexão com o servidor</h2>
      <p class="t-muted">Verifique a internet deste aparelho. Os dados ficam guardados no servidor, nada foi perdido.</p>
      <button class="btn btn-mc btn-mc-sm" id="btnRetry" type="button">Tentar novamente</button></div></main>`;
    document.getElementById("btnRetry").addEventListener("click", () => window.location.reload());
    setTimeout(() => window.location.reload(), 15000); // tenta sozinho a cada 15 s
    return null;
  }

  async function init(pageId) {
    try {
      ctx.user = await MC.call("auth:me");
    } catch (err) {
      if (err.code === "OFFLINE") return showOffline();
      ctx.user = null;
    }
    if (!ctx.user) { window.location.href = "index.html"; return null; }
    if (ctx.user.trocarSenha) { window.location.href = "primeiro-acesso.html"; return null; }
    if (ADMIN_PAGES.includes(pageId) && ctx.user.cargo !== "admin") { window.location.href = "dashboard.html"; return null; }

    try {
      [ctx.units, ctx.config] = await Promise.all([MC.call("units:list"), MC.call("config:get")]);
    } catch (err) {
      if (err.code === "OFFLINE") return showOffline();
      throw err;
    }
    const saved = Number(localStorage.getItem("mc_unit"));
    ctx.unitId = ctx.units.some((u) => u.id === saved) ? saved : ctx.units.length ? ctx.units[0].id : null;

    buildHeader(pageId);
    watchInactivity();
    renderUnitMenu();

    // Com um único quiosque não há o que escolher: o seletor vira só um rótulo
    if (ctx.units.length <= 1) {
      const btn = document.querySelector(".unit-select");
      btn.removeAttribute("data-bs-toggle");
      btn.classList.remove("dropdown-toggle");
      btn.classList.add("unit-select--single");
    }

    // Quem ainda não foi liberado para nenhuma unidade não tem o que ver (exceto as telas que não dependem de unidade)
    if (!ctx.units.length && !SEM_UNIDADE.includes(pageId)) {
      const main = document.querySelector("main");
      main.innerHTML = `<div class="panel text-center"><h2 class="panel-title">Nenhuma unidade liberada</h2>
        <p class="t-muted mb-0">${ctx.user.cargo === "admin"
          ? "Não há unidades ativas. Cadastre ou reative uma na aba Unidades."
          : "Você ainda não tem acesso a nenhuma unidade. Peça a um administrador para liberar o seu acesso."}</p></div>`;
      return null;
    }

    if (ctx.unitId) renderAlerts();
    return ctx;
  }

  return { init, ctx, refreshAlerts: renderAlerts };
})();
