/* BarrilFacil — aba Torneiras: o que está engatado em cada torneira da unidade e o histórico de cada uma */
(async () => {
  const ctx = await MCLayout.init("torneiras");
  if (!ctx) return;

  const board = document.getElementById("board");
  const REFRESH_MS = 60 * 1000;
  let taps = [];
  let skew = 0; // diferença entre o relógio do servidor e o do aparelho
  const agora = () => Date.now() + skew;
  const syncClock = (serverIso) => { if (serverIso) skew = new Date(serverIso).getTime() - Date.now(); };

  /* 2 dias e 3 h · 3 h e 20 min · 15 min */
  function duracao(ms) {
    const min = Math.max(0, Math.floor(ms / 60000));
    const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
    const dias = `${d} dia${d === 1 ? "" : "s"}`;
    if (d) return h ? `${dias} e ${h} h` : dias;
    if (h) return m ? `${h} h e ${m} min` : `${h} h`;
    return min ? `${m} min` : "menos de 1 min";
  }
  const desde = (iso) => (iso ? `há ${duracao(agora() - new Date(iso).getTime())}` : "");

  /* "2026-10-06 14:32:10" -> "06/10 às 14:32" */
  function diaHora(s) {
    if (!s) return "";
    const [dia, hora] = MC.fmtDate(s).split(" ");
    return `${dia} às ${hora}`;
  }

  function card(t) {
    if (!t.ocupada) {
      return `<button type="button" class="tap-card tap-card--free" data-id="${t.id}">
        <span class="tap-head"><span class="tap-num">Torneira ${t.numero}</span><span class="tap-free">· Livre</span></span>
        <span class="tap-hint">Toque para ver o histórico</span>
      </button>`;
    }
    const nome = t.chope_nome || t.estilo || "Chope";
    return `<button type="button" class="tap-card tap-card--busy" data-id="${t.id}">
        <span class="tap-head"><span class="tap-num">Torneira ${t.numero}</span></span>
        <span class="tap-chope">${MC.esc(nome)}</span>
        ${t.chope_nome && t.estilo ? `<span class="tap-estilo">${MC.esc(t.estilo)}</span>` : ""}
        <span class="tap-meta">#${MC.esc(t.codigo)}${t.tamanho_l ? ` · ${t.tamanho_l} L` : ""}</span>
        ${t.validade ? `<span class="tap-validade">Validade ${MC.fmtDia(t.validade)} ${MC.validadeBadge(t.situacao_validade)}</span>` : ""}
        <span class="tap-since">Engatado em ${diaHora(t.engatado_em)}${t.engatado_por ? ` por ${MC.esc(t.engatado_por)}` : ""}</span>
        <span class="tap-age">${desde(t.engatado_em_iso)}</span>
      </button>`;
  }

  function render() {
    if (!taps.length) {
      const link = ctx.user.cargo === "admin"
        ? ` <a href="quiosques.html?id=${ctx.unitId}">Cadastrar torneiras desta unidade</a>.`
        : "";
      board.innerHTML = `<div class="panel tap-empty"><h2 class="panel-title">Nenhuma torneira cadastrada</h2>
        <p class="t-muted mb-0">Esta unidade ainda não tem torneiras. O administrador cadastra as torneiras na aba Unidades.${link}</p></div>`;
      return;
    }
    board.innerHTML = taps.map(card).join("");
  }

  /* silencioso = atualização automática: se falhar, mantém o que já está na tela sem mostrar erro */
  async function load(silencioso = false) {
    const unit = ctx.units.find((u) => u.id === ctx.unitId);
    document.getElementById("subtitle").textContent = `O que está engatado em cada torneira de ${unit.nome}.`;
    let data;
    try {
      data = await MC.call("taps:board", { unitId: ctx.unitId });
    } catch (e) {
      if (!silencioso) MC.toast(e.message, "err");
      return;
    }
    syncClock(data.agora);
    taps = data.torneiras;
    render();
    const now = new Date();
    document.getElementById("updated").textContent =
      `Atualizado às ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }

  /* ---------- Histórico da torneira ---------- */
  async function historico(id) {
    const t = taps.find((x) => x.id === id);
    const data = await MC.run(() => MC.call("taps:history", { torneiraId: id }));
    if (!data) return;
    syncClock(data.agora);
    const itens = data.engates.map((e) => {
      const fim = e.retirado_em_iso ? new Date(e.retirado_em_iso).getTime() : agora();
      const dur = duracao(fim - new Date(e.engatado_em_iso).getTime());
      const chope = MC.chopeLabel(e) || "—";
      return `<li class="${e.retirado_em ? "" : "is-current"}">
          <div class="th-title">#${MC.esc(e.codigo)} <span class="th-chope">${MC.esc(chope)}</span></div>
          <div class="th-line">Engatado em ${diaHora(e.engatado_em)}${e.engatado_por ? ` por ${MC.esc(e.engatado_por)}` : ""}</div>
          <div class="th-line">${e.retirado_em
            ? `Retirado em ${diaHora(e.retirado_em)} · ficou ${dur}`
            : `<strong>Engatado agora</strong> · há ${dur}`}</div>
        </li>`;
    });
    const html = itens.length
      ? `<ol class="tap-history">${itens.join("")}</ol>` +
        (itens.length >= 50 ? `<p class="t-muted small-note tap-history-note">Mostrando os 50 engates mais recentes.</p>` : "")
      : `<p class="mc-modal-intro">Nenhum barril foi engatado nesta torneira ainda.</p>`;
    await MC.notice({
      title: `Histórico da Torneira ${data.torneira.numero}`,
      text: t && t.ocupada ? "" : "A torneira está livre agora.",
      html,
      type: "plain",
      buttonLabel: "Fechar",
    });
  }

  board.addEventListener("click", (e) => {
    const btn = e.target.closest(".tap-card");
    if (btn) historico(Number(btn.dataset.id));
  });

  // Atualiza quando a aba volta a ficar visível e a cada 60 segundos
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(true); });
  setInterval(() => { if (!document.hidden) load(true); }, REFRESH_MS);

  ctx.onUnitChange = () => load();
  load();
})();
