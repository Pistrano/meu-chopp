/* BarrilFacil — Dashboard com dados reais do banco */
(async () => {
  const ctx = await MCLayout.init("dashboard");
  if (!ctx) return;

  const svg = (p) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const icons = {
    total: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M10 4v16"/>'),
    disponivel: svg('<path d="M20 6 9 17l-5-5"/>'),
    uso: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>'),
    transfer: svg('<path d="M7 7h11l-3-3M17 17H6l3 3"/>'),
    esgotado: svg('<path d="M12 3s6 6.5 6 11a6 6 0 1 1-12 0c0-4.5 6-11 6-11z"/>'),
  };

  const statsGrid = document.getElementById("statsGrid");
  const movementList = document.getElementById("movementList");
  let loading = false;
  let reloadPending = false;
  const filtros = {
    total: "",
    disponivel: "disponivel",
    uso: "em_uso",
    transfer: "em_transferencia",
    esgotado: "esgotado",
  };

  function renderStats(s) {
    const cards = [
      { key: "total", label: "Total de Barris", value: s.total, icon: icons.total },
      { key: "disponivel", label: "Disponíveis", value: s.disponiveis, icon: icons.disponivel },
      { key: "uso", label: "Em Uso", value: s.emUso, icon: icons.uso },
      { key: "transfer", label: "Em Transferência", value: s.emTransferencia, icon: icons.transfer },
      { key: "esgotado", label: "Vazios para recolher", value: s.vazios, icon: icons.esgotado },
    ];
    statsGrid.innerHTML = cards
      .map((c) => `<div class="col stat-col--${c.key}"><a class="stat-link" href="barris.html${filtros[c.key] ? `?status=${filtros[c.key]}` : ""}" aria-label="Ver ${c.value} barris: ${c.label}"><div class="stat-card stat-card--${c.key}">
          <span class="stat-icon">${c.icon}</span>
          <span class="stat-text"><span class="stat-value">${c.value}</span><span class="stat-label">${c.label}</span></span>
        </div></a></div>`)
      .join("");
  }

  function renderMovements(list) {
    if (!list.length) {
      movementList.innerHTML = `<p class="movement-empty">Nenhuma movimentação ainda. Cadastre o primeiro barril na aba Barris.</p>`;
      return;
    }
    movementList.innerHTML = list
      .map((m) => {
        const origem = m.origem || ctx.config.fornecedor;
        const route = (m.destino
          ? `${MC.esc(origem)} <span class="arrow">→</span> ${MC.esc(m.destino)}`
          : MC.esc(origem)) + (m.torneira_numero ? ` <span class="arrow">·</span> Torneira ${m.torneira_numero}` : "");
        return `<div class="movement-row">
          <div><span class="m-barril">#${MC.esc(m.codigo)}</span><span class="m-estilo">${MC.esc(MC.chopeLabel(m))}</span></div>
          <span class="op-badge op-badge--${m.operacao}">${MC.OP_LABELS[m.operacao]}</span>
          <span class="movement-route">${route}</span>
          <span class="movement-responsavel">${MC.esc(m.responsavel)}</span>
          <span class="movement-hora">${MC.fmtDate(m.criado_em)}</span>
        </div>`;
      })
      .join("");
  }

  async function load() {
    if (document.visibilityState === "hidden") return;
    if (loading) { reloadPending = true; return; }
    loading = true;
    const unit = ctx.units.find((u) => u.id === ctx.unitId);
    if (!unit) { loading = false; return; }
    document.getElementById("greetingTitle").textContent = `Olá, ${ctx.user.nome}`;
    document.getElementById("greetingText").textContent = `Confira o resumo da operação de ${unit.nome}.`;
    try {
      await MC.run(async () => {
        const data = await MC.call("dashboard:get", { unitId: ctx.unitId });
        renderStats(data.stats);
        renderMovements(data.movimentacoes);
      });
    } finally {
      loading = false;
      if (reloadPending) {
        reloadPending = false;
        load();
      }
    }
  }

  ctx.onUnitChange = load;
  load();
  window.setInterval(load, 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") load();
  });
})();
