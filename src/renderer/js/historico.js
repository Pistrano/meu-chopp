/* BarrilFacil — histórico completo, auditoria e relatório CSV */
(async () => {
  const ctx = await MCLayout.init("historico");
  if (!ctx) return;

  const tbody = document.getElementById("tbody");
  const q = document.getElementById("q");
  const operacao = document.getElementById("operacao");

  const filters = () => ({ unitId: ctx.unitId, q: q.value, operacao: operacao.value });

  async function load() {
    const list = await MC.run(() => MC.call("history:list", filters()));
    if (!list) return;
    tbody.innerHTML = list.length
      ? list.map((m) => {
          const origem = m.origem || ctx.config.fornecedor;
          const rota = m.destino ? `${MC.esc(origem)} → ${MC.esc(m.destino)}` : MC.esc(origem);
          return `<tr>
            <td>${MC.fmtDate(m.criado_em)}</td>
            <td><span class="t-strong">#${MC.esc(m.codigo)}</span><br><span class="t-muted">${MC.esc(MC.chopeLabel(m))}</span></td>
            <td><span class="op-badge op-badge--${m.operacao}">${MC.OP_LABELS[m.operacao]}</span></td>
            <td>${rota}</td><td>${m.torneira_numero ? `Torneira ${m.torneira_numero}` : '<span class="t-muted">—</span>'}</td><td>${MC.esc(m.responsavel)}</td><td class="t-muted">${MC.esc(m.observacao || "")}</td></tr>`;
        }).join("")
      : `<tr><td colspan="7" class="table-empty">Nenhuma movimentação encontrada com estes filtros.</td></tr>`;
  }

  async function loadAudit() {
    const list = await MC.run(() => MC.call("audit:list"));
    if (!list) return;
    document.getElementById("tbodyAud").innerHTML = list
      .map((a) => `<tr><td>${MC.fmtDate(a.criado_em)}</td><td class="t-strong">${MC.esc(a.usuario)}</td><td>${MC.esc(a.acao.replace(/_/g, " "))}</td><td class="t-muted">${MC.esc(a.detalhe || "")}</td></tr>`)
      .join("");
  }

  document.getElementById("btnExport").addEventListener("click", async () => {
    const r = await MC.run(() => MC.call("history:export", filters()));
    if (!r) return;
    // O servidor devolve o conteúdo; o próprio aparelho salva o arquivo (funciona em PC, tablet e celular)
    const url = URL.createObjectURL(new Blob([r.csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = r.filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    MC.toast(`Relatório gerado (${r.total} movimentações).`, "ok");
  });

  if (ctx.user.cargo === "admin") {
    const tabs = document.getElementById("tabs");
    tabs.classList.remove("d-none");
    tabs.addEventListener("click", (e) => {
      const b = e.target.closest("[data-tab]");
      if (!b) return;
      tabs.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      const aud = b.dataset.tab === "aud";
      document.getElementById("tabMov").classList.toggle("d-none", aud);
      document.getElementById("tabAud").classList.toggle("d-none", !aud);
      if (aud) loadAudit();
    });
  }

  let t;
  q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(load, 250); });
  operacao.addEventListener("change", load);
  ctx.onUnitChange = load;
  load();
})();
