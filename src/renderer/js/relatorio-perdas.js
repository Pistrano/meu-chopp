/* BarrilFacil — relatório de perdas: quanto saiu dos barris × quanto foi vendido no caixa entre dois inventários.
   A conta vem pronta do servidor (perdas:relatorio). Custo do litro e R$ só chegam para administrador e gerente
   (rel.dinheiro); para os outros cargos o servidor nem manda esses campos. */
(async () => {
  const ctx = await MCLayout.init("perdas");
  if (!ctx) return;

  const $ = (id) => document.getElementById(id);
  const fUnidade = $("fUnidade");
  const fDe = $("fDe");
  const fAte = $("fAte");
  const atalhos = $("atalhos");
  const erro = $("pdErro");
  const andamento = $("pdAndamento");
  const conteudo = $("pdConteudo");
  // Exportar CSV: o layout já tirou o botão de quem não tem a permissão "exportar"
  const btnCsv = $("btnCsv") || { disabled: true, addEventListener() {} };
  const esc = MC.esc;

  // Números como na página de teste: litros com 2 casas, % com 1, R$ em reais
  const L = (n) => `${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L`;
  const R = (n) => Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const P = (n) => `${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  // Datas do servidor: "AAAA-MM-DD HH:MM:SS" no fuso da operação
  const anoAtual = () => (ctx.config.hoje || new Date().toISOString()).slice(0, 4);
  const dia = (ts) => `${ts.slice(8, 10)}/${ts.slice(5, 7)}${ts.slice(0, 4) !== anoAtual() ? `/${ts.slice(0, 4)}` : ""}`;
  const hora = (ts) => ts.slice(11, 16);
  const quando = (ts) => `${dia(ts)} às ${hora(ts)}`;
  const traco = '<span class="t-muted">—</span>';
  const tag = (texto, tipo) => `<span class="pd-tag pd-tag--${tipo}">${esc(texto)}</span>`;
  const TAG_ESTIMADO = tag("estimado", "est");
  const classePerda = (n) => (Number(n) < 0 ? "pd-neg" : "pd-pos");

  fUnidade.innerHTML = ctx.units.map((u) => `<option value="${u.id}">${esc(u.nome)}</option>`).join("");
  fUnidade.value = String(ctx.unitId);
  document.querySelectorAll("[data-dinheiro]").forEach((el) => { el.hidden = !MC.pode("catalogo:editar"); });

  let lista = null;     // perdas:periodos da unidade: { inventarios (do mais novo ao mais velho), aberto, periodos }
  let cronologica = []; // inventários do mais velho para o mais novo (ordem dos campos De e Até)
  let rel = null;       // último relatório mostrado
  let pedido = 0;

  const unidadeId = () => Number(fUnidade.value);
  const nomeUnidade = () => (ctx.units.find((u) => u.id === unidadeId()) || {}).nome || "";
  const precisaInventarios = (mostrar) =>
    document.querySelectorAll("[data-precisa-inventarios]").forEach((el) => el.classList.toggle("d-none", !mostrar));

  function mostrarErro(msg) {
    erro.textContent = msg;
    erro.classList.toggle("d-none", !msg);
    fAte.classList.toggle("is-invalid", !!msg);
  }

  // Caixa azul: o período que ainda não entrou no relatório
  function mostrarAndamento() {
    const ultimo = lista.inventarios[0];
    const pesagem = '<a href="pesagem.html">Mais &gt; Pesagem</a>';
    const html = lista.aberto
      ? `Inventário em andamento desde <b>${esc(quando(lista.aberto.iniciado_em))}</b>. O período até ele entra no relatório quando ele for concluído (${pesagem}).`
      : ultimo
        ? `Período em andamento desde o inventário de <b>${esc(quando(ultimo.concluido_em))}</b>. Ele entra no relatório quando o próximo inventário for concluído (${pesagem}).`
        : "";
    andamento.innerHTML = html ? `<span>${html}</span>` : "";
    andamento.classList.toggle("d-none", !html);
  }

  // Atalhos "Entre inventários": o último período, até 4 seguidos anteriores e "Tudo" (do mais velho ao mais novo)
  function montarAtalhos() {
    const itens = lista.periodos.map((p, i) => ({
      de: p.inventario_de, ate: p.inventario_ate,
      texto: `${i === 0 ? "Último: " : ""}${dia(p.de)} a ${dia(p.ate)}`,
    }));
    if (cronologica.length > 2) {
      const a = cronologica[0], b = cronologica[cronologica.length - 1];
      itens.push({ de: a.id, ate: b.id, texto: `Tudo: ${dia(a.concluido_em)} a ${dia(b.concluido_em)}` });
    }
    atalhos.innerHTML = '<span class="pd-atalhos-rotulo">Entre inventários:</span>' + itens.map((x) =>
      `<button type="button" class="btn-ghost" data-de="${x.de}" data-ate="${x.ate}" aria-pressed="false">${esc(x.texto)}</button>`).join("");
  }
  function marcarAtalho() {
    atalhos.querySelectorAll("[data-de]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.de === fDe.value && b.dataset.ate === fAte.value)));
  }

  async function carregarUnidade() {
    const meu = ++pedido;
    rel = null;
    btnCsv.disabled = true;
    conteudo.innerHTML = '<p class="t-muted">Carregando…</p>';
    mostrarErro("");
    const r = await MC.run(() => MC.call("perdas:periodos", { unitId: unidadeId() }));
    if (meu !== pedido) return;
    if (!r) { conteudo.innerHTML = ""; return; }
    lista = r;
    cronologica = [...r.inventarios].reverse();
    mostrarAndamento();
    if (cronologica.length < 2) {
      precisaInventarios(false);
      conteudo.innerHTML = `<div class="panel pd-vazio"><p class="mb-0">O relatório aparece depois do segundo inventário completo.
        Faça o inventário em <a href="pesagem.html">Mais &gt; Pesagem</a>.</p></div>`;
      document.getElementById("printHead").innerHTML = "";
      return;
    }
    precisaInventarios(true);
    const opcoes = cronologica.map((i) => `<option value="${i.id}">${esc(dia(i.concluido_em))} (concluído às ${esc(hora(i.concluido_em))})</option>`).join("");
    fDe.innerHTML = opcoes;
    fAte.innerHTML = opcoes;
    // Abre no último período: os dois inventários mais novos
    fDe.value = String(cronologica[cronologica.length - 2].id);
    fAte.value = String(cronologica[cronologica.length - 1].id);
    montarAtalhos();
    carregar();
  }

  async function carregar() {
    marcarAtalho();
    const posDe = cronologica.findIndex((i) => String(i.id) === fDe.value);
    const posAte = cronologica.findIndex((i) => String(i.id) === fAte.value);
    if (posDe >= posAte) {
      pedido++;
      rel = null;
      btnCsv.disabled = true;
      mostrarErro("O inventário do fim tem de ser depois do inventário do início.");
      conteudo.innerHTML = "";
      return;
    }
    mostrarErro("");
    const meu = ++pedido;
    const filtros = { unitId: unidadeId(), inventarioDe: Number(fDe.value), inventarioAte: Number(fAte.value) };
    const r = await MC.run(() => MC.call("perdas:relatorio", filtros));
    if (meu !== pedido) return; // chegou a resposta de um filtro antigo
    if (!r) { conteudo.innerHTML = ""; return; }
    rel = { ...r, filtros };
    btnCsv.disabled = false;
    render();
  }

  // Cabeçalho da impressão e a linha do período
  function linhaPeriodo() {
    const texto = `De <b>${esc(quando(rel.de))}</b> até <b>${esc(quando(rel.ate))}</b> · ${esc(rel.unidade ? rel.unidade.nome : nomeUnidade())}`;
    document.getElementById("printHead").innerHTML =
      `<div class="rel-print-titulo">BarrilFacil</div><div>${texto}</div>`;
    return `<div class="pd-periodo"><span>${texto}</span>${rel.total.estimado && !rel.sem_vendas
      ? `<span class="pd-dica">Tem chope com ${TAG_ESTIMADO}: veja a nota embaixo.</span>` : ""}</div>`;
  }

  const linkVendas = () => (MC.pode("vendas")
    ? 'Importe a planilha em <a href="vendas-teknisa.html">Mais &gt; Vendas</a> e volte aqui.'
    : "Peça a um administrador ou gerente para importar a planilha em Mais &gt; Vendas.");

  function render() {
    const t = rel.total;
    const d = rel.dinheiro;
    let html = linhaPeriodo();

    if (rel.sem_vendas) {
      html += `<div class="pd-aviso" role="status"><b>Faltam as vendas deste período</b>
        <span>Não há vendas do caixa importadas de ${esc(dia(rel.de))} a ${esc(dia(rel.ate))} para esta unidade, então a perda não pode ser calculada. ${linkVendas()}</span>
        <span class="pd-dica">Saiu dos barris no período: ${esc(L(t.saiu))}.</span></div>`;
      conteudo.innerHTML = html;
      return;
    }

    if (rel.dias_sem_vendas.length) {
      html += `<div class="pd-aviso" role="status"><span>Faltam as vendas de ${esc(rel.dias_sem_vendas_texto)}: a perda aparece maior do que é.
        ${MC.pode("vendas") ? 'Importe em <a href="vendas-teknisa.html">Mais &gt; Vendas</a>.' : ""}</span></div>`;
    }

    const semPreco = d && t.sem_preco.length ? `Fora da conta (sem preço): ${t.sem_preco.join(", ")}` : "";
    html += `<div class="pd-resumo${d ? "" : " pd-resumo--3"}">
      <div class="pd-kpi"><small>Saiu dos barris</small><strong>${esc(L(t.saiu))}</strong><span>medido nos inventários</span></div>
      <div class="pd-kpi"><small>Vendido no caixa</small><strong>${esc(L(t.vendido))}</strong><span>vendas importadas</span></div>
      <div class="pd-kpi pd-kpi--perda ${classePerda(t.perda)}"><small>Perda</small><strong>${esc(L(t.perda))}</strong>
        <span>${t.pct === null ? "—" : `${esc(P(t.pct))} do que saiu`}</span></div>
      ${d ? `<div class="pd-kpi pd-kpi--perda ${classePerda(t.reais)}"><small>Perda em dinheiro</small>
        <strong>${t.reais === null ? "—" : esc(R(t.reais))}</strong><span>${esc(semPreco || "pelo custo do litro")}</span></div>` : ""}
    </div>`;

    const max = Math.max(0, ...rel.chopes.map((c) => Number(c.pct) || 0));
    const pctCelula = (c) => {
      if (c.pct === null) return traco;
      const w = c.pct > 0 && max > 0 ? Math.round((c.pct / max) * 100) : 0;
      return `<span class="pd-pct">${esc(P(c.pct))}<span class="pd-barra" aria-hidden="true"><i style="width:${w}%"></i></span></span>`;
    };
    const linhas = rel.chopes.map((c, i) => `<tr>
        <td><button type="button" class="pd-link" data-i="${i}">${esc(c.nome)}</button>${c.estimado ? TAG_ESTIMADO : ""}</td>
        <td>${esc(L(c.saiu))}</td><td>${esc(L(c.vendido))}</td>
        <td class="${classePerda(c.perda)}">${esc(L(c.perda))}</td>
        <td>${pctCelula(c)}</td>
        ${d ? `<td class="pd-col-custo">${c.custo_litro === null ? traco : esc(R(c.custo_litro))}</td>
          <td class="${c.sem_preco ? "" : classePerda(c.reais)}">${c.sem_preco ? '<span class="t-muted">sem preço</span>' : c.reais === null ? traco : esc(R(c.reais))}</td>` : ""}
      </tr>`).join("");
    html += `<div class="pd-tabela"><table class="pd-stack">
      <thead><tr><th>Chope</th><th>Saiu dos barris</th><th>Vendido</th><th>Perda</th><th>% do que saiu</th>
        ${d ? '<th class="pd-col-custo">Custo do litro</th><th>Perda em R$</th>' : ""}</tr></thead>
      <tbody>${linhas || `<tr><td colspan="${d ? 7 : 5}" class="pd-vazio-linha">Nenhum barril com chope mudou e nada foi vendido neste período.</td></tr>`}</tbody>
      <tfoot><tr><td>Total</td><td>${esc(L(t.saiu))}</td><td>${esc(L(t.vendido))}</td>
        <td class="${classePerda(t.perda)}">${esc(L(t.perda))}</td><td>${t.pct === null ? traco : esc(P(t.pct))}</td>
        ${d ? `<td class="pd-col-custo"></td><td class="${classePerda(t.reais)}">${t.reais === null ? traco : esc(R(t.reais))}</td>` : ""}</tr></tfoot>
    </table></div>`;
    html += `<p class="pd-nota"><span class="rel-dica">Toque no nome de um chope para ver barril por barril.</span>${d ? ""
      : " Valores em dinheiro aparecem só para administrador e gerente."}${semPreco ? ` ${esc(semPreco)}.` : ""}</p>`;
    conteudo.innerHTML = html;
    rotular(conteudo);
  }

  // No celular a tabela vira um cartão por linha: cada célula leva o nome da coluna (data-l)
  function rotular(el) {
    el.querySelectorAll("table.pd-stack").forEach((tb) => {
      const nomes = [...tb.querySelectorAll("thead th")].map((th) => th.textContent.trim());
      tb.querySelectorAll("tbody tr, tfoot tr").forEach((tr) =>
        [...tr.children].forEach((td, i) => { if (i > 0 && td.colSpan === 1) td.setAttribute("data-l", nomes[i]); }));
    });
  }

  // Janela "barril por barril" de um chope
  function detalhe(c) {
    const d = rel.dinheiro;
    const inicio = (b) => {
      const p = [];
      if (b.inicio !== null) p.push(`${esc(L(b.inicio))}${b.inicio_estimado ? TAG_ESTIMADO : ""}`);
      if (b.chegou) p.push(`${tag("chegou", "novo")}${esc(L(b.tamanho_l))}`);
      if (b.recebido !== null) p.push(`${tag(`recebido de ${b.recebido_de || "outra loja"}`, "transf")}${esc(L(b.recebido))}`);
      return p.join("<br>") || traco;
    };
    const fim = (b) => {
      const p = [];
      if (b.enviado !== null) p.push(`${tag(`enviado para ${b.enviado_para || "outra loja"}`, "transf")}${esc(L(b.enviado))}`);
      if (b.fim !== null) p.push(`${esc(L(b.fim))}${b.fim_estimado ? TAG_ESTIMADO : ""}`);
      else if (b.acabou) p.push("acabou");
      return p.join("<br>") || traco;
    };
    const linhas = c.barris.map((b) => `<tr>
        <td><b>#${esc(b.codigo)}</b> <span class="pd-dica">${esc(MC.fmtLitros(b.tamanho_l))}</span></td>
        <td>${inicio(b)}</td><td>${fim(b)}</td><td><b>${esc(L(b.saiu))}</b></td>
        ${d ? `<td class="pd-col-custo">${b.custo_litro === null ? '<span class="t-muted">sem preço</span>' : esc(R(b.custo_litro))}</td>` : ""}</tr>`).join("");
    const transf = c.barris.some((b) => b.recebido !== null || b.enviado !== null);
    const cls = classePerda(c.perda);
    const resumo = rel.sem_vendas ? "" : `<p class="mb-0">Vendido no caixa: <b>${esc(L(c.vendido))}</b> · Perda: <b class="${cls}">${esc(L(c.perda))}${c.pct === null ? "" : ` (${esc(P(c.pct))})`}</b>${
      d && !c.sem_preco && c.reais !== null ? ` · <b class="${cls}">${esc(R(c.reais))}</b>` : ""}${d && c.sem_preco ? ' · <span class="t-muted">sem preço</span>' : ""}</p>`;
    const negativa = !rel.sem_vendas && c.perda < 0
      ? `<p class="pd-nota">O caixa vendeu ${esc(L(-c.perda))} a mais do que saiu dos barris. ${c.estimado
        ? "Um barril foi medido a olho no inventário e devia ter menos do que foi anotado; a perda dele aparece no período seguinte. " : ""}Pesar na balança evita isso.</p>`
      : "";
    const html = `<p class="pd-dica pd-detalhe-periodo">Inventário de ${esc(quando(rel.de))} até o de ${esc(quando(rel.ate))}</p>
      ${c.barris.length ? `<div class="pd-tabela"><table class="pd-stack">
        <thead><tr><th>Barril</th><th>No início</th><th>No fim</th><th>Saiu</th>${d ? '<th class="pd-col-custo">Custo do litro</th>' : ""}</tr></thead>
        <tbody>${linhas}</tbody>
        <tfoot><tr><td>Saiu dos barris</td><td></td><td></td><td>${esc(L(c.saiu))}</td>${d ? '<td class="pd-col-custo"></td>' : ""}</tr></tfoot>
      </table></div>` : '<p class="t-muted mb-0">Nenhum barril deste chope mudou no período.</p>'}
      ${resumo}${negativa}
      <p class="pd-dica mb-0">"chegou" = barril que entrou cheio no período. "acabou" = saiu vazio da torneira antes do inventário do fim.${
        transf ? " \"recebido\" e \"enviado\" = transferência entre lojas, com o que o barril tinha na hora." : ""}</p>`;
    MC.notice({ title: c.nome, html, type: "plain", buttonLabel: "Fechar" });
    const modal = [...document.querySelectorAll(".mc-overlay .mc-modal")].pop(); // a janela que acabou de abrir
    if (!modal) return;
    modal.classList.add("mc-modal--perdas");
    if (c.estimado) modal.querySelector(".notice-title").insertAdjacentHTML("beforeend", ` ${TAG_ESTIMADO}`);
    rotular(modal);
    // Tocar fora da janela também fecha
    modal.parentElement.addEventListener("click", (e) => { if (e.target === modal.parentElement) modal.querySelector("#mcOk").click(); });
  }

  conteudo.addEventListener("click", (e) => {
    const btn = e.target.closest(".pd-link");
    if (btn && rel) detalhe(rel.chopes[Number(btn.dataset.i)]);
  });
  atalhos.addEventListener("click", (e) => {
    const b = e.target.closest("[data-de]");
    if (!b) return;
    fDe.value = b.dataset.de;
    fAte.value = b.dataset.ate;
    carregar();
  });
  fDe.addEventListener("change", carregar);
  fAte.addEventListener("change", carregar);
  fUnidade.addEventListener("change", carregarUnidade);
  ctx.onUnitChange = (id) => { fUnidade.value = String(id); carregarUnidade(); };

  btnCsv.addEventListener("click", async () => {
    if (!rel) return;
    const r = await MC.run(() => MC.call("perdas:csv", rel.filtros));
    if (!r) return;
    // O servidor devolve o conteúdo; o próprio aparelho salva o arquivo (funciona em PC, tablet e celular)
    const url = URL.createObjectURL(new Blob([r.csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = r.filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    MC.toast("Relatório exportado.", "ok");
  });
  $("btnPrint").addEventListener("click", () => window.print());

  carregarUnidade();
})();
