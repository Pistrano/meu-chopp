/* MeuChopp — cadastro e controle de estoque de barris (engate em torneira e retirada) */
(async () => {
  const ctx = await MCLayout.init("barris");
  if (!ctx) return;

  const tbody = document.getElementById("tbody");
  const q = document.getElementById("q");
  const status = document.getElementById("status");
  const selChope = document.getElementById("chope");
  const NOVO = "__novo"; // última opção dos selects: cadastrar um chope/estilo novo
  let rows = [];

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
    if (b.status === "esgotado") return `<button class="btn-ghost" data-act="refill" data-id="${b.id}">Reabastecido</button>`;
    return `<span class="t-muted">Aguardando recebimento</span>`;
  }

  function tapCell(b) {
    if (b.torneira_numero) return `<span class="t-strong">Torneira ${b.torneira_numero}</span>`;
    if (b.status === "em_uso") return `<span class="t-muted">Sem torneira registrada</span>`;
    return `<span class="t-muted">—</span>`;
  }

  async function load() {
    const unit = ctx.units.find((u) => u.id === ctx.unitId);
    document.getElementById("subtitle").textContent = `Estoque de ${unit.nome}.`;
    const list = await MC.run(() => MC.call("barris:list", { unitId: ctx.unitId, q: q.value, status: status.value }));
    if (!list) return;
    rows = list;
    tbody.innerHTML = list.length
      ? list.map((b) => `<tr>
          <td class="t-strong">#${MC.esc(b.codigo)}</td>
          <td>${b.chope_nome
            ? `<span class="t-strong">${MC.esc(b.chope_nome)}</span><br><span class="t-muted">${MC.esc(b.estilo)}</span>`
            : MC.esc(b.estilo)}</td>
          <td>${b.tamanho_l} L</td>
          <td><span class="op-badge op-badge--${b.status}">${MC.STATUS_LABELS[b.status]}</span></td>
          <td>${tapCell(b)}</td>
          <td><div class="row-actions">${actions(b)}</div></td></tr>`).join("")
      : `<tr><td colspan="6" class="table-empty">Nenhum barril encontrado nesta unidade.</td></tr>`;
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
      onSubmit: async (v) => {
        if (!v.torneira) throw new Error("Selecione uma torneira livre para continuar.");
        return MC.call("barris:use", { id, torneiraId: Number(v.torneira), unitId: ctx.unitId });
      },
    });
    if (result && result.torneira) {
      MC.toast(`Barril #${result.codigo} engatado na Torneira ${result.torneira}.`);
      load();
      MCLayout.refreshAlerts();
    }
  }

  /* ---------- Retirada: a torneira vem do engate registrado ---------- */
  async function retirar(id) {
    const b = rows.find((r) => r.id === id);
    const unit = ctx.units.find((u) => u.id === ctx.unitId);
    const result = await MC.dialog({
      title: `Retirar barril #${b.codigo}`,
      intro: b.torneira_numero
        ? `Unidade: ${unit.nome}. O barril está na Torneira ${b.torneira_numero}, que será liberada. Pela regra atual, ao ser retirado o barril passa para "Chopp Esgotado".`
        : `Unidade: ${unit.nome}. Este barril não tem torneira registrada (foi engatado antes do controle de torneiras), então nenhuma torneira será liberada. O barril passa para "Chopp Esgotado".`,
      submitLabel: "Confirmar retirada",
      onSubmit: () => MC.call("barris:empty", { id }),
    });
    if (!result || !result.codigo) return;
    load();
    MCLayout.refreshAlerts();
    await MC.notice({
      title: "Barril retirado com sucesso!",
      lines: [
        ["Barril", `#${result.codigo}`],
        ["Unidade", result.unidade],
        ["Torneira liberada", result.torneira ? `Torneira ${result.torneira}` : "Nenhuma (sem torneira registrada)"],
      ],
    });
  }

  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "use") return engatar(id);
    if (btn.dataset.act === "empty") return retirar(id);
    const ok = await MC.run(() => MC.call("barris:refill", { id }), "Barril disponível novamente.");
    if (ok) load();
  });

  document.getElementById("formBarril").addEventListener("submit", async (e) => {
    e.preventDefault();
    const codigo = document.getElementById("codigo");
    if (!selChope.value || selChope.value === NOVO) return MC.toast("Escolha o chope do barril.", "err");
    const ok = await MC.run(
      () => MC.call("barris:create", { codigo: codigo.value, chopeId: Number(selChope.value), tamanho: document.getElementById("tamanho").value, unitId: ctx.unitId }),
      "Barril cadastrado."
    );
    if (ok) { codigo.value = ""; selChope.value = ""; codigo.focus(); load(); }
  });

  let t;
  q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(load, 250); });
  status.addEventListener("change", load);
  ctx.onUnitChange = load;
  loadChopes();
  load();
})();
