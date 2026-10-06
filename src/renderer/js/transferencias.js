/* MeuChopp — transferências entre quiosques (envio + confirmação de recebimento) */
(async () => {
  const ctx = await MCLayout.init("transferencias");
  if (!ctx) return;

  const tbody = document.getElementById("tbody");
  const selBarril = document.getElementById("barril");
  const selDestino = document.getElementById("destino");
  const preselect = Number(new URLSearchParams(location.search).get("barril")) || null;
  const allUnits = await MC.call("units:all");

  const canAct = (unitId) => ctx.user.cargo === "admin" || ctx.user.unidade_id === unitId;

  async function loadForm() {
    const barris = (await MC.call("barris:list", { unitId: ctx.unitId, status: "disponivel" })) || [];
    selBarril.innerHTML = barris.length
      ? barris.map((b) => `<option value="${b.id}" ${b.id === preselect ? "selected" : ""}>#${MC.esc(b.codigo)} · ${MC.esc(b.estilo)} · ${b.tamanho_l} L</option>`).join("")
      : `<option value="">Nenhum barril disponível</option>`;
    selDestino.innerHTML = allUnits
      .filter((u) => u.id !== ctx.unitId)
      .map((u) => `<option value="${u.id}">${MC.esc(u.nome)}</option>`)
      .join("");
  }

  async function loadTable() {
    const list = await MC.run(() => MC.call("transfer:list", { unitId: ctx.unitId }));
    if (!list) return;
    tbody.innerHTML = list.length
      ? list.map((t) => {
          let act = "";
          if (t.status === "pendente") {
            if (t.destino_id === ctx.unitId && canAct(t.destino_id)) act += `<button class="btn-ghost" data-act="confirm" data-id="${t.id}">Confirmar recebimento</button>`;
            if (t.origem_id === ctx.unitId && canAct(t.origem_id)) act += `<button class="btn-ghost btn-ghost--danger" data-act="cancel" data-id="${t.id}">Cancelar</button>`;
          } else if (t.recebedor) act = `<span class="t-muted">Recebido por ${MC.esc(t.recebedor)}</span>`;
          return `<tr>
            <td><span class="t-strong">#${MC.esc(t.codigo)}</span><br><span class="t-muted">${MC.esc(t.estilo)}</span></td>
            <td>${MC.esc(t.origem)} → ${MC.esc(t.destino)}</td>
            <td>${MC.esc(t.solicitante)}</td><td>${MC.fmtDate(t.criado_em)}</td>
            <td><span class="op-badge op-badge--${t.status}">${MC.TRANSFER_LABELS[t.status]}</span></td>
            <td><div class="row-actions">${act}</div></td></tr>`;
        }).join("")
      : `<tr><td colspan="6" class="table-empty">Nenhuma transferência registrada para esta unidade.</td></tr>`;
  }

  const reload = () => { loadForm(); loadTable(); MCLayout.refreshAlerts(); };

  document.getElementById("formTransfer").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selBarril.value) return MC.toast("Não há barril disponível para transferir.", "err");
    const ok = await MC.run(() => MC.call("transfer:create", { barrilId: Number(selBarril.value), destinoId: Number(selDestino.value) }), "Transferência iniciada. O destino precisa confirmar o recebimento.");
    if (ok) reload();
  });

  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "cancel" && !window.confirm("Cancelar esta transferência? O barril volta a ficar disponível.")) return;
    const msg = btn.dataset.act === "confirm" ? "Recebimento confirmado." : "Transferência cancelada.";
    const ok = await MC.run(() => MC.call(`transfer:${btn.dataset.act}`, { id: Number(btn.dataset.id) }), msg);
    if (ok) reload();
  });

  ctx.onUnitChange = reload;
  reload();
})();
