/* BarrilFacil — Mais > Vendas da Teknisa (administrador e gerente; o gerente só nas unidades dele)
   1. Arquivo: o XLSX "Vendas Realizadas no Período" vai para o servidor, que lê e devolve a prévia (nada é gravado).
   2. Prévia: chope e volume de cada produto (os conhecidos com o que está gravado, os novos com a sugestão), os
      ignorados recolhidos, os litros por chope e por dia e os totais para comparar com a Teknisa.
   3. Importar: manda o arquivo de novo com as escolhas; o servidor grava tudo numa transação.
   Aba Produtos: o de-para gravado, editável (vale para as próximas importações). */
(async () => {
  const ctx = await MCLayout.init("vendas");
  if (!ctx) return;

  const $ = (id) => document.getElementById(id);
  const MAX_ARQUIVO = 10 * 1024 * 1024;
  const reais = (n) => `R$ ${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const litros = (n) => `${Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
  const qtd = (n) => Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 3 });
  const volumeCampo = (v) => (v === null || v === undefined ? "" : String(v).replace(".", ","));
  const porLitro = (valor, l) => (l > 0 ? `${reais(valor / l)}/L` : '<span class="t-muted">—</span>');
  const periodo = (de, ate) => (de === ate ? MC.fmtDia(de) : `${MC.fmtDia(de)} a ${MC.fmtDia(ate)}`);
  const plural = (n, um, varios) => `${n.toLocaleString("pt-BR")} ${n === 1 ? um : varios}`;

  /* ---------- Abas ---------- */
  let produtosCarregados = false;
  document.querySelectorAll(".tabs [data-aba]").forEach((btn) => btn.addEventListener("click", () => {
    const aba = btn.dataset.aba;
    document.querySelectorAll(".tabs [data-aba]").forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-selected", b === btn ? "true" : "false");
    });
    $("painelImportar").classList.toggle("d-none", aba !== "importar");
    $("painelProdutos").classList.toggle("d-none", aba !== "produtos");
    if (aba === "produtos" && !produtosCarregados) carregarProdutos();
  }));

  /* ---------- 1. Arquivo ---------- */
  let arquivo = null;   // { nome, base64 }
  let previa = null;    // resposta do vendas:ler
  let escolhaUnidade = {}; // código da loja na Teknisa -> id da unidade (loja ainda sem código)

  const lerBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("Não foi possível abrir o arquivo."));
    r.readAsDataURL(file);
  });

  function limpar() {
    arquivo = null;
    previa = null;
    escolhaUnidade = {};
    $("arquivo").value = "";
    $("infoArquivo").classList.add("d-none");
    $("secPrevia").classList.add("d-none");
  }

  async function lerPrevia() {
    $("lendo").classList.remove("d-none");
    try {
      const r = await MC.run(() => MC.call("vendas:ler", { arquivo: arquivo.base64, nome: arquivo.nome, unidades: escolhaUnidade }));
      if (!r) return false;
      previa = r;
      previa.produtos.forEach((p) => { p.volumeTexto = volumeCampo(p.volume); });
      return true;
    } finally {
      $("lendo").classList.add("d-none");
    }
  }

  $("arquivo").addEventListener("change", async () => {
    const file = $("arquivo").files[0];
    if (!file) return;
    if (file.size > MAX_ARQUIVO) { MC.toast("O arquivo passa de 10 MB.", "err"); $("arquivo").value = ""; return; }
    let base64;
    try { base64 = await lerBase64(file); } catch (err) { MC.toast(err.message, "err"); return; }
    arquivo = { nome: file.name, base64 };
    escolhaUnidade = {};
    if (!await lerPrevia()) { limpar(); return; }
    $("de").value = previa.de;
    $("ate").value = previa.ate;
    $("infoArquivo").classList.remove("d-none");
    $("secPrevia").classList.remove("d-none");
    renderTudo();
  });
  $("btnOutro").addEventListener("click", () => { limpar(); $("arquivo").focus(); });
  ["de", "ate"].forEach((id) => $(id).addEventListener("change", () => { if (previa) { renderProdutos(); renderResumo(); } }));

  /* ---------- Unidades do arquivo ---------- */
  // Entra no resumo e na importação: a loja com unidade liberada, ou a que ainda vai ganhar a unidade (escolha)
  const entra = (u) => u.acesso || !u.unidadeId;

  function renderUnidades() {
    $("fatosArquivo").innerHTML = [
      ["Arquivo", previa.arquivo], ["Primeira venda", MC.fmtDate(previa.primeiraVenda)], ["Última venda", MC.fmtDate(previa.ultimaVenda)],
    ].map(([k, v]) => `<div><dt>${MC.esc(k)}</dt><dd>${MC.esc(v)}</dd></div>`).join("");
    $("unidadesArquivo").innerHTML = previa.unidades.map((u) => {
      const loja = `<span class="t-strong">${MC.esc(`${u.codigo} - ${u.nomeTeknisa}`)}</span>`;
      if (u.unidadeId && !u.nova && u.acesso) return `<p class="vendas-loja">Loja da Teknisa ${loja}: <span class="t-strong">${MC.esc(u.unidadeNome)}</span></p>`;
      if (u.unidadeId && !u.acesso)
        return `<p class="vendas-loja vendas-loja--fora">Loja da Teknisa ${loja}: ${MC.esc(u.unidadeNome)}. Você não tem acesso a esta unidade: as vendas dela não serão importadas.</p>`;
      if (!previa.unidadesLivres.length && !u.unidadeId)
        return `<div class="warn-note">A loja ${loja} ainda não tem unidade, e todas as suas unidades já têm código Teknisa. Peça a um administrador para conferir o código na tela Unidades.</div>`;
      const opcoes = previa.unidadesLivres.map((x) => `<option value="${x.id}" ${x.id === u.unidadeId ? "selected" : ""}>${MC.esc(x.nome)}</option>`).join("");
      return `<div class="vendas-loja vendas-loja--escolher">
        <label class="form-label" for="un_${MC.esc(u.codigo)}">Loja da Teknisa ${loja}: qual é a unidade?</label>
        <select class="form-select" id="un_${MC.esc(u.codigo)}" data-codigo="${MC.esc(u.codigo)}"><option value="">Escolha a unidade</option>${opcoes}</select>
        <div class="t-muted small-note mt-1">Ao importar, o código ${MC.esc(u.codigo)} fica gravado nesta unidade e as próximas importações já vêm com ela.</div>
      </div>`;
    }).join("");
  }

  $("unidadesArquivo").addEventListener("change", async (e) => {
    const sel = e.target.closest("select[data-codigo]");
    if (!sel) return;
    const antes = { ...escolhaUnidade };
    if (sel.value) escolhaUnidade[sel.dataset.codigo] = Number(sel.value);
    else delete escolhaUnidade[sel.dataset.codigo];
    const escolhas = previa.produtos.map(({ nome, chopeId, volumeTexto, ignorar }) => ({ nome, chopeId, volumeTexto, ignorar }));
    // Lê de novo para contar o que já foi importado nesta unidade (e confere se a unidade pode receber o código)
    if (!await lerPrevia()) { escolhaUnidade = antes; renderUnidades(); return; }
    escolhas.forEach((x) => Object.assign(previa.produtos.find((p) => p.nome === x.nome) || {}, x)); // mantém o que a pessoa mudou
    renderTudo();
  });

  /* ---------- 2. Prévia ---------- */
  const chopePorId = (id) => previa.chopes.find((c) => c.id === id);
  const volumeDe = (p) => MC.numeroBR(p.volumeTexto);
  function opcoesChope(p) {
    const parecidos = new Set(p.parecidos || []);
    const op = (c) => `<option value="${c.id}" ${c.id === p.chopeId ? "selected" : ""}>${MC.esc(c.nome)}${c.ativo ? "" : " (desativado)"}</option>`;
    const visiveis = previa.chopes.filter((c) => c.ativo || c.id === p.chopeId);
    const primeiro = visiveis.filter((c) => parecidos.has(c.id));
    const resto = visiveis.filter((c) => !parecidos.has(c.id));
    return `<option value="">Escolha o chope</option>` + (primeiro.length
      ? `<optgroup label="Nomes parecidos">${primeiro.map(op).join("")}</optgroup><optgroup label="Todos os chopes">${resto.map(op).join("")}</optgroup>`
      : resto.map(op).join(""));
  }

  // Quantidade e valor de cada produto no período (só lojas que entram)
  function somaPorProduto(de, ate) {
    const soma = previa.produtos.map(() => ({ q: 0, v: 0 }));
    previa.unidades.filter(entra).forEach((u) => u.grupos.forEach((g) => {
      if (g.dia < de || g.dia > ate) return;
      soma[g.p].q += g.q;
      soma[g.p].v += g.v;
    }));
    return soma;
  }
  const periodoAtual = () => {
    const de = $("de").value || previa.de;
    const ate = $("ate").value || previa.ate;
    return de <= ate ? { de, ate } : { de: ate, ate: de };
  };

  function renderProdutos() {
    const { de, ate } = periodoAtual();
    const soma = somaPorProduto(de, ate);
    const linha = (p, i) => {
      const vol = volumeDe(p);
      const l = vol > 0 ? soma[i].q * vol : null;
      const avisos = [
        p.novo ? '<span class="op-badge op-badge--primeiro">Novo</span>' : "",
        p.aviso ? `<span class="vendas-aviso">${MC.esc(p.aviso)}</span>` : "",
        !p.chopeId ? '<span class="vendas-aviso vendas-aviso--erro">Escolha o chope</span>' : "",
      ].filter(Boolean).join(" ");
      return `<tr data-i="${i}">
        <td><span class="t-strong">${MC.esc(p.nome)}</span>${avisos ? `<div class="vendas-avisos">${avisos}</div>` : ""}</td>
        <td>${qtd(soma[i].q)}</td>
        <td><select class="form-select form-select-sm" data-campo="chope" aria-label="Chope de ${MC.esc(p.nome)}">${opcoesChope(p)}</select></td>
        <td><input class="form-control form-control-sm vendas-volume" data-campo="volume" inputmode="decimal" autocomplete="off" value="${MC.esc(p.volumeTexto)}" placeholder="0,36" aria-label="Volume de ${MC.esc(p.nome)}"></td>
        <td data-litros>${l === null ? '<span class="vendas-aviso vendas-aviso--erro">Informe o volume</span>' : MC.esc(litros(l))}</td>
        <td><label class="vendas-check"><input type="checkbox" data-campo="ignorar" aria-label="Ignorar ${MC.esc(p.nome)}"> <span>Ignorar</span></label></td></tr>`;
    };
    const chopes = previa.produtos.map((p, i) => [p, i]).filter(([p]) => !p.ignorar);
    const ignorados = previa.produtos.map((p, i) => [p, i]).filter(([p]) => p.ignorar);
    $("tbodyPrevia").innerHTML = chopes.length
      ? chopes.map(([p, i]) => linha(p, i)).join("")
      : '<tr><td colspan="6" class="table-empty">Nenhum produto de chope neste arquivo. Desmarque "Ignorar" nos ignorados se algum for chope.</td></tr>';
    $("tbodyIgnorados").innerHTML = ignorados.length
      ? ignorados.map(([p, i]) => `<tr data-i="${i}">
          <td><span class="t-strong">${MC.esc(p.nome)}</span>${p.novo ? ' <span class="op-badge op-badge--primeiro">Novo</span>' : ""}</td>
          <td>${qtd(soma[i].q)}</td><td>${reais(soma[i].v)}</td>
          <td><label class="vendas-check"><input type="checkbox" data-campo="ignorar" checked aria-label="Ignorar ${MC.esc(p.nome)}"> <span>Ignorar</span></label></td></tr>`).join("")
      : '<tr><td colspan="4" class="table-empty">Nenhum produto ignorado.</td></tr>';
    $("ignoradosTitulo").textContent = `Ignorados (${ignorados.length})`;
  }

  // Litros por chope e por dia, itens que já existem e totais (recalculado a cada mudança)
  function renderResumo() {
    const { de, ate } = periodoAtual();
    const porChope = new Map();
    const porDia = new Map();
    let novos = 0;
    let repetidos = 0;
    let litrosNovos = 0;
    let arquivoLinhas = 0;
    let arquivoQtd = 0;
    let arquivoValor = 0;
    const chopeTot = { q: 0, l: 0, v: 0 };
    previa.unidades.filter(entra).forEach((u) => {
      arquivoLinhas += u.linhas;
      arquivoQtd += u.quantidade;
      arquivoValor += u.valor;
      u.grupos.forEach((g) => {
        const p = previa.produtos[g.p];
        if (p.ignorar || g.dia < de || g.dia > ate) return;
        const vol = volumeDe(p) > 0 ? volumeDe(p) : 0;
        const l = g.q * vol;
        const c = p.chopeId ? (chopePorId(p.chopeId) || { nome: "?" }).nome : "Sem chope escolhido";
        const pc = porChope.get(c) || { q: 0, l: 0, v: 0 };
        pc.q += g.q; pc.l += l; pc.v += g.v;
        porChope.set(c, pc);
        const pd = porDia.get(g.dia) || { l: 0, v: 0 };
        pd.l += l; pd.v += g.v;
        porDia.set(g.dia, pd);
        chopeTot.q += g.q; chopeTot.l += l; chopeTot.v += g.v;
        repetidos += g.nr;
        novos += g.n - g.nr;
        litrosNovos += (g.q - g.qr) * vol;
      });
    });
    $("tbodyPorChope").innerHTML = porChope.size
      ? [...porChope.entries()].sort((a, b) => b[1].l - a[1].l).map(([nome, x]) => `<tr>
          <td class="t-strong">${MC.esc(nome)}</td><td>${qtd(x.q)}</td><td>${litros(x.l)}</td><td>${reais(x.v)}</td><td>${porLitro(x.v, x.l)}</td></tr>`).join("")
      : '<tr><td colspan="5" class="table-empty">Nenhum chope no período.</td></tr>';
    $("tbodyPorDia").innerHTML = porDia.size
      ? [...porDia.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([dia, x]) => `<tr>
          <td class="t-strong">${MC.fmtDia(dia)}</td><td>${litros(x.l)}</td><td>${reais(x.v)}</td></tr>`).join("")
      : '<tr><td colspan="3" class="table-empty">Nenhum chope no período.</td></tr>';
    $("totais").innerHTML = [
      ["Chope no período", `${plural(chopeTot.q, "item", "itens")} · ${litros(chopeTot.l)} · ${reais(chopeTot.v)}`],
      ["Serão importados", `${plural(novos, "item novo", "itens novos")} · ${litros(litrosNovos)}`],
      ["No arquivo (todos os produtos)", `${plural(arquivoLinhas, "linha", "linhas")} · quantidade ${qtd(arquivoQtd)} · ${reais(arquivoValor)}`],
    ].map(([k, v]) => `<div><dt>${MC.esc(k)}</dt><dd>${MC.esc(v)}</dd></div>`).join("");
    const aviso = $("avisoRepetidos");
    aviso.classList.toggle("d-none", !repetidos);
    aviso.textContent = repetidos
      ? `${plural(repetidos, "item já tinha sido importado e será pulado.", "itens já tinham sido importados e serão pulados.")}`
      : "";
  }

  function renderTudo() {
    renderUnidades();
    renderProdutos();
    renderResumo();
  }

  // Mudanças na prévia: chope e "ignorar" redesenham as tabelas; o volume só atualiza os litros (sem perder o foco)
  function aoMudar(e) {
    const campo = e.target.dataset.campo;
    const tr = e.target.closest("tr[data-i]");
    if (!campo || !tr) return;
    const p = previa.produtos[Number(tr.dataset.i)];
    if (campo === "volume") {
      p.volumeTexto = e.target.value;
      const vol = volumeDe(p);
      const soma = somaPorProduto(periodoAtual().de, periodoAtual().ate)[Number(tr.dataset.i)];
      tr.querySelector("[data-litros]").innerHTML = vol > 0 ? MC.esc(litros(soma.q * vol)) : '<span class="vendas-aviso vendas-aviso--erro">Informe o volume</span>';
      renderResumo();
      return;
    }
    if (campo === "chope") { p.chopeId = Number(e.target.value) || null; p.aviso = null; }
    if (campo === "ignorar") p.ignorar = e.target.checked;
    renderProdutos();
    renderResumo();
  }
  ["tbodyPrevia", "tbodyIgnorados"].forEach((id) => {
    $(id).addEventListener("change", aoMudar);
    $(id).addEventListener("input", (e) => { if (e.target.dataset.campo === "volume") aoMudar(e); });
  });

  /* ---------- 3. Importar ---------- */
  $("btnImportar").addEventListener("click", async () => {
    if (!previa) return;
    const falta = previa.unidades.find((u) => !u.unidadeId && !escolhaUnidade[u.codigo]);
    if (falta) return MC.toast(`Escolha a unidade da loja ${falta.codigo} - ${falta.nomeTeknisa}.`, "err");
    const semChope = previa.produtos.find((p) => !p.ignorar && (!p.chopeId || !(volumeDe(p) > 0)));
    if (semChope) return MC.toast(`Escolha o chope e o volume de "${semChope.nome}" ou marque para ignorar.`, "err");
    const { de, ate } = periodoAtual();
    const btn = $("btnImportar");
    btn.disabled = true;
    try {
      const r = await MC.run(() => MC.call("vendas:importar", {
        arquivo: arquivo.base64, nome: arquivo.nome, de, ate, unidades: escolhaUnidade,
        produtos: previa.produtos.map((p) => ({ nome: p.nome, chopeId: p.chopeId, volume: p.volumeTexto, ignorar: p.ignorar })),
      }));
      if (!r) return;
      const linhas = r.importacoes.map((x) => [x.unidade, x.novas
        ? `${plural(x.novas, "item novo", "itens novos")}, ${litros(x.litros)}${x.repetidas ? ` (${plural(x.repetidas, "repetido pulado", "repetidos pulados")})` : ""}`
        : `nada novo${x.repetidas ? `: os ${plural(x.repetidas, "item já tinha", "itens já tinham")} sido importados` : ""}`]);
      if (r.semAcesso.length) linhas.push(["Sem acesso (não importadas)", r.semAcesso.join(", ")]);
      MC.notice({ title: r.importacoes.some((x) => x.novas) ? "Vendas importadas" : "Nenhuma venda nova", text: `Período ${periodo(r.de, r.ate)}. As escolhas dos produtos foram gravadas.`, lines: linhas });
      limpar();
      carregarImportacoes();
      produtosCarregados = false;
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- Importações ---------- */
  let importacoes = [];
  async function carregarImportacoes() {
    const r = await MC.run(() => MC.call("vendas:importacoes"));
    if (!r) return;
    importacoes = r;
    $("tbodyImportacoes").innerHTML = importacoes.length
      ? importacoes.map((x) => `<tr class="${x.cancelada ? "vendas-cancelada" : ""}">
          <td class="t-strong">${MC.esc(x.unidade || "—")}</td>
          <td>${MC.esc(periodo(x.de, x.ate))}</td>
          <td>${x.novas.toLocaleString("pt-BR")}${x.repetidas ? ` <span class="t-muted">(+${x.repetidas} repetidos)</span>` : ""}</td>
          <td>${litros(x.litros)}</td>
          <td>${reais(x.valor)}</td>
          <td>${MC.esc(x.criadoPor || "—")} <span class="t-muted">${MC.esc(MC.fmtDate(x.criadoEm))}</span></td>
          <td>${x.cancelada
            ? `<span class="op-badge op-badge--cancelada">Cancelada</span> <span class="t-muted small-note">${MC.esc(MC.fmtDate(x.canceladaEm))}</span>`
            : '<span class="op-badge op-badge--disponivel">Importada</span>'}</td>
          <td><div class="row-actions">
            <button class="btn-ghost" data-imp="ver" data-id="${x.id}">Ver</button>
            ${x.cancelada ? "" : `<button class="btn-ghost btn-ghost--danger" data-imp="cancelar" data-id="${x.id}">Cancelar</button>`}
          </div></td></tr>`).join("")
      : '<tr><td colspan="8" class="table-empty">Nenhuma importação ainda.</td></tr>';
  }

  async function ver(id) {
    const r = await MC.run(() => MC.call("vendas:resumo", { id }));
    if (!r) return;
    const tabela = (titulo, cab, linhas, vazio) => `<h3 class="precos-hist-titulo">${titulo}</h3>
      <div class="table-card precos-historico"><table><thead><tr>${cab.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
      <tbody>${linhas.length ? linhas.map((l) => `<tr>${l.map((v, i) => `<td data-label="${cab[i]}">${v}</td>`).join("")}</tr>`).join("")
        : `<tr><td colspan="${cab.length}" class="table-empty">${vazio}</td></tr>`}</tbody></table></div>`;
    const fatos = [
      ["Arquivo", MC.esc(r.arquivo || "—")],
      ["Vendas de", MC.esc(`${MC.fmtDate(r.primeiraVenda)} a ${MC.fmtDate(r.ultimaVenda)}`)],
      ["Itens novos", `${r.novas.toLocaleString("pt-BR")}${r.repetidas ? ` (${r.repetidas} repetidos pulados)` : ""}`],
      ["Total", `${MC.esc(litros(r.litros))} · ${MC.esc(reais(r.valor))} · ${r.precoLitro === null ? "—" : MC.esc(`${reais(r.precoLitro)}/L`)}`],
    ];
    const vazio = r.cancelada ? "Importação cancelada: os itens foram apagados." : "Nenhum item.";
    MC.notice({
      title: `Vendas de ${r.unidade}, ${periodo(r.de, r.ate)}`,
      type: "plain",
      html: `${r.cancelada ? `<div class="warn-note">Cancelada em ${MC.esc(MC.fmtDate(r.canceladaEm))}${r.canceladaPor ? ` por ${MC.esc(r.canceladaPor)}` : ""}.</div>` : ""}
        <dl class="unit-facts vendas-fatos">${fatos.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
        ${tabela("Por chope", ["Chope", "Litros", "Valor", "Preço por litro"],
          r.chopes.map((c) => [MC.esc(c.nome), MC.esc(litros(c.litros)), MC.esc(reais(c.valor)), c.precoLitro === null ? "—" : MC.esc(`${reais(c.precoLitro)}/L`)]), vazio)}
        ${tabela("Por dia", ["Dia", "Litros", "Valor", "Preço por litro"],
          r.dias.map((d) => [MC.esc(MC.fmtDia(d.dia)), MC.esc(litros(d.litros)), MC.esc(reais(d.valor)), d.precoLitro === null ? "—" : MC.esc(`${reais(d.precoLitro)}/L`)]), vazio)}`,
    });
    const modal = document.querySelector(".mc-overlay:last-child .mc-modal");
    if (modal) modal.classList.add("mc-modal--precos");
  }

  async function cancelar(id) {
    const x = importacoes.find((i) => i.id === id);
    if (!x) return;
    if (!await MC.confirm({
      title: "Cancelar importação",
      text: `Apagar os ${plural(x.novas, "item", "itens")} desta importação (${x.unidade}, ${periodo(x.de, x.ate)})? As outras importações ficam. Depois dá para importar o arquivo de novo.`,
      confirmLabel: "Cancelar importação",
      cancelLabel: "Voltar",
      type: "err",
    })) return;
    const r = await MC.run(() => MC.call("vendas:cancelar", { id }));
    if (!r) return;
    MC.toast(`Importação cancelada: ${plural(r.itens, "item apagado", "itens apagados")}.`);
    carregarImportacoes();
  }

  $("tbodyImportacoes").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-imp]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.imp === "ver") ver(id);
    else cancelar(id);
  });

  /* ---------- Aba Produtos ---------- */
  let produtos = [];
  let chopesCatalogo = [];
  async function carregarProdutos() {
    const r = await MC.run(() => MC.call("vendas:produtos"));
    if (!r) return;
    produtosCarregados = true;
    produtos = r.produtos;
    chopesCatalogo = r.chopes;
    renderListaProdutos();
  }
  function renderListaProdutos() {
    const termo = $("buscaProduto").value.trim().toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
    const lista = produtos.filter((p) => !termo || p.nome.includes(termo) || String(p.codigo || "").includes(termo));
    const situacao = (p) => (p.ignorar ? '<span class="op-badge op-badge--inativo">Ignorado</span>'
      : p.chopeId && p.volume ? '<span class="op-badge op-badge--disponivel">Chope</span>'
        : '<span class="sem-preco">Falta o chope ou o volume</span>');
    $("tbodyProdutos").innerHTML = lista.length
      ? lista.map((p) => `<tr>
          <td class="t-strong">${MC.esc(p.nome)}</td>
          <td>${p.codigo ? MC.esc(p.codigo) : '<span class="t-muted">—</span>'}</td>
          <td>${p.chope ? MC.esc(p.chope) : '<span class="t-muted">—</span>'}</td>
          <td>${p.volume === null ? '<span class="t-muted">—</span>' : MC.esc(litros(p.volume))}</td>
          <td>${situacao(p)}</td>
          <td><div class="row-actions"><button class="btn-ghost" data-prod="${p.id}">Editar</button></div></td></tr>`).join("")
      : `<tr><td colspan="6" class="table-empty">${produtos.length ? "Nenhum produto com esse nome." : "Nenhum produto ainda: eles entram na primeira importação."}</td></tr>`;
  }
  $("buscaProduto").addEventListener("input", renderListaProdutos);
  $("tbodyProdutos").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-prod]");
    if (!btn) return;
    const p = produtos.find((x) => x.id === Number(btn.dataset.prod));
    if (!p) return;
    const opcoes = [{ value: "", label: "Nenhum" }, ...chopesCatalogo
      .filter((c) => c.ativo || c.id === p.chopeId)
      .map((c) => ({ value: c.id, label: `${c.nome}${c.ativo ? "" : " (desativado)"}` }))];
    const r = await MC.dialog({
      title: "Editar produto",
      intro: `${p.nome}. Vale para as próximas importações; as vendas já importadas não mudam.`,
      fields: [
        { id: "chope", label: "Chope", type: "select", options: opcoes, value: p.chopeId || "" },
        { id: "volume", label: "Volume: litros de chope por item vendido (ex.: 0,36)", value: volumeCampo(p.volume) },
        { id: "ignorar", label: "Este produto é chope?", type: "checks", options: [{ value: "1", label: "Ignorar (não é chope)", checked: p.ignorar }] },
      ],
      submitLabel: "Salvar",
      onOpen: (overlay) => { overlay.querySelector("#mcf_volume").setAttribute("inputmode", "decimal"); },
      onSubmit: (v) => MC.call("vendas:produtoSalvar", { id: p.id, chopeId: Number(v.chope) || null, volume: v.volume, ignorar: v.ignorar.includes("1") }),
    });
    if (!r) return;
    MC.toast(r.mudou ? "Produto atualizado." : "Nada mudou.");
    carregarProdutos();
  });

  carregarImportacoes();
})();
