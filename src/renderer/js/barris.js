/* MeuChopp — cadastro e controle de estoque de barris */
(async () => {
  const ctx = await MCLayout.init("barris");
  if (!ctx) return;

  const tbody = document.getElementById("tbody");
  const q = document.getElementById("q");
  const status = document.getElementById("status");

  function actions(b) {
    if (b.status === "disponivel")
      return `<button class="btn-ghost" data-act="use" data-id="${b.id}">Iniciar uso</button>
              <a class="btn-ghost text-decoration-none" href="transferencias.html?barril=${b.id}">Transferir</a>`;
    if (b.status === "em_uso") return `<button class="btn-ghost btn-ghost--danger" data-act="empty" data-id="${b.id}">Marcar esgotado</button>`;
    if (b.status === "esgotado") return `<button class="btn-ghost" data-act="refill" data-id="${b.id}">Reabastecido</button>`;
    return `<span class="t-muted">Aguardando recebimento</span>`;
  }

  async function load() {
    const unit = ctx.units.find((u) => u.id === ctx.unitId);
    document.getElementById("subtitle").textContent = `Estoque de ${unit.nome}.`;
    const list = await MC.run(() => MC.call("barris:list", { unitId: ctx.unitId, q: q.value, status: status.value }));
    if (!list) return;
    tbody.innerHTML = list.length
      ? list.map((b) => `<tr>
          <td class="t-strong">#${MC.esc(b.codigo)}</td><td>${MC.esc(b.estilo)}</td><td>${b.tamanho_l} L</td>
          <td><span class="op-badge op-badge--${b.status}">${MC.STATUS_LABELS[b.status]}</span></td>
          <td><div class="row-actions">${actions(b)}</div></td></tr>`).join("")
      : `<tr><td colspan="5" class="table-empty">Nenhum barril encontrado nesta unidade.</td></tr>`;
  }

  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const msgs = { use: "Barril em uso.", empty: "Barril marcado como esgotado.", refill: "Barril disponível novamente." };
    const ok = await MC.run(() => MC.call(`barris:${btn.dataset.act}`, { id: Number(btn.dataset.id) }), msgs[btn.dataset.act]);
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
