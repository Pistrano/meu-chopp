/* MeuChopp — cadastro e controle de estoque de barris (engate em torneira e retirada) */
(async () => {
  const ctx = await MCLayout.init("barris");
  if (!ctx) return;

  const tbody = document.getElementById("tbody");
  const q = document.getElementById("q");
  const status = document.getElementById("status");
  let rows = [];

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
          <td class="t-strong">#${MC.esc(b.codigo)}</td><td>${MC.esc(b.estilo)}</td><td>${b.tamanho_l} L</td>
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
      intro: `Unidade: ${unidade.nome}. Escolha a torneira em que o barril (${barril.estilo}) será engatado.`,
      fields: [{
        id: "torneira",
        label: "Torneira",
        type: "radios",
        options: torneiras.map((t) => ({
          value: t.id,
          label: `Torneira ${t.numero}`,
          hint: t.ocupada ? `Ocupada · barril #${t.barril}${t.estilo ? ` (${t.estilo})` : ""}` : "Livre",
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
    const estilo = document.getElementById("estilo");
    const ok = await MC.run(
      () => MC.call("barris:create", { codigo: codigo.value, estilo: estilo.value, tamanho: document.getElementById("tamanho").value, unitId: ctx.unitId }),
      "Barril cadastrado."
    );
    if (ok) { codigo.value = ""; estilo.value = ""; codigo.focus(); load(); }
  });

  let t;
  q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(load, 250); });
  status.addEventListener("change", load);
  ctx.onUnitChange = load;
  load();
})();
