/* ==========================================================
   BarrilFacil — cabeçalho compartilhado (menu, unidade, alertas, usuário) e faixa do ambiente de testes
   Uso em cada página: const ctx = await MCLayout.init("barris");
   ========================================================== */
const MCLayout = (() => {
  /* principal: true = aba fixa no topo. O resto fica no botão "Mais" (toda tela nova entra lá por padrão).
     short: rótulo da barra inferior no celular. perm: só quem tem a permissão vê (e abre a tela). */
  const NAV = [
    { id: "dashboard", label: "Painel", href: "dashboard.html", principal: true },
    { id: "barris", label: "Barris", href: "barris.html", principal: true },
    { id: "torneiras", label: "Torneiras", short: "Torn.", href: "torneiras.html", principal: true },
    { id: "historico", label: "Histórico", short: "Hist.", href: "historico.html", principal: true },
    { id: "catalogo", label: "Chopes", href: "catalogo.html" },
    { id: "relatorio", label: "Relatório de barris", href: "relatorio-barris.html" },
    { id: "transferencias", label: "Transferências", href: "transferencias.html" },
    { id: "funcionarios", label: "Funcionários", href: "funcionarios.html", perm: "funcionarios" },
    { id: "quiosques", label: "Unidades", href: "quiosques.html", perm: "unidades" },
    { id: "usuarios", label: "Usuários", href: "usuarios.html", perm: "usuarios" },
  ];
  const SEM_UNIDADE = ["usuarios", "quiosques", "catalogo"]; // telas que funcionam sem unidade liberada

  const ICON_PIN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s7-7.58 7-12A7 7 0 0 0 5 10c0 4.42 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  const ICON_BELL = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  const ICON_WARN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';

  // config: dados do servidor para as telas (ex.: config.fornecedor, nome de quem entrega os barris)
  const ctx = { user: null, units: [], unitId: null, config: { fornecedor: "Fornecedor" }, onUnitChange: () => {} };

  /* Ambiente de testes (APP_ENV=beta no servidor): faixa amarela no topo e "[TESTE] " no título da aba.
     Nas telas com cabeçalho, a config vem no session:bootstrap (init). Nas telas sem login (entrar, primeiro acesso,
     configuração inicial), que carregam este arquivo só por causa disso, pede a config assim que o script carrega. */
  function mostrarFaixa(config) {
    if (!config || config.ambiente !== "beta" || document.querySelector(".faixa-teste")) return;
    const faixa = document.createElement("div");
    faixa.className = "faixa-teste";
    faixa.setAttribute("role", "note");
    faixa.textContent = "AMBIENTE DE TESTES: os dados daqui não são das lojas";
    document.body.prepend(faixa);
    if (!document.title.startsWith("[TESTE] ")) document.title = `[TESTE] ${document.title}`;
  }
  if (!document.getElementById("appHeader")) {
    window.api.invoke("config:get").then((res) => { if (res && res.ok) mostrarFaixa(res.data); });
  }

  /* Usuário, unidades e config (session:bootstrap) guardados por 60 s nesta janela: a próxima aba desenha o topo na
     hora com eles e confere com o servidor logo em seguida. Prefixo "bf:": some ao entrar, ao sair e com a sessão
     expirada (MC.clearRemembered), então ninguém herda o topo de outra pessoa. */
  const CACHE_SESSAO = "bf:sessao";
  const CACHE_SESSAO_MS = 60 * 1000;
  function lerCacheSessao() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CACHE_SESSAO));
      return c && c.dados && Date.now() - c.em < CACHE_SESSAO_MS ? c.dados : null;
    } catch (_) { return null; }
  }
  const gravarCacheSessao = (dados) => { try { sessionStorage.setItem(CACHE_SESSAO, JSON.stringify({ em: Date.now(), dados })); } catch (_) { /* só não guarda */ } };
  const apagarCacheSessao = () => { try { sessionStorage.removeItem(CACHE_SESSAO); } catch (_) { /* ignora */ } };
  // O que, se mudar, pede a tela de novo: usuário (cargo, permissões, nome), unidades e config ("hoje" à parte)
  const marcaSessao = (d) => JSON.stringify([d.user, d.units, { ...d.config, hoje: null }]);

  function buildNav(pageId) {
    const itens = NAV.filter((n) => !n.perm || MC.pode(n.perm));
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

  /* Encerra a sessão depois do tempo sem uso que o servidor informa (15 min; 12 h na conta de operador do
     celular do quiosque); enquanto há atividade, avisa o sistema (ping) */
  function watchInactivity() {
    const IDLE_MS = ctx.user.inatividadeMs || 15 * 60 * 1000;
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
      alerts.map((a) => `<div class="alert-item${a.nivel === "erro" ? " alert-item--erro" : a.nivel === "aviso" ? " alert-item--aviso" : ""}"><span class="alert-icon">${ICON_WARN}</span><span>${MC.esc(a.texto)}</span></div>`).join("");
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

  /* Pré-carrega as abas do menu (Chrome e o app do Windows): ao passar o mouse ou começar a tocar num link do menu,
     o navegador já busca a página. Só prefetch (a página não é executada antes da hora). */
  function preCarregarAbas() {
    if (!window.HTMLScriptElement || !HTMLScriptElement.supports || !HTMLScriptElement.supports("speculationrules")) return;
    const regras = document.createElement("script");
    regras.type = "speculationrules";
    // a aba aberta (aria-current) fica de fora: o mouse costuma continuar em cima dela depois da troca
    regras.textContent = JSON.stringify({ prefetch: [{ where: { selector_matches: "#appHeader .app-nav a[href]:not([aria-current])" }, eagerness: "moderate" }] });
    document.head.appendChild(regras);
  }

  /* Abre a tela. Com os dados guardados há menos de 60 s, desenha o topo na hora e confere com o servidor em seguida
     (conferirSessao); sem eles, faz uma chamada só (session:bootstrap) antes de desenhar. */
  async function init(pageId) {
    let dados = lerCacheSessao();
    const doCache = !!dados;
    if (!dados) {
      try {
        dados = await MC.call("session:bootstrap");
      } catch (err) {
        if (err.code === "OFFLINE") return showOffline();
        dados = null;
      }
      if (!dados || !dados.user) { window.location.href = "index.html"; return null; }
      if (!dados.user.trocarSenha) gravarCacheSessao(dados);
    }
    const pronto = montar(pageId, dados);
    if (doCache && pronto !== undefined) conferirSessao(dados);
    return pronto;
  }

  // Confere os dados guardados: sessão expirada vai para o login, senha a trocar para o primeiro acesso, e se o
  // usuário ou as unidades mudaram (cargo, acesso liberado ou tirado) a tela abre de novo já com os dados novos
  async function conferirSessao(antigos) {
    let novos;
    try {
      novos = await MC.call("session:bootstrap");
    } catch (err) {
      if (err.code === "OFFLINE") { showOffline(); return; }
      apagarCacheSessao();
      window.location.href = "index.html";
      return;
    }
    if (novos.user.trocarSenha) { apagarCacheSessao(); window.location.href = "primeiro-acesso.html"; return; }
    gravarCacheSessao(novos);
    if (marcaSessao(novos) !== marcaSessao(antigos)) { window.location.reload(); return; }
    ctx.config = novos.config; // "hoje" pode ter virado
  }

  // Desenha o topo com { user, units, config }. Devolve ctx, ou null quando a tela não abre (outra tela, sem unidade);
  // undefined quando já saiu para outra página (não precisa conferir nada).
  function montar(pageId, dados) {
    ctx.user = dados.user;
    if (ctx.user.trocarSenha) { window.location.href = "primeiro-acesso.html"; return undefined; }
    MC.setUser(ctx.user);
    mostrarFaixa(dados.config);
    const tela = NAV.find((n) => n.id === pageId);
    if (tela && tela.perm && !MC.pode(tela.perm)) { window.location.href = "dashboard.html"; return null; }
    // Botões que dependem de permissão (ex.: data-perm="exportar") somem para quem não tem
    document.querySelectorAll("[data-perm]").forEach((el) => { if (!MC.pode(el.dataset.perm)) el.remove(); });

    ctx.units = dados.units;
    ctx.config = dados.config;
    const saved = Number(localStorage.getItem("mc_unit"));
    ctx.unitId = ctx.units.some((u) => u.id === saved) ? saved : ctx.units.length ? ctx.units[0].id : null;

    buildHeader(pageId);
    watchInactivity();
    renderUnitMenu();
    preCarregarAbas();

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
        <p class="t-muted mb-0">${MC.pode("unidades")
          ? "Não há unidades ativas. Cadastre ou reative uma na aba Unidades."
          : "Você ainda não tem acesso a nenhuma unidade. Peça a um administrador para liberar o seu acesso."}</p></div>`;
      return null;
    }

    if (ctx.unitId) {
      renderAlerts();
      window.setInterval(() => { if (document.visibilityState === "visible") renderAlerts(); }, 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") renderAlerts();
      });
    }
    return ctx;
  }

  return { init, ctx, refreshAlerts: renderAlerts };
})();
