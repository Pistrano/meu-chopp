/* BarrilFacil — aba Torneiras: o que está engatado em cada torneira da unidade, engatar e retirar barril
   direto na torneira (fluxos compartilhados com a aba Barris em acoes-barril.js) e o histórico de cada uma */
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

  /* O cartão é um container com dois botões (não pode haver botão dentro de botão) */
  const botaoHistorico = (t) => `<button type="button" class="btn-ghost" data-act="historico" data-id="${t.id}" aria-label="Histórico da Torneira ${t.numero}">Histórico</button>`;

  function card(t) {
    if (!t.ocupada) {
      return `<article class="tap-card tap-card--free" aria-label="Torneira ${t.numero}, livre">
        <span class="tap-head"><span class="tap-num">Torneira ${t.numero}</span><span class="tap-free">· Livre</span></span>
        <div class="tap-actions">
          <button type="button" class="btn btn-mc btn-mc-sm" data-act="engatar" data-id="${t.id}" aria-label="Engatar barril na Torneira ${t.numero}">Engatar barril</button>
          ${botaoHistorico(t)}
        </div>
      </article>`;
    }
    const nome = MC.chopeLabel(t) || "Chope";
    return `<article class="tap-card tap-card--busy" aria-label="Torneira ${t.numero}, ocupada">
        <span class="tap-head"><span class="tap-num">Torneira ${t.numero}</span></span>
        <span class="tap-chope">${MC.esc(nome)}</span>
        <span class="tap-meta">#${MC.esc(t.codigo)}${t.tamanho_l ? ` · ${MC.esc(MC.fmtLitros(t.tamanho_l))}` : ""}</span>
        ${t.validade ? `<span class="tap-validade">Validade ${MC.fmtDia(t.validade)} ${MC.validadeBadge(t.situacao_validade)}</span>` : ""}
        <span class="tap-since">Engatado em ${diaHora(t.engatado_em)}${t.engatado_por ? ` por ${MC.esc(t.engatado_por)}` : ""}</span>
        <span class="tap-age">${desde(t.engatado_em_iso)}</span>
        <div class="tap-actions">
          <button type="button" class="btn-ghost btn-ghost--danger" data-act="retirar" data-id="${t.id}" aria-label="Retirar barril da Torneira ${t.numero}">Retirar barril</button>
          ${botaoHistorico(t)}
        </div>
      </article>`;
  }

  /* Celular (menos de 768 px): uma linha compacta por torneira, para caberem todas na tela. O cartão acima continua
     sendo o do computador e do tablet; o CSS mostra um ou outro. Os botões usam os mesmos data-act. */
  const ICON_HIST = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  function linha(t) {
    const hist = `<button type="button" class="tap-row-hist" data-act="historico" data-id="${t.id}" aria-label="Histórico da Torneira ${t.numero}" title="Histórico">${ICON_HIST}</button>`;
    if (!t.ocupada) {
      return `<div class="tap-row tap-row--free" role="listitem" aria-label="Torneira ${t.numero}, livre">
        <span class="tap-row-num" aria-hidden="true">${t.numero}</span>
        <span class="tap-row-info"><span class="tap-row-livre">Livre</span></span>
        <span class="tap-row-acoes">
          <button type="button" class="btn btn-mc btn-mc-sm tap-row-btn" data-act="engatar" data-id="${t.id}" aria-label="Engatar barril na Torneira ${t.numero}">Engatar barril</button>${hist}
        </span>
      </div>`;
    }
    const nome = MC.chopeLabel(t) || "Chope";
    return `<div class="tap-row tap-row--busy" role="listitem" aria-label="Torneira ${t.numero}, ${MC.esc(nome)}">
        <span class="tap-row-num" aria-hidden="true">${t.numero}</span>
        <span class="tap-row-info">
          <span class="tap-row-chope">${MC.esc(nome)}</span>
          <span class="tap-row-meta">#${MC.esc(t.codigo)}${t.tamanho_l ? ` · ${MC.esc(MC.fmtLitros(t.tamanho_l))}` : ""}${MC.validadeBadge(t.situacao_validade)}</span>
          <span class="tap-row-age">${desde(t.engatado_em_iso)}</span>
        </span>
        <span class="tap-row-acoes">
          <button type="button" class="btn-ghost btn-ghost--danger tap-row-btn" data-act="retirar" data-id="${t.id}" aria-label="Retirar barril da Torneira ${t.numero}">Retirar</button>${hist}
        </span>
      </div>`;
  }

  function render() {
    if (!taps.length) {
      const link = MC.pode("unidades")
        ? ` <a href="quiosques.html?id=${ctx.unitId}">Cadastrar torneiras desta unidade</a>.`
        : "";
      board.innerHTML = `<div class="panel tap-empty"><h2 class="panel-title">Nenhuma torneira cadastrada</h2>
        <p class="t-muted mb-0">Esta unidade ainda não tem torneiras. O administrador cadastra as torneiras na aba Unidades.${link}</p></div>`;
      return;
    }
    board.innerHTML = taps.map(card).join("") +
      `<div class="tap-rows" role="list" aria-label="Torneiras">${taps.map(linha).join("")}</div>`;
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
            ? `Retirado em ${diaHora(e.retirado_em)}${e.retirado_por ? ` por ${MC.esc(e.retirado_por)}` : ""} · ficou ${dur}`
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

  /* ---------- Engatar: ler a etiqueta ou escolher um barril disponível da unidade ----------
     A janela (leitura da etiqueta em cima, lista embaixo) é a MCBarril.janelaEngatar, a mesma do Painel do celular.
     Engatou, ou outro aparelho usou a torneira ou o barril enquanto a janela estava aberta (o motivo já apareceu):
     recarrega o quadro. */
  async function engatar(t) {
    const unit = ctx.units.find((u) => u.id === ctx.unitId);
    const r = await MCBarril.janelaEngatar({ unitId: ctx.unitId, unidade: unit.nome, torneira: t });
    if (r !== null) load();
  }

  // Outro aparelho usou a torneira ou o barril enquanto a janela estava aberta: mostra o motivo e recarrega o quadro
  async function falhou(titulo, err) {
    await MC.notice({ title: titulo, text: err.message, type: "err" });
    load();
  }

  /* ---------- Retirar: o mesmo diálogo e o mesmo aviso da aba Barris ---------- */
  async function retirar(t) {
    const unit = ctx.units.find((u) => u.id === ctx.unitId);
    try {
      await MCBarril.retirar({
        barril: { id: t.barril_id, codigo: t.codigo, tamanho_l: t.tamanho_l, torneira_numero: t.numero },
        unidade: unit.nome,
        unitId: ctx.unitId,
        aoRetirar: () => load(),
        fecharNoErro: true,
      });
    } catch (err) {
      await falhou("Não foi possível retirar", err);
    }
  }

  board.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const t = taps.find((x) => x.id === Number(btn.dataset.id));
    if (!t) return;
    if (btn.dataset.act === "engatar") engatar(t);
    else if (btn.dataset.act === "retirar") retirar(t);
    else historico(t.id);
  });

  // Atualiza quando a aba volta a ficar visível e a cada 60 segundos, mas não com uma janela aberta
  // (o quadro mudaria por trás da escolha da pessoa)
  const janelaAberta = () => !!document.querySelector(".mc-overlay");
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !janelaAberta()) load(true); });
  setInterval(() => { if (!document.hidden && !janelaAberta()) load(true); }, REFRESH_MS);

  ctx.onUnitChange = () => load();
  load();
})();
