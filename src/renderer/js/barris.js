/* BarrilFacil — cadastro e controle de estoque de barris (validade, engate em torneira, retirada e recolhimento) */
(async () => {
  const ctx = await MCLayout.init("barris");
  if (!ctx) return;

  const tbody = document.getElementById("tbody");
  const q = document.getElementById("q");
  const status = document.getElementById("status");
  const selChope = document.getElementById("chope");
  const validade = document.getElementById("validade");
  const statusInicial = new URLSearchParams(location.search).get("status");
  if (ctx.config.hoje) validade.min = ctx.config.hoje; // sem valor pré-preenchido: a pessoa olha a data no barril
  const NOVO = "__novo"; // última opção dos selects: cadastrar um chope/estilo novo
  let rows = [];

  // Busca e filtro de status ficam lembrados ao trocar de aba; as colunas ordenam ao clicar no título
  MC.rememberFields("barris", { q, status });
  if (["disponivel", "em_uso", "em_transferencia", "esgotado", "recolhido"].includes(statusInicial)) status.value = statusInicial;
  const sorter = MC.sortable(document.querySelector(".table-card table"), {
    0: (b) => b.codigo, 1: (b) => MC.chopeLabel(b), 2: (b) => b.tamanho_l, 3: (b) => b.validade,
    4: (b) => MC.STATUS_LABELS[b.status], 5: (b) => b.torneira_numero,
  }, { key: "barris", onChange: () => render() });

  /* ---------- Chope do barril (catálogo) ---------- */
  async function loadChopes(selectId) {
    const list = await MC.run(() => MC.call("chopes:list"));
    if (!list) return;
    list.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));
    selChope.innerHTML = `<option value="">${list.length ? "Escolha o chope" : "Nenhum chope cadastrado"}</option>` +
      list.map((c) => `<option value="${c.id}">${MC.esc(c.nome)} · ${MC.esc(c.estilo)}</option>`).join("") +
      `<option value="${NOVO}">+ Cadastrar novo chope…</option>`;
    selChope.value = selectId ? String(selectId) : "";
  }

  /* Cadastra um chope novo (e, se precisar, um estilo novo) sem sair do cadastro de barril */
  async function novoChope() {
    const estilos = await MC.run(() => MC.call("estilos:list"));
    if (!estilos) { selChope.value = ""; return; }
    estilos.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));
    let estiloCriado = null; // se o chope falhar depois de criar o estilo, não tenta criar o estilo de novo

    const chope = await MC.dialog({
      title: "Cadastrar novo chope",
      intro: "O chope fica disponível para todas as unidades.",
      fields: [
        { id: "nome", label: "Nome do chope", value: "" },
        {
          id: "estilo", label: "Estilo", type: "select", value: "",
          options: [{ value: "", label: "Escolha o estilo" }, ...estilos.map((e) => ({ value: e.id, label: e.nome })), { value: NOVO, label: "+ Novo estilo…" }],
        },
        { id: "novoEstilo", label: "Nome do novo estilo", hidden: true },
      ],
      submitLabel: "Salvar chope",
      onOpen: (overlay) => {
        const sel = overlay.querySelector("#mcf_estilo");
        const box = overlay.querySelector('[data-field="novoEstilo"]');
        sel.addEventListener("change", () => {
          box.classList.toggle("d-none", sel.value !== NOVO);
          if (sel.value === NOVO) overlay.querySelector("#mcf_novoEstilo").focus();
        });
      },
      onSubmit: async (v) => {
        if (!v.nome.trim()) throw new Error("Informe o nome do chope.");
        let estiloId = v.estilo;
        if (!estiloId) throw new Error("Escolha o estilo do chope.");
        if (estiloId === NOVO) {
          const nomeEstilo = v.novoEstilo.trim().replace(/\s+/g, " ");
          if (!nomeEstilo) throw new Error("Informe o nome do novo estilo.");
          const igual = (n) => n.toLowerCase() === nomeEstilo.toLowerCase();
          const existente = estilos.find((e) => igual(e.nome)) || (estiloCriado && igual(estiloCriado.nome) ? estiloCriado : null);
          estiloCriado = existente || (await MC.call("estilos:create", { nome: nomeEstilo }));
          estiloId = estiloCriado.id;
        }
        return MC.call("chopes:create", { nome: v.nome, estiloId: Number(estiloId) });
      },
    });

    if (chope && chope.id) {
      MC.toast(`Chope "${chope.nome}" cadastrado.`);
      await loadChopes(chope.id);
    } else {
      selChope.value = "";
    }
  }

  selChope.addEventListener("change", () => { if (selChope.value === NOVO) novoChope(); });

  function actions(b) {
    if (b.status === "disponivel")
      return `<button class="btn-ghost" data-act="use" data-id="${b.id}">Engatar na torneira</button>
              <a class="btn-ghost text-decoration-none" href="transferencias.html?barril=${b.id}">Transferir</a>`;
    if (b.status === "em_uso") return `<button class="btn-ghost btn-ghost--danger" data-act="empty" data-id="${b.id}">Retirar barril</button>`;
    if (b.status === "esgotado") return `<span class="t-muted">Vazio (aguardando recolhimento)</span>`;
    if (b.status === "recolhido") return "";
    return `<span class="t-muted">Aguardando recebimento</span>`;
  }

  function tapCell(b) {
    if (b.torneira_numero) return `<span class="t-strong">Torneira ${b.torneira_numero}</span>`;
    if (b.status === "em_uso") return `<span class="t-muted">Sem torneira registrada</span>`;
    return `<span class="t-muted">—</span>`;
  }

  function render() {
    const list = sorter.apply(rows);
    tbody.innerHTML = list.length
      ? list.map((b) => `<tr>
          <td class="t-strong">#${MC.esc(b.codigo)}</td>
          <td>${b.chope_nome
            ? `<span class="t-strong">${MC.esc(b.chope_nome)}</span><br><span class="t-muted">${MC.esc(b.estilo)}</span>`
            : MC.esc(b.estilo)}</td>
          <td>${b.tamanho_l} L</td>
          <td><span class="validade-cell">${MC.fmtDia(b.validade)} ${MC.validadeBadge(b.situacao_validade)}</span></td>
          <td><span class="op-badge op-badge--${b.status}">${MC.STATUS_LABELS[b.status]}</span></td>
          <td>${tapCell(b)}</td>
          <td><div class="row-actions">${actions(b)}</div></td></tr>`).join("")
      : `<tr><td colspan="7" class="table-empty">Nenhum barril encontrado nesta unidade.</td></tr>`;
  }

  async function load() {
    const unit = ctx.units.find((u) => u.id === ctx.unitId);
    document.getElementById("subtitle").textContent = `Estoque de ${unit.nome}.`;
    const list = await MC.run(() => MC.call("barris:list", { unitId: ctx.unitId, q: q.value, status: status.value }));
    if (!list) return;
    rows = list;
    render();
  }

  /* ---------- Engate: escolher uma torneira livre da unidade ---------- */
  async function engatar(id) {
    const info = await MC.run(() => MC.call("taps:forBarril", { barrilId: id }));
    if (!info) return;
    const { barril, unidade, torneiras } = info;
    const livres = torneiras.filter((t) => !t.ocupada);

    if (!livres.length) {
      await MC.notice({
        title: "Nenhuma torneira disponível",
        type: "err",
        text: "Não há torneiras disponíveis nesta unidade. Verifique as torneiras cadastradas ou libere uma torneira antes de continuar.",
        lines: [
          ["Unidade", unidade.nome],
          ["Torneiras", torneiras.length ? `${torneiras.length} cadastrada(s), todas ocupadas` : "Nenhuma cadastrada"],
        ],
      });
      return;
    }

    const funcionario = await MC.escolherFuncionario(unidade.id);
    const result = await MC.dialog({
      title: `Engatar barril #${barril.codigo}`,
      intro: `Unidade: ${unidade.nome}. Escolha a torneira em que o barril (${MC.chopeLabel(barril)}) será engatado.`,
      fields: [{
        id: "torneira",
        label: "Torneira",
        type: "radios",
        options: torneiras.map((t) => ({
          value: t.id,
          label: `Torneira ${t.numero}`,
          hint: t.ocupada ? `Ocupada · barril #${t.barril}${t.estilo ? ` (${MC.chopeLabel(t)})` : ""}` : "Livre",
          disabled: t.ocupada,
          checked: livres.length === 1 && !t.ocupada,
        })),
      }],
      submitLabel: "Confirmar engate",
      funcionario,
      // Engate e confirmação de barril vencido ficam em acoes-barril.js (os mesmos da aba Torneiras)
      onSubmit: (v) => {
        if (!v.torneira) throw new Error("Selecione uma torneira livre para continuar.");
        return MCBarril.engatar({ barrilId: id, torneiraId: Number(v.torneira), unitId: ctx.unitId, funcionario });
      },
    });
    if (result && result.torneira) load();
  }

  /* ---------- Retirada: a torneira vem do engate registrado (fluxo em acoes-barril.js) ---------- */
  async function retirar(id) {
    const b = rows.find((r) => r.id === id);
    const unit = ctx.units.find((u) => u.id === ctx.unitId);
    await MCBarril.retirar({ barril: b, unidade: unit.nome, unitId: ctx.unitId, aoRetirar: () => load() });
  }

  /* ---------- Recolhimento: a fábrica leva os vasilhames vazios (usado em pé, no tablet) ---------- */
  const diasVazio = (d) => (d == null ? "" : d < 1 ? "vazio há menos de 1 dia" : `vazio há ${d} dia${d === 1 ? "" : "s"}`);

  async function recolher() {
    const unit = ctx.units.find((u) => u.id === ctx.unitId);
    const vazios = await MC.run(() => MC.call("barris:emptyList", { unitId: ctx.unitId }));
    if (!vazios) return;
    if (!vazios.length) {
      await MC.notice({ title: "Nenhum barril vazio", type: "plain", text: `Não há barris vazios aguardando recolhimento em ${unit.nome}.` });
      return;
    }
    const funcionario = await MC.escolherFuncionario(ctx.unitId);
    const overlay = MC.openOverlay(`<h2>Registrar recolhimento</h2>
      <p class="mc-modal-intro">Marque os barris vazios que a fábrica está levando de ${MC.esc(unit.nome)}.</p>
      <label class="collect-item collect-all"><input type="checkbox" id="colTodos"><span class="collect-main">Marcar todos (${vazios.length})</span></label>
      <div class="collect-list">${vazios.map((b) => `<label class="collect-item">
          <input type="checkbox" value="${b.id}">
          <span class="collect-main">#${MC.esc(b.codigo)} <span class="collect-chope">${MC.esc(MC.chopeLabel(b))}</span></span>
          <span class="collect-hint">${b.tamanho_l} L · ${diasVazio(b.dias)}</span></label>`).join("")}</div>
      ${funcionario ? funcionario.html : ""}
      <div class="field-error" id="colErr" aria-live="polite"></div>
      <div class="mc-modal-actions"><button type="button" class="btn-ghost" data-cancel>Cancelar</button>
      <button type="button" class="btn btn-mc btn-mc-sm" id="colOk" disabled>Marque os barris recolhidos</button></div>`);
    overlay.querySelector(".mc-modal").classList.add("mc-modal--collect");

    const caixas = [...overlay.querySelectorAll(".collect-list input")];
    const todos = overlay.querySelector("#colTodos");
    const okBtn = overlay.querySelector("#colOk");
    const errEl = overlay.querySelector("#colErr");
    const marcados = () => caixas.filter((c) => c.checked).map((c) => Number(c.value));
    const atualizar = () => {
      const n = marcados().length;
      todos.checked = n === caixas.length;
      todos.indeterminate = n > 0 && n < caixas.length;
      okBtn.disabled = n === 0 || !!(funcionario && !funcionario.id); // só depois de marcar e escolher quem está fazendo
      okBtn.textContent = n ? `Confirmar recolhimento de ${n} barri${n === 1 ? "l" : "s"}` : "Marque os barris recolhidos";
      errEl.textContent = "";
    };
    if (funcionario) funcionario.ligar(overlay, atualizar);
    todos.addEventListener("change", () => { caixas.forEach((c) => { c.checked = todos.checked; }); atualizar(); });
    caixas.forEach((c) => c.addEventListener("change", atualizar));
    const fechar = () => overlay.remove();
    overlay.querySelector("[data-cancel]").addEventListener("click", fechar);
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") fechar(); });
    okBtn.addEventListener("click", async () => {
      const ids = marcados();
      const codigos = vazios.filter((b) => ids.includes(b.id)).map((b) => `#${b.codigo}`);
      if (!await MC.confirm({
        title: "Confirmar recolhimento",
        text: `Registrar que ${codigos.length} ${codigos.length === 1 ? "barril foi recolhido" : "barris foram recolhidos"} (${codigos.join(", ")}) pela fábrica? Esta operação altera o estoque da unidade.`,
        confirmLabel: "Registrar recolhimento",
        type: "err",
      })) return;
      okBtn.disabled = true;
      try {
        const r = await MC.call("barris:collect", { ids, unitId: ctx.unitId, funcionarioId: funcionario ? funcionario.id : undefined });
        if (funcionario) funcionario.lembrar();
        fechar();
        const n = r.codigos.length;
        MC.toast(`Recolhimento registrado: ${n} barri${n === 1 ? "l" : "s"} (#${r.codigos.join(", #")}).`);
        load();
        MCLayout.refreshAlerts();
      } catch (err) {
        errEl.textContent = err.message;
        okBtn.disabled = false;
      }
    });
    todos.focus();
  }

  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "use") return engatar(id);
    if (btn.dataset.act === "empty") return retirar(id);
  });

  document.getElementById("btnRecolher").addEventListener("click", recolher);

  document.getElementById("btnExportStock")?.addEventListener("click", async () => {
    const r = await MC.run(() => MC.call("barris:exportStock", { unitId: ctx.unitId }));
    if (!r) return;
    const url = URL.createObjectURL(new Blob([r.csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = r.filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    MC.toast(`Relatório do estoque gerado (${r.total} barris).`, "ok");
  });

  document.getElementById("formBarril").addEventListener("submit", async (e) => {
    e.preventDefault();
    const codigo = document.getElementById("codigo");
    if (!selChope.value || selChope.value === NOVO) return MC.toast("Escolha o chope do barril.", "err");
    if (!validade.value) { validade.focus(); return MC.toast("Informe a data de validade que está no barril.", "err"); }
    // Celular do quiosque (conta de operador): confirma o cadastro escolhendo quem está fazendo. Sem escolha, salva direto.
    const funcionario = await MC.escolherFuncionario(ctx.unitId);
    if (funcionario) {
      if (!codigo.value.replace("#", "").trim()) { codigo.focus(); return MC.toast("Preencha código, chope e tamanho do barril.", "err"); }
      const resumo = [`#${codigo.value.replace("#", "").trim().toUpperCase()}`, selChope.selectedOptions[0].textContent,
        document.getElementById("tamanho").selectedOptions[0].textContent, `validade ${MC.fmtDia(validade.value)}`];
      if (!await MC.confirm({ title: "Cadastrar barril", text: resumo.join(" · "), confirmLabel: "Cadastrar barril", funcionario })) return;
    }
    const ok = await MC.run(
      () => MC.call("barris:create", {
        codigo: codigo.value, chopeId: Number(selChope.value), tamanho: document.getElementById("tamanho").value,
        validade: validade.value, unitId: ctx.unitId, funcionarioId: funcionario ? funcionario.id : undefined,
      }),
      "Barril cadastrado."
    );
    if (ok) { codigo.value = ""; selChope.value = ""; validade.value = ""; codigo.focus(); load(); MCLayout.refreshAlerts(); }
  });

  let t;
  q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(load, 250); });
  status.addEventListener("change", load);
  ctx.onUnitChange = load;
  loadChopes();
  load();
})();
