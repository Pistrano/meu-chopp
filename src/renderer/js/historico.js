/* BarrilFacil — histórico completo, auditoria e relatório CSV */
(async () => {
  const ctx = await MCLayout.init("historico");
  if (!ctx) return;

  const tbody = document.getElementById("tbody");
  const q = document.getElementById("q");
  const operacao = document.getElementById("operacao");
  const funcionario = document.getElementById("funcionario");

  const filters = () => ({ unitId: ctx.unitId, q: q.value, operacao: operacao.value, funcionarioId: Number(funcionario.value) || undefined });

  /* Filtro por funcionário: os da unidade aberta (quem cadastra vê também os desativados, que continuam no histórico) */
  async function loadFuncionarios() {
    const atual = funcionario.value;
    const lista = (await MC.run(() => MC.call("funcionarios:list", { unitId: ctx.unitId }))) || [];
    funcionario.innerHTML = `<option value="">Todos os funcionários</option>` +
      lista.map((f) => `<option value="${f.id}">${MC.esc(f.nome)}${f.ativo === 0 ? " (desativado)" : ""}</option>`).join("");
    funcionario.value = lista.some((f) => String(f.id) === atual) ? atual : "";
  }

  // Busca e filtros lembrados ao trocar de aba; colunas ordenam ao clicar no título (sobre as linhas carregadas)
  MC.rememberFields("historico", { q, operacao });
  let movs = [];
  const sorter = MC.sortable(document.querySelector("#tabMov table"), {
    0: (m) => m.criado_em, 1: (m) => m.codigo, 2: (m) => MC.OP_LABELS[m.operacao],
    3: (m) => m.origem || ctx.config.fornecedor, 4: (m) => m.torneira_numero, 5: (m) => m.responsavel,
  }, { key: "historico", onChange: () => render() });

  function render() {
    const list = sorter.apply(movs);
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

  async function load() {
    const list = await MC.run(() => MC.call("history:list", filters()));
    if (!list) return;
    movs = list;
    render();
  }

  async function loadAudit() {
    const list = await MC.run(() => MC.call("audit:list"));
    if (!list) return;
    document.getElementById("tbodyAud").innerHTML = list
      .map((a) => `<tr><td>${MC.fmtDate(a.criado_em)}</td><td class="t-strong">${MC.esc(a.usuario)}</td><td>${MC.esc(a.acao.replace(/_/g, " "))}</td><td class="t-muted">${MC.esc(a.detalhe || "")}</td></tr>`)
      .join("");
  }

  document.getElementById("btnExport")?.addEventListener("click", async () => {
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

  if (MC.pode("auditoria")) {
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
  funcionario.addEventListener("change", load);
  ctx.onUnitChange = async () => { await loadFuncionarios(); load(); };
  await loadFuncionarios();
  load();
})();
