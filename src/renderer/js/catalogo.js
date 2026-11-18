/* BarrilFacil — chopes (só o nome), o custo por litro de cada um e os tamanhos de barril
   Todos veem a lista e cadastram chope novo, só com o nome. Quem tem a permissão catalogo:editar (administrador e
   gerente) também cadastra e muda os preços, edita, desativa, apaga e cuida dos tamanhos de barril (os botões nem
   aparecem para os outros, e o servidor também bloqueia). O operador não vê custo nenhum. */
(async () => {
  const ctx = await MCLayout.init("catalogo");
  if (!ctx) return;

  const $ = (id) => document.getElementById(id);
  const editar = MC.pode("catalogo:editar");
  if (!editar) {
    document.querySelectorAll(".admin-only").forEach((el) => el.remove()); // só ativos e sem custos: as colunas não dizem nada
    $("subtitle").textContent = "Catálogo usado no cadastro de barris. Para editar, desativar ou cadastrar o preço de um chope, fale com um administrador ou gerente.";
  }
  const byName = (a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" });
  let chopes = [];
  let tamanhos = []; // todos, com os desativados e quantos barris usam cada um (só quem edita)
  const ativos = () => tamanhos.filter((t) => t.ativo).map((t) => t.litros);

  const badge = (ativo) =>
    `<span class="op-badge op-badge--${ativo ? "disponivel" : "inativo"}">${ativo ? "Ativo" : "Desativado"}</span>`;
  const actions = (c) => `<div class="row-actions">
      <button class="btn-ghost" data-act="precos" data-id="${c.id}">Preços</button>
      <button class="btn-ghost" data-act="edit" data-id="${c.id}">Editar</button>
      <button class="btn-ghost ${c.ativo ? "btn-ghost--danger" : ""}" data-act="toggle" data-id="${c.id}">${c.ativo ? "Desativar" : "Reativar"}</button>
      <button class="btn-ghost btn-ghost--apagar" data-act="delete" data-id="${c.id}">Apagar</button>
    </div>`;

  /* "N chopes sem preço", contando o chope por tamanho sem preço num tamanho (ex.: um tamanho novo) */
  function avisoSemPreco() {
    const el = $("avisoSemPreco");
    const linhas = [];
    let n = 0;
    chopes.filter((c) => c.ativo && c.custo).forEach((c) => {
      if (c.custo.semPreco) { n += 1; linhas.push(`${c.nome} sem preço`); return; }
      if (!c.custo.semPrecoTamanhos.length) return;
      n += 1;
      c.custo.semPrecoTamanhos.forEach((t) => linhas.push(`${c.nome} sem preço no barril de ${MC.fmtLitros(t)}`));
    });
    el.classList.toggle("d-none", !n);
    el.innerHTML = n
      ? `<div>${n === 1 ? "1 chope sem preço" : `${n} chopes sem preço`}</div>
         <ul class="sem-preco-lista">${linhas.map((l) => `<li>${MC.esc(l)}</li>`).join("")}</ul>
         <div class="sem-preco-dica">Cadastre pelo botão Preços de cada chope.</div>`
      : "";
  }

  function renderChopes() {
    $("tbodyChopes").innerHTML = chopes.length
      ? chopes.map((c) => `<tr>
          <td class="t-strong">${MC.esc(c.nome)}</td>
          ${editar ? `<td>${MCPrecos.custoTexto(c.custo)}</td><td>${badge(c.ativo)}</td><td>${actions(c)}</td>` : ""}</tr>`).join("")
      : `<tr><td colspan="${editar ? 4 : 1}" class="table-empty">Nenhum chope cadastrado ainda.</td></tr>`;
  }

  function renderTamanhos() {
    $("tbodyTamanhos").innerHTML = tamanhos.length
      ? tamanhos.map((t) => `<tr>
          <td class="t-strong">${MC.esc(MC.fmtLitros(t.litros))}</td>
          <td>${t.prefixo ? MC.esc(t.prefixo) : '<span class="t-muted">—</span>'}</td>
          <td>${t.barris}</td>
          <td>${badge(t.ativo)}</td>
          <td><div class="row-actions"><button class="btn-ghost ${t.ativo ? "btn-ghost--danger" : ""}" data-act="tamanho" data-id="${t.id}">${t.ativo ? "Desativar" : "Reativar"}</button></div></td></tr>`).join("")
      : `<tr><td colspan="5" class="table-empty">Nenhum tamanho cadastrado.</td></tr>`;
  }

  // Campos de preço do chope novo: refeitos só quando os tamanhos ativos mudam (para não apagar o que já foi digitado)
  let tamanhosDoForm = null;
  function renderPrecosNovo() {
    const lista = ativos().join(",");
    if (lista === tamanhosDoForm) return;
    tamanhosDoForm = lista;
    $("precosNovo").innerHTML = MCPrecos.html({ tamanhos: ativos() });
    MCPrecos.ligar($("precosNovo"));
  }

  async function load() {
    const data = await MC.run(() => Promise.all([
      MC.call("chopes:list", { todos: editar, custos: editar }),
      editar ? MC.call("tamanhos:list", { todos: true }) : Promise.resolve([]),
    ]));
    if (!data) return;
    [chopes, tamanhos] = data;
    chopes.sort(byName);
    renderChopes();
    if (!editar) return;
    renderTamanhos();
    avisoSemPreco();
    renderPrecosNovo();
  }

  /* ---------- Cadastro ---------- */
  $("formChope").addEventListener("submit", async (e) => {
    e.preventDefault();
    let precos = {};
    if (editar) {
      try { precos = MCPrecos.ler($("precosNovo")); } catch (err) { return MC.toast(err.message, "err"); }
    }
    const r = await MC.run(() => MC.call("chopes:create", { nome: $("chopeNome").value, ...precos }));
    if (!r) return;
    MC.toast(`Chope "${r.nome}" cadastrado.`);
    $("chopeNome").value = "";
    tamanhosDoForm = null; // limpa os campos de preço
    load();
  });

  /* ---------- Preços: os atuais, o início e o histórico. Salvar grava linhas novas, sem apagar as antigas. ---------- */
  function historicoHtml(lista) {
    if (!lista.length) return '<p class="t-muted small-note mb-0">Nenhum preço gravado ainda.</p>';
    const reais = MCPrecos.reais;
    return `<h3 class="precos-hist-titulo">Histórico de preços</h3>
      <div class="table-card precos-historico"><table>
        <thead><tr><th>Início</th><th>Tamanho</th><th>Preço do barril</th><th>Custo por litro</th><th>Gravado por</th></tr></thead>
        <tbody>${lista.map((l) => `<tr>
          <td data-label="Início">${MC.fmtDia(l.inicio)}</td>
          <td data-label="Tamanho">${l.tamanho === null ? "Qualquer tamanho" : MC.esc(MC.fmtLitros(l.tamanho))}</td>
          <td data-label="Preço do barril">${l.precoBarril === null ? '<span class="t-muted">—</span>' : reais(l.precoBarril)}</td>
          <td data-label="Custo por litro">${reais(l.custoLitro)}/L</td>
          <td data-label="Gravado por">${MC.esc(l.criadoPor || "—")} <span class="t-muted">${MC.esc(MC.fmtDate(l.criadoEm))}</span></td></tr>`).join("")}</tbody>
      </table></div>`;
  }

  async function precos(c) {
    const info = await MC.run(() => MC.call("chopes:custos", { id: c.id }));
    if (!info) return;
    let caixa = null;
    const r = await MC.dialog({
      title: `Preços de ${info.nome}`,
      intro: "Salvar grava os preços novos a partir do início. Os antigos ficam no histórico e continuam valendo para os barris cadastrados antes.",
      htmlForm: MCPrecos.html({ tamanhos: info.tamanhos, porTamanho: info.porTamanho, custoLitro: info.custoLitro, precos: info.precos, inicio: info.hoje }) +
        historicoHtml(info.historico),
      submitLabel: "Salvar preços",
      onOpen: (overlay) => {
        caixa = overlay;
        overlay.querySelector(".mc-modal").classList.add("mc-modal--precos");
        MCPrecos.ligar(overlay);
      },
      onSubmit: (v) => MC.call("chopes:precos", { id: c.id, ...MCPrecos.ler(caixa) }),
    });
    if (!r) return;
    MC.toast(r.gravadas || r.mudouModo ? `Preços de "${info.nome}" salvos.` : "Nenhum preço mudou.");
    load();
  }

  /* ---------- Edição ---------- */
  async function editChope(c) {
    const saved = await MC.dialog({
      title: `Editar chope ${c.nome}`,
      intro: "O nome novo aparece também em todos os barris deste chope, inclusive no histórico.",
      fields: [{ id: "nome", label: "Nome do chope", value: c.nome }],
      submitLabel: "Salvar",
      onSubmit: (v) => MC.call("chopes:update", { id: c.id, nome: v.nome }),
    });
    if (saved) { MC.toast("Chope atualizado."); load(); }
  }

  /* ---------- Apagar (só o que foi cadastrado errado) ---------- */
  // Chope com barris não é apagado: o servidor explica e sugere desativar ou editar
  async function apagarChope(c) {
    if (!await MC.confirm({
      title: "Apagar chope",
      text: `Apagar o chope "${c.nome}"? Os preços dele também são apagados. Isso não pode ser desfeito.`,
      confirmLabel: "Apagar chope",
      type: "err",
    })) return;
    try {
      await MC.call("chopes:delete", { id: c.id });
    } catch (err) {
      if (err.code === "SESSION" || err.code === "OFFLINE") return MC.toast(err.message, "err");
      return MC.notice({ title: "O chope não foi apagado", text: err.message, type: "err" });
    }
    MC.toast(`Chope "${c.nome}" apagado.`);
    load();
  }

  /* ---------- Tamanhos de barril ---------- */
  $("btnNovoTamanho")?.addEventListener("click", async () => {
    const t = await MCPrecos.novoTamanho();
    if (!t) return;
    MC.toast(`Barril de ${MC.fmtLitros(t.litros)} cadastrado.`);
    load();
  });

  async function alternarTamanho(t) {
    const msg = t.ativo
      ? `Barril de ${MC.fmtLitros(t.litros)} desativado. Ele não aparece mais no cadastro de barril nem nos preços.`
      : `Barril de ${MC.fmtLitros(t.litros)} reativado.`;
    if (await MC.run(() => MC.call("tamanhos:toggle", { id: t.id }), msg)) load();
  }

  /* ---------- Ações das tabelas ---------- */
  document.querySelector("main").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn || !editar) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "tamanho") {
      const t = tamanhos.find((x) => x.id === id);
      return t && alternarTamanho(t);
    }
    const item = chopes.find((x) => x.id === id);
    if (!item) return;
    if (btn.dataset.act === "precos") return precos(item);
    if (btn.dataset.act === "edit") return editChope(item);
    if (btn.dataset.act === "delete") return apagarChope(item);
    const msg = item.ativo ? `Chope "${item.nome}" desativado. Ele não aparece mais no cadastro de barris.` : `Chope "${item.nome}" reativado.`;
    if (await MC.run(() => MC.call("chopes:toggle", { id }), msg)) load();
  });

  load();
})();
