/* BarrilFacil — transferências entre quiosques (envio + confirmação de recebimento) */
(async () => {
  const ctx = await MCLayout.init("transferencias");
  if (!ctx) return;

  const tbody = document.getElementById("tbody");
  const selBarril = document.getElementById("barril");
  const selDestino = document.getElementById("destino");
  const preselect = Number(new URLSearchParams(location.search).get("barril")) || null;
  const allUnits = await MC.call("units:all");

  const canAct = (unitId) => ctx.units.some((u) => u.id === unitId); // quiosques liberados para este usuário

  let transfers = [];
  const sorter = MC.sortable(document.querySelector(".table-card table"), {
    0: (t) => t.codigo, 1: (t) => t.origem, 2: (t) => t.solicitante, 3: (t) => t.criado_em, 4: (t) => MC.TRANSFER_LABELS[t.status],
  }, { key: "transferencias", onChange: () => renderTable() });

  async function loadForm() {
    const barris = (await MC.call("barris:list", { unitId: ctx.unitId, status: "disponivel" })) || [];
    selBarril.innerHTML = barris.length
      ? barris.map((b) => `<option value="${b.id}" ${b.id === preselect ? "selected" : ""}>#${MC.esc(b.codigo)} · ${MC.esc(MC.chopeLabel(b))} · ${b.tamanho_l} L</option>`).join("")
      : `<option value="">Nenhum barril disponível</option>`;
    selDestino.innerHTML = allUnits
      .filter((u) => u.id !== ctx.unitId)
      .map((u) => `<option value="${u.id}">${MC.esc(u.nome)}</option>`)
      .join("");
  }

  function renderTable() {
    const list = sorter.apply(transfers);
    tbody.innerHTML = list.length
      ? list.map((t) => {
          let act = "";
          if (t.status === "pendente") {
            if (t.destino_id === ctx.unitId && canAct(t.destino_id)) act += `<button class="btn-ghost" data-act="confirm" data-id="${t.id}">Confirmar recebimento</button>`;
            if (t.origem_id === ctx.unitId && canAct(t.origem_id)) act += `<button class="btn-ghost btn-ghost--danger" data-act="cancel" data-id="${t.id}">Cancelar</button>`;
          } else if (t.recebedor) act = `<span class="t-muted">Recebido por ${MC.esc(t.recebedor)}</span>`;
          return `<tr>
            <td><span class="t-strong">#${MC.esc(t.codigo)}</span><br><span class="t-muted">${MC.esc(MC.chopeLabel(t))}</span></td>
            <td>${MC.esc(t.origem)} → ${MC.esc(t.destino)}</td>
            <td>${MC.esc(t.solicitante)}</td><td>${MC.fmtDate(t.criado_em)}</td>
            <td><span class="op-badge op-badge--${t.status}">${MC.TRANSFER_LABELS[t.status]}</span></td>
            <td><div class="row-actions">${act}</div></td></tr>`;
        }).join("")
      : `<tr><td colspan="6" class="table-empty">Nenhuma transferência registrada para esta unidade.</td></tr>`;
  }

  async function loadTable() {
    const list = await MC.run(() => MC.call("transfer:list", { unitId: ctx.unitId }));
    if (!list) return;
    transfers = list;
    renderTable();
  }

  const reload = () => { loadForm(); loadTable(); MCLayout.refreshAlerts(); };

  document.getElementById("formTransfer").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selBarril.value) return MC.toast("Não há barril disponível para transferir.", "err");
    const barril = selBarril.selectedOptions[0].textContent;
    const destino = selDestino.selectedOptions[0] && selDestino.selectedOptions[0].textContent;
    const funcionario = await MC.escolherFuncionario(ctx.unitId); // quem envia, na unidade de origem
    if (!await MC.confirm({
      title: "Confirmar transferência",
      text: `Enviar ${barril} para ${destino}? O barril ficará aguardando a confirmação de recebimento na unidade de destino.`,
      confirmLabel: "Enviar barril",
      funcionario,
    })) return;
    const ok = await MC.run(() => MC.call("transfer:create", {
      barrilId: Number(selBarril.value), destinoId: Number(selDestino.value), funcionarioId: funcionario ? funcionario.id : undefined,
    }), "Transferência iniciada. O destino precisa confirmar o recebimento.");
    if (ok) reload();
  });

  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const transfer = transfers.find((t) => t.id === Number(btn.dataset.id));
    if (!transfer) return loadTable();
    const isReceive = btn.dataset.act === "confirm";
    // Quem recebe (destino) ou quem cancela (origem): nos dois casos, a unidade aberta na tela
    const funcionario = await MC.escolherFuncionario(ctx.unitId);
    const confirmed = await MC.confirm({
      title: isReceive ? "Confirmar recebimento" : "Cancelar transferência",
      text: isReceive
        ? `Confirma que o barril #${transfer.codigo} chegou à unidade ${transfer.destino}?`
        : `Cancelar o envio do barril #${transfer.codigo}? Ele voltará a ficar disponível na unidade de origem.`,
      confirmLabel: isReceive ? "Confirmar recebimento" : "Cancelar transferência",
      type: isReceive ? "plain" : "err",
      funcionario,
    });
    if (!confirmed) return;
    const msg = btn.dataset.act === "confirm" ? "Recebimento confirmado." : "Transferência cancelada.";
    const ok = await MC.run(() => MC.call(`transfer:${btn.dataset.act}`, {
      id: Number(btn.dataset.id), funcionarioId: funcionario ? funcionario.id : undefined,
    }), msg);
    if (ok) reload();
  });

  ctx.onUnitChange = reload;
  reload();
})();
