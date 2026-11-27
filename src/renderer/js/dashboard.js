/* ==========================================================
   BarrilFacil — Painel
   Computador (1024 px ou mais): a saudação, os cinco cartões e as movimentações recentes.
   Celular e tablet (menos de 1024 px): uma tela de ações rápidas para o funcionário do quiosque. Faixa escura com a
   saudação, a unidade e Engatar, Retirar, Receber barris e Pesar; embaixo, a loja agora, o que precisa de atenção (os
   alertas do sino) e as últimas movimentações. O celular do quiosque é usado por qualquer funcionário: esta versão não
   mostra perda nem dinheiro, para nenhum cargo.
   As duas versões ficam na página e o CSS mostra uma ou a outra pela largura: girar o tablet troca sem recarregar.
   Os dados vêm de dashboard:get (os mesmos para as duas) e os alertas, do sino (evento "mc:alertas" de layout.js).
   ========================================================== */
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
          : MC.esc(origem)) + (m.torneira_numero ? ` <span class="arrow">·</span> Torneira ${m.torneira_numero}` : "") +
          (m.litros !== null && m.litros !== undefined ? ` <span class="arrow">·</span> ${m.estimado ? "≈ " : ""}${MC.fmtLitros(m.litros)}` : "");
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

  /* ---------- Celular e tablet ---------- */
  const unidadeAtual = () => ctx.units.find((u) => u.id === ctx.unitId);
  const pcLoja = document.getElementById("pcLoja");
  const pcAtencao = document.getElementById("pcAtencao");
  const pcMov = document.getElementById("pcMov");
  const pcUnidade = document.getElementById("pcUnidade");
  const pcUnidades = document.getElementById("pcUnidades");

  // A unidade na faixa: com mais de uma, troca por ali (a mesma troca do topo); com uma só, é só o nome
  function renderUnidade() {
    const unit = unidadeAtual();
    document.getElementById("pcOla").textContent = `Olá, ${ctx.user.nome}`;
    document.getElementById("pcUnidadeNome").textContent = unit ? unit.nome : "Unidade";
    const varias = ctx.units.length > 1;
    pcUnidade.classList.toggle("pc-unidade--varias", varias);
    if (varias) {
      pcUnidade.setAttribute("data-bs-toggle", "dropdown");
      pcUnidade.setAttribute("aria-label", `Unidade: ${unit ? unit.nome : ""}. Trocar de unidade`);
      pcUnidades.innerHTML = ctx.units.map((u) => `<li><button type="button" class="dropdown-item pc-unidade-opcao" data-unidade="${u.id}">
        <span class="unit-check">${u.id === ctx.unitId ? "✓" : ""}</span><span>${MC.esc(u.nome)}</span></button></li>`).join("");
    } else {
      pcUnidade.removeAttribute("data-bs-toggle");
      pcUnidade.removeAttribute("aria-expanded");
      pcUnidade.tabIndex = -1;
      pcUnidades.innerHTML = "";
    }
  }
  pcUnidades.addEventListener("click", (e) => {
    const b = e.target.closest("[data-unidade]");
    if (b && Number(b.dataset.unidade) !== ctx.unitId) MCLayout.selectUnit(Number(b.dataset.unidade));
  });

  // Sua loja agora: três linhas que abrem a aba Barris já filtrada
  function renderLoja(s) {
    const linhas = [
      { status: "disponivel", rotulo: "Disponíveis", valor: s.disponiveis, icone: icons.disponivel, cor: "ok" },
      { status: "em_uso", rotulo: "Engatados", valor: s.emUso, icone: icons.uso, cor: "info" },
      { status: "esgotado", rotulo: "Vazios para recolher", valor: s.vazios, icone: icons.esgotado, cor: "aviso" },
    ];
    pcLoja.innerHTML = linhas.map((l) => `<a class="pc-linha" href="barris.html?status=${l.status}" aria-label="${l.rotulo}: ${l.valor}. Ver na aba Barris">
        <span class="pc-ic pc-ic--${l.cor}">${l.icone}</span><span class="pc-linha-nome">${l.rotulo}</span>
        <b class="pc-num">${l.valor}</b><span class="pc-seta" aria-hidden="true">›</span></a>`).join("");
  }

  /* Precisa de atenção: os alertas do sino, na mesma ordem, com a etiqueta curta (cor pelo tipo; alertas.js no
     servidor). No máximo 5; o resto fica no sino ("e mais N" abre a lista). */
  const MAX_ATENCAO = 5;
  const COR_ALERTA = {
    vencido: "ruim", sem_estoque: "ruim", acabando: "aviso",
    vence_hoje: "info", vence_amanha: "info", transferencia_chegando: "info", transferencia_enviada: "info",
  };
  function renderAtencao(alerts) {
    if (!alerts.length) {
      pcAtencao.innerHTML = `<p class="pc-vazio pc-vazio--ok">${icons.disponivel}<span>Tudo em ordem por aqui.</span></p>`;
      return;
    }
    const resto = alerts.length - MAX_ATENCAO;
    pcAtencao.innerHTML = `<ul class="pc-lista">${alerts.slice(0, MAX_ATENCAO).map((a) => `<li title="${MC.esc(a.texto)}">
        <span class="pc-lista-txt"><b>${MC.esc(a.titulo || a.texto)}</b>${a.detalhe ? ` <span class="pc-detalhe">${MC.esc(a.detalhe)}</span>` : ""}</span>
        <span class="pc-pill pc-pill--${COR_ALERTA[a.tipo] || "neutro"}">${MC.esc(a.etiqueta || (a.nivel === "erro" ? "Atenção" : "Aviso"))}</span></li>`).join("")}</ul>` +
      (resto > 0 ? `<button type="button" class="pc-mais" data-alertas>e mais ${resto}</button>` : "");
  }
  pcAtencao.addEventListener("click", (e) => { if (e.target.closest("[data-alertas]")) MCLayout.abrirAlertas(); });
  document.addEventListener("mc:alertas", (e) => renderAtencao(e.detail || []));
  if (ctx.alertas) renderAtencao(ctx.alertas);

  /* Últimas movimentações: as 3 mais recentes, curtas (etiqueta, código, chope, detalhe e a hora) */
  const OP_CURTA = {
    utilizacao: "Engate", esgotado: "Retirada", retirada_com_chope: "Retirada", entrada: "Entrada",
    transferencia: "Transferência", recolhimento: "Recolhido",
  };
  function detalheMov(m) {
    if (m.operacao === "utilizacao") return m.torneira_numero ? `Torneira ${m.torneira_numero}` : "";
    if (m.operacao === "esgotado") return "vazio";
    if (m.operacao === "retirada_com_chope")
      return m.litros !== null && m.litros !== undefined ? `${m.estimado ? "≈ " : ""}${MC.fmtLitros(m.litros)}` : "com chope";
    if (m.operacao === "entrada") return m.origem || ctx.config.fornecedor;
    if (m.operacao === "transferencia") return m.destino ? `${m.origem || ""} → ${m.destino}` : m.origem || "";
    return "";
  }
  // "2026-11-26 15:42:10" -> "15:42" (hoje), "ontem" ou "24/11"
  function quandoCurto(s) {
    if (!s) return "";
    const dia = s.slice(0, 10);
    const hoje = ctx.config.hoje || "";
    if (dia === hoje) return s.slice(11, 16);
    if (hoje) {
      const d = new Date(`${hoje}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      if (dia === d.toISOString().slice(0, 10)) return "ontem";
    }
    return `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
  }
  function renderMovCelular(list) {
    if (!list.length) {
      pcMov.innerHTML = `<p class="pc-vazio">Nenhuma movimentação ainda.</p>`;
      return;
    }
    pcMov.innerHTML = `<ul class="pc-lista">${list.slice(0, 3).map((m) => {
      const det = detalheMov(m);
      return `<li><span class="op-badge op-badge--${m.operacao} pc-op">${OP_CURTA[m.operacao] || MC.OP_LABELS[m.operacao] || ""}</span>
        <span class="pc-lista-txt"><b>#${MC.esc(m.codigo)}</b> ${MC.esc(MC.chopeLabel(m))}${det ? ` · ${MC.esc(det)}` : ""}</span>
        <span class="pc-hora">${quandoCurto(m.criado_em)}</span></li>`;
    }).join("")}</ul>`;
  }

  /* ---------- As quatro ações (os mesmos fluxos das abas Torneiras e Barris) ---------- */
  let agindo = false;
  async function acao(fn) {
    if (agindo) return;
    agindo = true;
    try { await fn(); } finally { agindo = false; }
  }

  // Engatar: as torneiras livres da unidade e a janela da aba Torneiras (leitura da etiqueta primeiro)
  async function engatar() {
    const unit = unidadeAtual();
    const quadro = await MC.run(() => MC.call("taps:board", { unitId: ctx.unitId }));
    if (!quadro) return;
    const livres = quadro.torneiras.filter((t) => !t.ocupada);
    if (!livres.length) {
      await MC.notice({
        title: "Nenhuma torneira disponível",
        type: "err",
        text: "Não há torneiras disponíveis nesta unidade. Verifique as torneiras cadastradas ou libere uma torneira antes de continuar.",
        lines: [
          ["Unidade", unit.nome],
          ["Torneiras", quadro.torneiras.length ? `${quadro.torneiras.length} cadastrada(s), todas ocupadas` : "Nenhuma cadastrada"],
        ],
      });
      return;
    }
    const r = await MCBarril.janelaEngatar({ unitId: ctx.unitId, unidade: unit.nome, livres: livres.map((t) => ({ id: t.id, numero: t.numero })) });
    if (r !== null) load();
  }

  // Retirar: a pessoa escolhe a torneira com barril; depois, a mesma retirada das abas Barris e Torneiras
  function escolherTorneira(ocupadas, unidade) {
    return new Promise((resolve) => {
      const overlay = MC.openOverlay(`<h2>Retirar barril</h2>
        <p class="mc-modal-intro">Unidade: ${MC.esc(unidade)}. De qual torneira o barril saiu?</p>
        <div class="pc-torneiras" role="list">${ocupadas.map((t) => `
          <button type="button" class="pc-torneira" data-id="${t.id}" role="listitem" aria-label="Torneira ${t.numero}: ${MC.esc(MC.chopeLabel(t))}, barril ${MC.esc(t.codigo)}">
            <span class="pc-torneira-num">${t.numero}</span>
            <span class="pc-torneira-info"><b>${MC.esc(MC.chopeLabel(t) || "Chope")}</b>
              <span>#${MC.esc(t.codigo)}${t.tamanho_l ? ` · ${MC.esc(MC.fmtLitros(t.tamanho_l))}` : ""}${t.engatado_em ? ` · <span class="pc-sem-quebra">desde ${MC.fmtDate(t.engatado_em)}</span>` : ""}</span></span>
            <span class="pc-seta" aria-hidden="true">›</span>
          </button>`).join("")}</div>
        <div class="mc-modal-actions"><button type="button" class="btn-ghost" data-cancel>Cancelar</button></div>`);
      overlay.querySelector(".mc-modal").classList.add("mc-modal--retirar");
      const fechar = (t) => { overlay.remove(); resolve(t); };
      overlay.querySelector("[data-cancel]").addEventListener("click", () => fechar(null));
      overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") fechar(null); });
      overlay.querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", () => fechar(ocupadas.find((t) => t.id === Number(b.dataset.id)))));
      const primeiro = overlay.querySelector("[data-id]");
      if (primeiro && !window.matchMedia("(pointer: coarse)").matches) primeiro.focus();
    });
  }
  async function retirar() {
    const unit = unidadeAtual();
    const quadro = await MC.run(() => MC.call("taps:board", { unitId: ctx.unitId }));
    if (!quadro) return;
    const ocupadas = quadro.torneiras.filter((t) => t.ocupada);
    if (!ocupadas.length) {
      await MC.notice({ title: "Retirar barril", text: "Nenhum barril engatado nesta unidade.", type: "plain", buttonLabel: "Fechar" });
      return;
    }
    const t = await escolherTorneira(ocupadas, unit.nome);
    if (!t) return;
    try {
      await MCBarril.retirar({
        barril: { id: t.barril_id, codigo: t.codigo, tamanho_l: t.tamanho_l, torneira_numero: t.numero },
        unidade: unit.nome,
        unitId: ctx.unitId,
        aoRetirar: () => load(),
        fecharNoErro: true,
      });
    } catch (err) {
      // Outro aparelho já retirou ou trocou o barril: mostra o motivo e recarrega os números
      await MC.notice({ title: "Não foi possível retirar", text: err.message, type: "err" });
      load();
    }
  }

  document.querySelector(".pc-acoes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-acao]");
    if (!b) return;
    if (b.dataset.acao === "engatar") acao(engatar);
    else if (b.dataset.acao === "retirar") acao(retirar);
  });

  // Só para administrador e gerente: a unidade ainda não tem funcionários, então ninguém escolhe quem fez cada ação
  function renderAvisoFuncionarios(unidade) {
    const el = document.getElementById("avisoFuncionarios");
    el.classList.toggle("d-none", !unidade);
    el.innerHTML = unidade
      ? `Cadastre os funcionários de ${MC.esc(unidade)} em <a href="funcionarios.html">Mais &gt; Funcionários</a> para saber quem fez cada ação.`
      : "";
  }

  async function load() {
    if (document.visibilityState === "hidden") return;
    if (loading) { reloadPending = true; return; }
    loading = true;
    const unit = ctx.units.find((u) => u.id === ctx.unitId);
    if (!unit) { loading = false; return; }
    document.getElementById("greetingTitle").textContent = `Olá, ${ctx.user.nome}`;
    document.getElementById("greetingText").textContent = `Confira o resumo da operação de ${unit.nome}.`;
    renderUnidade();
    try {
      await MC.run(async () => {
        const data = await MC.call("dashboard:get", { unitId: ctx.unitId });
        renderStats(data.stats);
        renderMovements(data.movimentacoes);
        renderLoja(data.stats);
        renderMovCelular(data.movimentacoes);
        renderAvisoFuncionarios(data.semFuncionarios);
      });
    } finally {
      loading = false;
      if (reloadPending) {
        reloadPending = false;
        load();
      }
    }
  }

  ctx.onUnitChange = () => {
    pcAtencao.innerHTML = `<p class="pc-vazio">Carregando…</p>`; // os alertas da outra unidade chegam pelo sino
    load();
  };
  load();
  window.setInterval(load, 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") load();
  });
})();
