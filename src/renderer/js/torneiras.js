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

  /* ---------- Engatar: ler a etiqueta ou escolher um barril disponível da unidade ---------- */
  const semAcento = (v) => String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  // Outro aparelho usou a torneira ou o barril enquanto a janela estava aberta: mostra o motivo e recarrega o quadro
  async function falhou(titulo, err) {
    await MC.notice({ title: titulo, text: err.message, type: "err" });
    load();
  }

  /* No topo, a leitura da etiqueta (câmera, pistola ou digitação, em leitor-codigo.js); embaixo, a lista com busca de
     sempre, como alternativa (no celular ela começa fechada). O barril lido ou escolhido na lista segue o mesmo fluxo:
     "Quem está fazendo?", aviso de vencido e barris:use (MCBarril.engatar). */
  async function engatar(t) {
    const lista = await MC.run(() => MC.call("barris:list", { unitId: ctx.unitId, status: "disponivel" }));
    if (!lista) return;
    if (!lista.length) {
      await MC.notice({
        title: "Nenhum barril disponível nesta unidade",
        text: "Cadastre o barril (ou confirme a transferência que chegou) na aba Barris e volte para engatar.",
        html: '<p class="mb-0"><a href="barris.html">Ir para a aba Barris</a></p>',
        type: "plain",
        buttonLabel: "Fechar",
      });
      return;
    }
    // Vence primeiro em cima; sem validade (barris antigos) no fim
    const barris = [...lista].sort((a, b) =>
      (a.validade || "9999-99-99").localeCompare(b.validade || "9999-99-99") || String(a.codigo).localeCompare(String(b.codigo), "pt-BR", { numeric: true }));
    const unit = ctx.units.find((u) => u.id === ctx.unitId);
    const funcionario = await MC.escolherFuncionario(ctx.unitId);
    const celular = window.matchMedia("(max-width: 767.98px)").matches;
    const overlay = MC.openOverlay(`<h2>Engatar na Torneira ${t.numero}</h2>
      <p class="mc-modal-intro">Unidade: ${MC.esc(unit.nome)}. Leia a etiqueta do barril ou escolha da lista.</p>
      <div id="engLeitor"></div>
      <details class="eng-lista-box"${celular ? "" : " open"}>
        <summary>Escolher da lista <span class="t-muted">(${barris.length} ${barris.length === 1 ? "disponível" : "disponíveis"})</span></summary>
        <input type="search" class="form-control mb-3" id="engBusca" placeholder="Buscar por código ou chope" aria-label="Buscar barril por código ou chope" autocomplete="off">
        <div class="eng-list" role="radiogroup" aria-label="Barris disponíveis">${barris.map((b) => `
          <label class="eng-item" data-busca="${MC.esc(semAcento(`${b.codigo} ${MC.chopeLabel(b)}`))}">
            <input type="radio" name="engBarril" value="${b.id}"${barris.length === 1 ? " checked" : ""}>
            <span class="eng-main">#${MC.esc(b.codigo)} <span class="eng-size">· ${MC.esc(MC.fmtLitros(b.tamanho_l))}</span></span>
            <span class="eng-chope">${MC.esc(MC.chopeLabel(b))}</span>
            <span class="eng-validade">${b.validade ? `Validade ${MC.fmtDia(b.validade)}` : "Sem validade informada"} ${MC.validadeBadge(b.situacao_validade)}${MC.saldoTexto(b) ? ` <span class="op-badge op-badge--disponivel">${MC.esc(MC.statusTexto(b))}</span>` : ""}</span>
          </label>`).join("")}</div>
        <p class="t-muted small-note eng-nada d-none" id="engNada">Nenhum barril encontrado com essa busca.</p>
      </details>
      ${funcionario ? `<div class="mt-3">${funcionario.html}</div>` : ""}
      <div class="field-error" id="engErr" aria-live="polite"></div>
      <div class="mc-modal-actions"><button type="button" class="btn-ghost" data-cancel>Cancelar</button>
        <button type="button" class="btn btn-mc btn-mc-sm eng-ok" data-ok${funcionario ? " disabled" : ""}>Engatar na Torneira ${t.numero}</button></div>`);
    overlay.querySelector(".mc-modal").classList.add("mc-modal--engate");
    const caixaLista = overlay.querySelector(".eng-lista-box");
    const busca = overlay.querySelector("#engBusca");
    const itens = [...overlay.querySelectorAll(".eng-item")];
    const erro = overlay.querySelector("#engErr");
    const okBtn = overlay.querySelector("[data-ok]");
    if (funcionario) funcionario.ligar(overlay, () => { okBtn.disabled = false; erro.textContent = ""; });

    // O barril escolhido: o lido na etiqueta ou o marcado na lista (o último que a pessoa fez vale)
    let escolhido = barris.length === 1 ? barris[0].id : null;
    const marcar = (id) => itens.forEach((it) => { const r = it.querySelector("input"); r.checked = Number(r.value) === id; });
    const filtrar = () => {
      const termo = semAcento(busca.value.replace("#", "").trim());
      let visiveis = 0;
      itens.forEach((it) => {
        const mostra = !termo || it.dataset.busca.includes(termo);
        it.classList.toggle("d-none", !mostra);
        if (mostra) visiveis += 1;
        else if (it.querySelector("input").checked) { it.querySelector("input").checked = false; escolhido = null; } // não engata um barril que a busca escondeu
      });
      overlay.querySelector("#engNada").classList.toggle("d-none", visiveis > 0);
    };

    const leitor = MCLeitor.montar(overlay.querySelector("#engLeitor"), {
      unitId: () => ctx.unitId,
      aoAchar: (b) => {
        erro.textContent = "";
        const porque = MCLeitor.motivo(b, { unitId: ctx.unitId, acao: "engatar" });
        if (porque) { escolhido = null; marcar(null); leitor.erro(porque); return; }
        escolhido = b.id;
        busca.value = "";
        filtrar();
        marcar(b.id);
        if (celular) caixaLista.open = false; // no celular, o botão de engatar fica logo embaixo
        leitor.mostrar(MCLeitor.cartaoAchado(b));
        if (window.matchMedia("(pointer: coarse)").matches && document.activeElement) document.activeElement.blur(); // fecha o teclado
        (funcionario && !funcionario.id ? overlay.querySelector(".func-pick") : okBtn).scrollIntoView({ block: "nearest", behavior: "smooth" });
      },
    });

    await new Promise((resolve) => {
      const fechar = () => { leitor.destruir(); overlay.remove(); resolve(); };
      busca.addEventListener("input", filtrar);
      itens.forEach((it) => it.querySelector("input").addEventListener("change", (e) => {
        escolhido = Number(e.target.value);
        leitor.limpar(); // o cartão do barril lido não vale mais
        erro.textContent = "";
      }));
      overlay.querySelector("[data-cancel]").addEventListener("click", fechar);
      overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") fechar(); });
      okBtn.addEventListener("click", async () => {
        if (!escolhido) { erro.textContent = "Leia a etiqueta do barril ou escolha o barril na lista."; return; }
        if (funcionario && !funcionario.id) { erro.textContent = "Toque no seu nome em \"Quem está fazendo?\"."; return; }
        erro.textContent = "";
        okBtn.disabled = true;
        leitor.parar();
        try {
          const r = await MCBarril.engatar({ barrilId: escolhido, torneiraId: t.id, unitId: ctx.unitId, funcionario });
          if (r === false) { okBtn.disabled = false; return; } // desistiu do barril vencido: escolhe outro
          fechar();
          load();
        } catch (err) {
          fechar();
          await falhou("Não foi possível engatar", err);
        }
      });
    });
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
