/* BarrilFacil — transferências entre quiosques (envio + confirmação de recebimento)
   Envio em grupo: cada etiqueta lida (câmera, pistola ou digitação, em leitor-codigo.js) ou barril escolhido da lista
   entra em "Barris para enviar"; depois, um destino e uma confirmação só. Cria uma transferência por barril
   (transfer:create): se uma falhar, as outras seguem e a tela mostra quais falharam e por quê. */
(async () => {
  const ctx = await MCLayout.init("transferencias");
  if (!ctx) return;

  const tbody = document.getElementById("tbody");
  const selDestino = document.getElementById("destino");
  const listaEl = document.getElementById("listaEnvio");
  const contador = document.getElementById("contador");
  const btnEnviar = document.getElementById("btnEnviar");
  let preselect = Number(new URLSearchParams(location.search).get("barril")) || null; // "Transferir" da aba Barris
  const allUnits = await MC.call("units:all");

  const canAct = (unitId) => ctx.units.some((u) => u.id === unitId); // quiosques liberados para este usuário

  let transfers = [];
  const sorter = MC.sortable(document.querySelector(".table-card table"), {
    0: (t) => t.codigo, 1: (t) => t.origem, 2: (t) => t.solicitante, 3: (t) => t.criado_em, 4: (t) => MC.TRANSFER_LABELS[t.status],
  }, { key: "transferencias", onChange: () => renderTable() });

  /* ---------- Barris para enviar ---------- */
  let grupo = []; // { id, codigo, chope_nome, estilo, tamanho_l, falha? } na ordem em que entraram
  const qtd = (n) => `${n} ${n === 1 ? "barril" : "barris"}`;
  const descricao = (b) => `#${b.codigo} · ${MC.chopeLabel(b) || "Chope"} ${MC.fmtLitros(b.tamanho_l)}`;

  function renderGrupo() {
    contador.textContent = qtd(grupo.length);
    listaEl.innerHTML = grupo.length
      ? grupo.map((b) => `<div class="envio-item${b.falha ? " envio-item--falha" : ""}">
          <div class="envio-item-info"><span class="leitor-codigo">#${MC.esc(b.codigo)}</span>
            <span class="envio-item-chope">${MC.esc(MC.chopeLabel(b) || "Chope")} · ${MC.esc(MC.fmtLitros(b.tamanho_l))}</span>
            ${b.falha ? `<span class="envio-item-falha">Não foi enviado: ${MC.esc(b.falha)}</span>` : ""}</div>
          <button type="button" class="btn-ghost btn-ghost--danger envio-tirar" data-tirar="${b.id}" aria-label="Tirar o barril #${MC.esc(b.codigo)} da lista">Tirar</button>
        </div>`).join("")
      : '<p class="envio-vazio">Nenhum barril ainda. Leia a primeira etiqueta.</p>';
    atualizarEnviar();
  }
  function atualizarEnviar() {
    btnEnviar.disabled = !(grupo.length && selDestino.value);
    btnEnviar.textContent = grupo.length ? `Enviar ${qtd(grupo.length)}` : "Enviar barris";
  }
  const adicionar = (b) => { grupo.push({ id: b.id, codigo: b.codigo, chope_nome: b.chope_nome, estilo: b.estilo, tamanho_l: b.tamanho_l }); renderGrupo(); };

  const leitor = MCLeitor.montar(document.getElementById("leitorEnvio"), {
    unitId: () => ctx.unitId,
    manterFoco: true, // bipar em sequência
    aoAchar: (b) => {
      const porque = MCLeitor.motivo(b, { unitId: ctx.unitId, acao: "enviar", naLista: grupo.map((x) => x.id) });
      if (porque) { leitor.erro(porque); return; }
      adicionar(b);
      leitor.ok(`${descricao(b)} entrou na lista. Leia o próximo.`);
    },
  });

  listaEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tirar]");
    if (!btn) return;
    grupo = grupo.filter((b) => b.id !== Number(btn.dataset.tirar));
    renderGrupo();
    leitor.limpar();
  });
  selDestino.addEventListener("change", atualizarEnviar);

  /* Escolher da lista (sem etiqueta legível): os disponíveis da unidade que ainda não estão no grupo */
  document.getElementById("btnDaLista").addEventListener("click", async () => {
    const disponiveis = await MC.run(() => MC.call("barris:list", { unitId: ctx.unitId, status: "disponivel" }));
    if (!disponiveis) return;
    const fora = disponiveis.filter((b) => !grupo.some((x) => x.id === b.id));
    if (!fora.length) {
      MC.toast(disponiveis.length ? "Todos os barris disponíveis já estão na lista." : "Nenhum barril disponível nesta unidade.", "err");
      return;
    }
    const escolhidos = await MC.dialog({
      title: "Escolher da lista",
      intro: "Marque os barris que vão ser enviados.",
      fields: [{
        id: "barris", label: `Barris disponíveis (${fora.length})`, type: "checks",
        options: fora.map((b) => ({ value: b.id, label: `#${b.codigo} · ${MC.chopeLabel(b) || "Chope"} · ${MC.fmtLitros(b.tamanho_l)}` })),
      }],
      submitLabel: "Adicionar à lista",
      onSubmit: (v) => {
        if (!v.barris.length) throw new Error("Marque ao menos um barril.");
        return v.barris.map(Number);
      },
    });
    if (!Array.isArray(escolhidos)) return;
    fora.filter((b) => escolhidos.includes(b.id)).forEach(adicionar);
    leitor.ok(`${qtd(escolhidos.length)} ${escolhidos.length === 1 ? "entrou" : "entraram"} na lista.`);
  });

  async function loadForm() {
    const atual = selDestino.value;
    const destinos = allUnits.filter((u) => u.id !== ctx.unitId);
    selDestino.innerHTML = '<option value="">Escolha a unidade de destino</option>' +
      destinos.map((u) => `<option value="${u.id}">${MC.esc(u.nome)}</option>`).join("");
    if (destinos.some((u) => String(u.id) === atual)) selDestino.value = atual;
    else if (destinos.length === 1) selDestino.value = String(destinos[0].id);
    // Veio do "Transferir" da aba Barris: o barril já entra na lista
    if (preselect) {
      const id = preselect;
      preselect = null;
      const disponiveis = (await MC.call("barris:list", { unitId: ctx.unitId, status: "disponivel" }).catch(() => [])) || [];
      const b = disponiveis.find((x) => x.id === id);
      if (b && !grupo.some((x) => x.id === b.id)) { adicionar(b); leitor.ok(`${descricao(b)} entrou na lista.`); }
    }
    renderGrupo();
  }

  /* Enviar: uma confirmação com todos os barris e "Quem está fazendo?" (na unidade de origem) */
  btnEnviar.addEventListener("click", async () => {
    if (!grupo.length || !selDestino.value) return;
    const destino = selDestino.selectedOptions[0].textContent;
    const destinoId = Number(selDestino.value);
    const lote = grupo.slice();
    const funcionario = await MC.escolherFuncionario(ctx.unitId);
    if (!await MC.confirm({
      title: "Confirmar envio",
      text: `Enviar ${qtd(lote.length)} para ${destino}? ${lote.length === 1 ? "Ele fica" : "Eles ficam"} aguardando a confirmação de recebimento no destino.`,
      html: `<ul class="envio-confirma">${lote.map((b) => `<li><span class="leitor-codigo">#${MC.esc(b.codigo)}</span> ${MC.esc(MC.chopeLabel(b) || "Chope")} · ${MC.esc(MC.fmtLitros(b.tamanho_l))}</li>`).join("")}</ul>`,
      confirmLabel: `Enviar ${qtd(lote.length)}`,
      funcionario,
    })) return;
    leitor.parar();
    btnEnviar.disabled = true;
    btnEnviar.textContent = "Enviando…";
    const falhas = [];
    for (const b of lote) {
      try {
        await MC.call("transfer:create", { barrilId: b.id, destinoId, funcionarioId: funcionario ? funcionario.id : undefined });
        grupo = grupo.filter((x) => x.id !== b.id);
      } catch (err) {
        falhas.push({ b, msg: err.message });
        const g = grupo.find((x) => x.id === b.id);
        if (g) g.falha = err.message;
        if (err.code === "SESSION") return; // a sessão acabou: o MC.call já levou para a tela de entrar
      }
    }
    const enviados = lote.length - falhas.length;
    renderGrupo();
    reload();
    if (!falhas.length) {
      leitor.limpar();
      MC.toast(`${qtd(enviados)} ${enviados === 1 ? "enviado" : "enviados"} para ${destino}. O destino precisa confirmar o recebimento.`);
      return;
    }
    await MC.notice({
      title: enviados ? `${enviados} de ${lote.length} barris enviados` : "Nenhum barril foi enviado",
      type: "err",
      text: `${falhas.length === 1 ? "Este barril não foi enviado e continua" : "Estes barris não foram enviados e continuam"} na lista:`,
      lines: falhas.map((f) => [`#${f.b.codigo}`, f.msg]),
    });
  });

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

  ctx.onUnitChange = () => { grupo = []; leitor.limpar(); reload(); }; // os barris do grupo eram da outra unidade
  reload();
})();
