/* BarrilFacil — relatório de barris: uso por estilo e chope num período, mais a situação agora.
   Os números vêm prontos do servidor, contados por barril (o código se repete depois do recolhimento). */
(async () => {
  const ctx = await MCLayout.init("relatorio");
  if (!ctx) return;

  const fUnidade = document.getElementById("fUnidade");
  const fDe = document.getElementById("fDe");
  const fAte = document.getElementById("fAte");
  const atalhos = document.getElementById("atalhos");
  const erro = document.getElementById("relErro");
  const tbody = document.getElementById("relBody");

  // Datas "AAAA-MM-DD". O "hoje" vem do servidor, no fuso da operação (nunca o relógio do aparelho em UTC)
  const somaDias = (dia, n) => {
    const d = new Date(`${dia}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const PERIODOS = {
    "hoje": (h) => [h, h],
    "7-dias": (h) => [somaDias(h, -6), h],
    "este-mes": (h) => [`${h.slice(0, 8)}01`, h],
    "mes-passado": (h) => { const fim = somaDias(`${h.slice(0, 8)}01`, -1); return [`${fim.slice(0, 8)}01`, fim]; },
  };
  const hoje = () => ctx.config.hoje || new Date().toISOString().slice(0, 10);
  const diaHora = (s) => (s ? `${MC.fmtDia(s.slice(0, 10))} ${s.slice(11, 16)}` : ""); // "2026-10-02 14:05:00" -> "02/10/2026 14:05"
  const periodoTexto = (de, ate) => (de === ate ? `dia ${MC.fmtDia(de)}` : `${MC.fmtDia(de)} a ${MC.fmtDia(ate)}`);

  // Unidade: a atual do cabeçalho, ou todas as liberadas para quem tem mais de uma
  fUnidade.innerHTML = ctx.units.map((u) => `<option value="${u.id}">${MC.esc(u.nome)}</option>`).join("") +
    (ctx.units.length > 1 ? '<option value="">Todas as minhas unidades</option>' : "");
  fUnidade.value = String(ctx.unitId);

  // Abre em "Este mês" (o atalho do Painel manda ?periodo=este-mes)
  const pedidoUrl = new URLSearchParams(location.search).get("periodo");
  const inicial = pedidoUrl && Object.prototype.hasOwnProperty.call(PERIODOS, pedidoUrl) ? pedidoUrl : "este-mes";
  [fDe.value, fAte.value] = PERIODOS[inicial](hoje());

  const filtros = () => ({ unidadeId: fUnidade.value ? Number(fUnidade.value) : null, de: fDe.value, ate: fAte.value });

  function validar({ de, ate }) {
    if (!de || !ate) return "Informe as datas De e Até do período.";
    if (de > ate) return "A data De não pode ser depois da data Até.";
    const dias = (Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86400000 + 1;
    if (dias > 400) return "Escolha um período de até 400 dias.";
    return "";
  }

  function marcarAtalho() {
    atalhos.querySelectorAll("[data-periodo]").forEach((b) => {
      const [de, ate] = PERIODOS[b.dataset.periodo](hoje());
      b.setAttribute("aria-pressed", String(fDe.value === de && fAte.value === ate));
    });
  }

  // Colunas: posição na tabela = posição em COLS + 1 (a primeira é o nome)
  const COLS = ["recebidos", "utilizados", "litros", "esvaziados", "recolhidos", "estoque", "engatados", "vazios", "em_transferencia"];
  const sorter = MC.sortable(document.getElementById("relTable"),
    Object.fromEntries([[0, (r) => r.nome], ...COLS.map((k, i) => [i + 1, (r) => r[k]])]),
    { key: "relatorio-barris", onChange: () => render() });

  const num = (n) => (n ? n.toLocaleString("pt-BR") : '<span class="t-muted">0</span>');
  const celulas = (r) => COLS.map((k, i) =>
    `<td class="rel-num${i >= 5 ? " rel-agora" : ""}${i === 5 ? " rel-agora--ini" : ""}">${num(r[k])}</td>`).join("");

  let rel = null;          // último relatório carregado (com os filtros usados nele)
  let chopes = new Map();  // chave da linha -> chope (para abrir o detalhe)
  let pedido = 0;

  function render() {
    if (!rel) return;
    const grupos = sorter.apply(rel.grupos);
    tbody.innerHTML = grupos.length
      ? grupos.map((g) => `<tr class="rel-estilo"><td><span class="rel-estilo-nome">${MC.esc(g.nome)}</span> <span class="rel-sub">total do estilo</span></td>${celulas(g)}</tr>` +
          sorter.apply(g.chopes).map((c) =>
            `<tr class="rel-chope"><td><button type="button" class="rel-link" data-key="${c.key}" title="Ver os barris utilizados">${MC.esc(c.nome)}</button></td>${celulas(c)}</tr>`).join(""))
        .join("") + `<tr class="rel-total"><td>Total geral</td>${celulas(rel.total)}</tr>`
      : `<tr><td colspan="10" class="table-empty">Nenhum barril com movimento neste período, e nenhum na unidade agora.</td></tr>`;
  }

  function mostrarCabecalho() {
    const periodo = periodoTexto(rel.de, rel.ate);
    const situacao = rel.geradoEm ? `Situação às ${rel.geradoEm.slice(11, 16)} de ${MC.fmtDia(rel.geradoEm.slice(0, 10)).slice(0, 5)}` : "Situação agora";
    document.getElementById("relPeriodo").textContent = `${rel.unidade} · ${periodo}`;
    document.getElementById("relSituacao").textContent = situacao;
    document.getElementById("faixaAgora").textContent = situacao;
    document.getElementById("printHead").innerHTML =
      `<div class="rel-print-titulo">BarrilFacil</div>
       <div>Unidade: <strong>${MC.esc(rel.unidade)}</strong> · Período: <strong>${MC.esc(periodo)}</strong> · ${MC.esc(situacao)}</div>`;
  }

  async function carregar() {
    marcarAtalho();
    const f = filtros();
    const msg = validar(f);
    erro.textContent = msg;
    erro.classList.toggle("d-none", !msg);
    if (msg) return;
    const meu = ++pedido;
    const r = await MC.run(() => MC.call("reports:barrels", f));
    if (meu !== pedido || !r) return; // chegou a resposta de um filtro antigo
    chopes = new Map();
    r.grupos = r.grupos.map((g, i) => ({
      nome: g.estilo, ...g.total,
      chopes: g.chopes.map((c, j) => {
        const linha = { ...c, nome: c.chope, estilo: g.estilo, key: `${i}-${j}` };
        chopes.set(linha.key, linha);
        return linha;
      }),
    }));
    rel = { ...r, filtros: f };
    mostrarCabecalho();
    render();
  }

  // Detalhe: os barris do chope que tiveram o primeiro engate no período
  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest(".rel-link");
    const c = btn && chopes.get(btn.dataset.key);
    if (!c) return;
    const lista = await MC.run(() => MC.call("reports:barrelsDetail", { ...rel.filtros, ...c.chave }));
    if (!lista) return;
    const todas = rel.filtros.unidadeId === null;
    // Quem engatou e, se foi outra pessoa, quem retirou (o funcionário escolhido ou o usuário da conta)
    const funcionario = (b) => !b.engatado_por ? '<span class="t-muted">—</span>'
      : b.retirado_por && b.retirado_por !== b.engatado_por
        ? `${MC.esc(b.engatado_por)} <span class="t-muted">(engate)</span><br>${MC.esc(b.retirado_por)} <span class="t-muted">(retirada)</span>`
        : MC.esc(b.engatado_por);
    const linhas = lista.map((b) => `<tr>
        <td data-label="Barril" class="t-strong">#${MC.esc(b.codigo)}</td>
        <td data-label="Tamanho">${MC.esc(b.tamanho_l)} L</td>
        <td data-label="Validade">${b.validade ? MC.fmtDia(b.validade) : '<span class="t-muted">—</span>'}</td>
        <td data-label="Engatado em">${diaHora(b.engatado_em)}</td>
        <td data-label="Retirado em">${b.retirado_em ? diaHora(b.retirado_em) : '<span class="op-badge op-badge--em_uso">ainda engatado</span>'}</td>
        <td data-label="Torneira">${b.torneira ? `Torneira ${MC.esc(b.torneira)}` : '<span class="t-muted">—</span>'}</td>
        ${todas ? `<td data-label="Unidade">${MC.esc(b.unidade || "")}</td>` : ""}
        <td data-label="Funcionário">${funcionario(b)}</td></tr>`).join("");
    const html = lista.length
      ? `<div class="table-card rel-detalhe"><table>
          <thead><tr><th>Barril</th><th>Tamanho</th><th>Validade</th><th>Engatado em</th><th>Retirado em</th><th>Torneira</th>${todas ? "<th>Unidade</th>" : ""}<th>Funcionário</th></tr></thead>
          <tbody>${linhas}</tbody></table></div>`
      : '<p class="t-muted mb-0">Nenhum barril deste chope foi engatado pela primeira vez neste período.</p>';
    const total = lista.length === 1 ? "1 barril utilizado" : `${lista.length} barris utilizados`;
    MC.notice({ title: c.nome, text: `${c.estilo} · ${total} · ${periodoTexto(rel.de, rel.ate)} · ${rel.unidade}`, html, type: "plain", buttonLabel: "Fechar" });
    const modal = [...document.querySelectorAll(".mc-overlay .mc-modal")].pop(); // a janela que acabou de abrir
    if (modal) modal.classList.add("mc-modal--rel");
  });

  atalhos.addEventListener("click", (e) => {
    const b = e.target.closest("[data-periodo]");
    if (!b) return;
    [fDe.value, fAte.value] = PERIODOS[b.dataset.periodo](hoje());
    carregar();
  });
  fUnidade.addEventListener("change", carregar);
  fDe.addEventListener("change", carregar);
  fAte.addEventListener("change", carregar);
  ctx.onUnitChange = (id) => { fUnidade.value = String(id); carregar(); };

  document.getElementById("btnCsv")?.addEventListener("click", async () => {
    if (!rel) return;
    const r = await MC.run(() => MC.call("reports:barrelsExport", rel.filtros));
    if (!r) return;
    // O servidor devolve o conteúdo; o próprio aparelho salva o arquivo (funciona em PC, tablet e celular)
    const url = URL.createObjectURL(new Blob([r.csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = r.filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    MC.toast("Relatório exportado.", "ok");
  });
  document.getElementById("btnPrint").addEventListener("click", () => window.print());

  carregar();
})();
