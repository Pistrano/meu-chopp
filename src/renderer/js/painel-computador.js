/* ==========================================================
   BarrilFacil — Painel do computador (1024 px ou mais): desenha a resposta de dashboard:computador
   De cima para baixo: perda em dinheiro e em litros do período (com a diferença para o inventário anterior), o gráfico
   "Litros perdidos a cada inventário" (saiu × vendido, um ponto por período), o estoque por chope, as movimentações
   recentes e os chopes que mais saíram. Os gráficos são SVG feitos aqui, com as cores do tema.
   O dinheiro só chega do servidor para quem tem "catalogo:editar" (d.dinheiro); a perda NÃO é calculada aqui.
   Uso (dashboard.js): MCPainelComputador.render(dados, { ctx, aoEscolher(inventarioId) }).
   ========================================================== */
window.MCPainelComputador = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => MC.esc(s);

  // Números como no Relatório de perdas: litros com 2 casas, % com 1, R$ em reais
  const L = (n) => `${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L`;
  const R = (n) => Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const P = (n) => `${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const PP = (n) => `${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} p.p.`;
  // "AAAA-MM-DD HH:MM:SS" (fuso da operação) -> "16/11"
  const dia = (ts) => `${ts.slice(8, 10)}/${ts.slice(5, 7)}`;
  const periodoTexto = (p) => `${dia(p.de)} a ${dia(p.ate)}`;

  let ctx = null;
  let aoEscolher = () => {};

  /* ---------- Escolha do inventário (a lista e os pontos do gráfico trocam o Painel inteiro) ---------- */
  const fPeriodo = $("ppPeriodo");
  fPeriodo.addEventListener("change", () => aoEscolher(Number(fPeriodo.value)));

  function renderEscolha(d) {
    const box = $("ppPeriodoBox");
    box.classList.toggle("d-none", !d.periodos.length);
    if (!d.periodos.length) { fPeriodo.innerHTML = ""; return; }
    const ultimo = d.periodos[d.periodos.length - 1];
    fPeriodo.innerHTML = d.periodos.slice().reverse().map((p) =>
      `<option value="${p.inventario_ate}">${esc(periodoTexto(p))}${p === ultimo ? " (último)" : ""}</option>`).join("");
    fPeriodo.value = String(d.periodo.inventario_ate.id);
  }

  /* ---------- Caixinhas: perda em dinheiro e em litros ---------- */
  // Diferença para o inventário anterior: ▲ vermelho se aumentou, ▼ verde se caiu
  function delta(atual, anterior, fmt, casas) {
    if (atual === null || atual === undefined || anterior === null || anterior === undefined) return "";
    const d = Math.round((atual - anterior) * 10 ** casas) / 10 ** casas;
    if (d === 0) return '<span class="pp-delta pp-delta--igual">Igual ao inventário anterior</span>';
    return d > 0
      ? `<span class="pp-delta pp-delta--sobe">▲ ${esc(fmt(d))} a mais que no inventário anterior</span>`
      : `<span class="pp-delta pp-delta--desce">▼ ${esc(fmt(-d))} a menos que no inventário anterior</span>`;
  }
  const semVendasMsg = () => `Sem vendas importadas neste período. ${MC.pode("vendas")
    ? 'Importe em <a href="vendas-teknisa.html">Vendas</a>.' : "Importe em Vendas."}`;

  function renderKpis(d, atual, anterior) {
    const t = d.periodo.total;
    const per = `<span class="pp-per">Inventário de ${esc(periodoTexto(atual))}</span>`;
    const ant = anterior && !anterior.sem_vendas ? anterior : null;
    const kd = $("ppKpiDinheiro");
    const kl = $("ppKpiLitros");
    const rotulo = (txt) => `<span class="pp-kpi-rotulo">${txt}</span>`;
    const falta = !d.periodo.sem_vendas && d.periodo.dias_sem_vendas.length
      ? `<span class="pp-falta">Faltam as vendas de ${esc(d.periodo.dias_sem_vendas_texto)}: a perda aparece maior do que é.</span>` : "";

    if (!d.dinheiro) {
      kd.className = "pp-card pp-kpi pp-kpi--neutro";
      kd.innerHTML = `${rotulo("Perda em dinheiro")}<span class="pp-kpi-msg">Só administrador e gerente veem.</span>`;
    } else if (d.periodo.sem_vendas) {
      kd.className = "pp-card pp-kpi pp-kpi--neutro";
      kd.innerHTML = `${rotulo("Perda em dinheiro")}<span class="pp-kpi-msg">${semVendasMsg()}</span>${per}`;
    } else {
      kd.className = `pp-card pp-kpi${t.reais < 0 ? " pp-kpi--neg" : ""}`;
      kd.innerHTML = `${rotulo("Perda em dinheiro")}<span class="pp-kpi-valor">${esc(R(t.reais))}</span>` +
        delta(t.reais, ant && ant.reais, R, 2) + per +
        (t.sem_preco.length ? `<span class="pp-per">Fora da conta (sem preço): ${esc(t.sem_preco.join(", "))}</span>` : "");
    }

    if (d.periodo.sem_vendas) {
      kl.className = "pp-card pp-kpi pp-kpi--neutro";
      kl.innerHTML = `${rotulo("Perda em litros")}<span class="pp-kpi-msg">${semVendasMsg()}</span>` +
        `<span class="pp-kpi-saiu">Saiu dos barris: ${esc(L(t.saiu))}</span>${per}`;
    } else {
      kl.className = `pp-card pp-kpi${t.perda < 0 ? " pp-kpi--neg" : ""}`;
      kl.innerHTML = `${rotulo("Perda em litros")}<span class="pp-kpi-valor">${esc(L(t.perda))}` +
        `${t.pct !== null ? `<small>${esc(P(t.pct))} do que saiu</small>` : ""}</span>` +
        delta(t.pct, ant && ant.pct, PP, 1) + per + falta;
    }
  }

  /* ---------- Gráfico de linhas: saiu dos barris × vendido, um ponto por período ---------- */
  // Escala "redonda" para o eixo: passos de 1, 2 ou 5 × 10^n, uns 4 a 6 traços
  function escala(min, max) {
    if (min === max) { min -= 10; max += 10; }
    const bruto = (max - min) / 5;
    const pot = 10 ** Math.floor(Math.log10(bruto));
    const passo = [1, 2, 5, 10].map((m) => m * pot).find((p) => p >= bruto);
    return { min: Math.floor(min / passo) * passo, max: Math.ceil(max / passo) * passo, passo };
  }

  function renderLinha(d, sel) {
    const ps = d.periodos;
    const W = 720, H = 250, ml = 52, mr = 34, mt = 14, mb = 30;
    const valores = ps.flatMap((p) => [p.saiu, p.vendido]).filter((v) => v !== null && v !== undefined);
    const e = escala(Math.min(...valores), Math.max(...valores));
    const n = ps.length;
    const X = (i) => ml + (W - ml - mr) * (n === 1 ? 0.5 : i / (n - 1));
    const Y = (v) => mt + (H - mt - mb) * (1 - (v - e.min) / (e.max - e.min));
    const temVenda = (p) => p.vendido !== null && p.vendido !== undefined;
    const fmtEixo = (v) => `${Number(v).toLocaleString("pt-BR")} L`;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de litros que saíram dos barris e litros vendidos em cada inventário">`;
    for (let v = e.min; v <= e.max + e.passo / 2; v += e.passo) {
      s += `<line x1="${ml}" x2="${W - mr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--pp-grade)" stroke-width="1"/>` +
        `<text x="${ml - 8}" y="${Y(v) + 4}" text-anchor="end">${fmtEixo(v)}</text>`;
    }
    const larg = Math.min(44, n > 1 ? (W - ml - mr) / (n - 1) - 4 : 44);
    s += `<rect x="${X(sel) - larg / 2}" y="${mt}" width="${larg}" height="${H - mt - mb}" fill="var(--mc-gold-soft)" opacity=".7" rx="6"/>`;
    // A área da perda e a linha do vendido só onde há vendas (períodos sem vendas quebram a linha azul)
    const trechos = [];
    ps.forEach((p, i) => {
      if (!temVenda(p)) return;
      const ult = trechos[trechos.length - 1];
      if (ult && ult[ult.length - 1] === i - 1) ult.push(i); else trechos.push([i]);
    });
    trechos.forEach((t) => {
      if (t.length < 2) return;
      const cima = t.map((i) => `${X(i)},${Y(ps[i].saiu)}`);
      const baixo = t.map((i) => `${X(i)},${Y(ps[i].vendido)}`).reverse();
      s += `<polygon points="${cima.concat(baixo).join(" ")}" fill="var(--mc-danger-soft)" stroke="none"/>`;
    });
    s += `<polyline points="${ps.map((p, i) => `${X(i)},${Y(p.saiu)}`).join(" ")}" fill="none" stroke="var(--mc-gold)" stroke-width="3" stroke-linejoin="round"/>`;
    trechos.forEach((t) => {
      if (t.length > 1) s += `<polyline points="${t.map((i) => `${X(i)},${Y(ps[i].vendido)}`).join(" ")}" fill="none" stroke="var(--mc-info)" stroke-width="3" stroke-linejoin="round"/>`;
    });
    ps.forEach((p, i) => {
      const on = i === sel;
      const r = on ? 6 : 4;
      const venda = temVenda(p);
      const meio = (Y(p.saiu) + Y(p.vendido || 0)) / 2 + 4;
      const lado = i === n - 1 && n > 1 ? { a: "end", dx: -10 } : { a: "start", dx: 10 };
      let rotulo = "";
      if (on && venda) rotulo = `<text class="pp-rotulo-perda${p.perda < 0 ? " pp-rotulo-perda--neg" : ""}" x="${X(i)}" y="${meio}" text-anchor="${lado.a}" dx="${lado.dx}">${p.perda < 0 ? "+" : "−"}${L(Math.abs(p.perda))}</text>`;
      else if (on) rotulo = `<text class="pp-rotulo-sem" x="${X(i)}" y="${Math.max(Y(p.saiu) - 14, mt + 10)}" text-anchor="middle">sem vendas</text>`;
      const desc = venda ? `perda de ${L(p.perda)}` : "sem vendas importadas";
      s += `<g class="pp-ponto" data-inventario="${p.inventario_ate}" tabindex="0" role="button" aria-pressed="${on}" aria-label="Inventário de ${periodoTexto(p)}: ${desc}">` +
        `<rect class="pp-ponto-area" x="${X(i) - larg / 2}" y="${mt}" width="${larg}" height="${H - mt - mb}" fill="transparent" rx="6"/>` +
        `<circle cx="${X(i)}" cy="${Y(p.saiu)}" r="${r}" fill="var(--mc-gold)" stroke="var(--mc-surface)" stroke-width="2"/>` +
        (venda ? `<circle cx="${X(i)}" cy="${Y(p.vendido)}" r="${r}" fill="var(--mc-info)" stroke="var(--mc-surface)" stroke-width="2"/>` : "") +
        rotulo +
        `<text class="pp-eixo-x${on ? " pp-eixo-x--on" : ""}" x="${X(i)}" y="${H - 8}" text-anchor="middle">até ${dia(p.ate)}</text></g>`;
    });
    $("ppLinha").innerHTML = `${s}</svg>`;
  }
  $("ppLinha").addEventListener("click", (e) => {
    const g = e.target.closest("[data-inventario]");
    if (g) aoEscolher(Number(g.dataset.inventario));
  });
  $("ppLinha").addEventListener("keydown", (e) => {
    const g = e.target.closest("[data-inventario]");
    if (!g || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    aoEscolher(Number(g.dataset.inventario));
  });

  /* ---------- Estoque por chope ---------- */
  const SITUACAO = { sem_estoque: "Sem estoque", acabando: "Acabando", ok: "OK" };
  function renderEstoque(d) {
    $("ppNoEstoque").querySelector("b").textContent = d.noEstoque;
    $("ppNoEstoque").setAttribute("aria-label", `${d.noEstoque} barris no estoque. Ver na aba Barris`);
    $("ppVazios").querySelector("b").textContent = d.vazios;
    $("ppVazios").setAttribute("aria-label", `${d.vazios} vazios para recolher. Ver na aba Barris`);
    const tabela = $("ppEstoque").closest("table");
    tabela.classList.toggle("pp-sem-periodo", !d.periodo);
    const z = (v) => (v === 0 ? '<span class="pp-zero">0</span>' : v);
    $("ppEstoque").innerHTML = d.estoque.length
      ? d.estoque.map((c) => `<tr><td class="pp-nome">${esc(c.nome)}</td><td class="pp-num">${z(c.engatados)}</td>` +
        `<td class="pp-num">${z(c.disponiveis)}</td>` +
        `<td class="pp-num pp-col-saiu">${c.saiu === null ? "" : c.saiu === 0 ? `<span class="pp-zero">${L(0)}</span>` : esc(L(c.saiu))}</td>` +
        `<td><span class="pp-sit pp-sit--${c.situacao}">${SITUACAO[c.situacao]}</span></td></tr>`).join("")
      : `<tr><td colspan="5" class="pp-vazio">Nenhum barril nesta unidade. Cadastre na aba <a href="barris.html">Barris</a>.</td></tr>`;
  }

  /* ---------- Movimentações recentes (as mesmas do Painel de antes, sem as pesagens) ---------- */
  const OP_CURTA = {
    utilizacao: "Engate", esgotado: "Retirada", retirada_com_chope: "Retirada", entrada: "Entrada",
    transferencia: "Transferência", recolhimento: "Recolhido",
  };
  function detalheMov(m) {
    if (m.operacao === "utilizacao") return m.torneira_numero ? `Torneira ${m.torneira_numero}` : "";
    if (m.operacao === "esgotado") return "vazio";
    if (m.operacao === "retirada_com_chope")
      return m.litros !== null && m.litros !== undefined ? `com ${m.estimado ? "≈ " : ""}${MC.fmtLitros(m.litros)}` : "com chope";
    if (m.operacao === "entrada") return m.origem ? `de ${m.origem}` : `da ${ctx.config.fornecedor}`;
    if (m.operacao === "transferencia") return m.destino ? `${m.origem || ""} → ${m.destino}` : m.origem || "";
    return "";
  }
  // "2026-11-26 15:42:10" -> "hoje 15:42", "ontem 22:51" ou "24/11 18:00"
  function quando(s) {
    if (!s) return "";
    const d = s.slice(0, 10);
    const hoje = ctx.config.hoje || "";
    const hora = s.slice(11, 16);
    if (d === hoje) return `hoje ${hora}`;
    if (hoje) {
      const ontem = new Date(`${hoje}T12:00:00Z`);
      ontem.setUTCDate(ontem.getUTCDate() - 1);
      if (d === ontem.toISOString().slice(0, 10)) return `ontem ${hora}`;
    }
    return `${dia(s)} ${hora}`;
  }
  function renderMov(list) {
    $("ppMov").innerHTML = list.length ? list.map((m) => {
      const det = detalheMov(m);
      return `<li><span class="op-badge op-badge--${m.operacao}">${OP_CURTA[m.operacao] || MC.OP_LABELS[m.operacao] || ""}</span>` +
        `<span class="pp-mov-o-que"><b>#${esc(m.codigo)}</b> ${esc(MC.chopeLabel(m))}${det ? ` · ${esc(det)}` : ""}</span>` +
        `<span class="pp-mov-quando">${esc(quando(m.criado_em))}</span>` +
        `<span class="pp-mov-quem">${esc(m.responsavel || "")}</span></li>`;
    }).join("") : '<li class="pp-vazio">Nenhuma movimentação ainda. Cadastre o primeiro barril na aba Barris.</li>';
  }

  /* ---------- Chopes que mais saíram: saiu × vendido por chope ---------- */
  function renderBarras(d, atual) {
    const sv = d.periodo.sem_vendas;
    $("ppBarrasSub").textContent = `Inventário de ${periodoTexto(atual)}. ${sv
      ? "Sem vendas importadas neste período: só o que saiu dos barris." : "A diferença entre as barras é a perda."}`;
    const itens = d.periodo.chopes.filter((c) => c.saiu > 0).sort((a, b) => b.saiu - a.saiu);
    const max = Math.max(...itens.map((c) => Math.max(c.saiu, c.vendido || 0)), 0);
    if (!itens.length) {
      $("ppBarras").innerHTML = '<p class="pp-vazio">Nenhum chope saiu dos barris neste período.</p>';
      return;
    }
    $("ppBarras").innerHTML = itens.map((c) => {
      const venda = !sv && c.vendido !== null;
      const pct = (v) => `${(v / max) * 100}%`;
      const perda = venda && c.pct !== null ? ` · perda <b class="${c.pct < 0 ? "pp-neg" : ""}">${esc(P(c.pct))}</b>` : "";
      const reais = d.dinheiro && venda && c.reais !== null && c.reais !== undefined ? ` <span class="pp-muted">· ${esc(R(c.reais))}</span>` : "";
      return `<div class="pp-barra-linha"><span class="pp-barra-nome" title="${esc(c.nome)}">${esc(c.nome)}</span>` +
        `<div class="pp-barra-par"><div class="pp-barra pp-barra--saiu" style="width:${pct(c.saiu)}" title="Saiu: ${esc(L(c.saiu))}"></div>` +
        (venda ? `<div class="pp-barra pp-barra--vend" style="width:${pct(c.vendido)}" title="Vendido: ${esc(L(c.vendido))}"></div>` : "") +
        `</div><span class="pp-barra-valor">${esc(L(c.saiu))}${perda}${reais}</span></div>`;
    }).join("");
  }

  /* ---------- Tudo ---------- */
  function render(d, opcoes) {
    ctx = opcoes.ctx;
    aoEscolher = opcoes.aoEscolher;
    renderEscolha(d);
    const comPerda = !d.semPerdas && d.periodos.length > 0 && d.periodo;
    $("ppPerdas").classList.toggle("d-none", !comPerda);
    $("ppBarrasBox").classList.toggle("d-none", !comPerda);
    const aviso = $("ppAviso");
    aviso.classList.toggle("d-none", !!comPerda);
    aviso.innerHTML = comPerda ? "" : d.semPerdas ? esc(d.semPerdas)
      : 'A perda aparece depois do segundo inventário completo. Faça o inventário em <a href="pesagem.html">Mais &gt; Pesagem</a>.';
    if (comPerda) {
      const sel = d.periodos.findIndex((p) => p.inventario_ate === d.periodo.inventario_ate.id);
      const atual = d.periodos[sel];
      renderKpis(d, atual, d.periodos[sel - 1]);
      renderLinha(d, sel);
      renderBarras(d, atual);
    }
    renderEstoque(d);
    renderMov(d.movimentacoes);
  }

  return { render };
})();
