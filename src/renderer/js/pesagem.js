/* BarrilFacil — Mais > Pesagem: inventário da unidade, pesagem avulsa e taras dos vasilhames.
   A pesagem em si (balança ou estimativa e "Quem está fazendo?") é a de acoes-barril.js (MCBarril.pesar). */
(async () => {
  const ctx = await MCLayout.init("pesagem");
  if (!ctx) return;

  const invBox = document.getElementById("inventario");
  const avulsaSel = document.getElementById("avulsaBarril");
  const tbodyTaras = document.getElementById("tbodyTaras");
  const podeEditarTara = MC.pode("catalogo:editar");
  let estado = { inventario: null, ultimo: null, barris: [] };
  let taras = [];
  const unidade = () => ctx.units.find((u) => u.id === ctx.unitId);
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const kg = (n) => Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 2 });

  /* ---------- Inventário ---------- */
  const situacao = (b) => {
    if (b.status === "em_uso") return b.torneira_numero ? `Em uso · Torneira ${b.torneira_numero}` : "Em uso";
    return MC.saldoTexto(b) ? MC.statusTexto(b) : "Disponível · cheio";
  };
  function pesagemCell(b) {
    const p = b.pesagem;
    if (p) {
      return `<span class="t-strong">${p.estimado ? "≈ " : ""}${MC.fmtLitros(p.litros)}</span> <span class="t-muted">(${p.estimado ? "estimado" : "pesado"})</span>
        <br><span class="t-muted">${MC.esc(p.quem || "")} · ${MC.fmtDate(p.criado_em)}</span>`;
    }
    return b.precisa ? '<span class="inv-falta">Falta pesar</span>' : '<span class="t-muted">Cheio: entra como 100% sem pesar</span>';
  }

  function renderInventario() {
    const { inventario, ultimo, barris } = estado;
    const ultimoTxt = ultimo ? `Último inventário concluído em ${MC.fmtDate(ultimo.concluido_em)}.` : "Nenhum inventário concluído nesta unidade ainda.";
    if (!inventario) {
      invBox.innerHTML = `<p class="panel-note">Pese todos os barris engatados e os disponíveis que voltaram de uma torneira com chope.
        Os disponíveis cheios entram como 100%, sem pesar. ${MC.esc(ultimoTxt)}</p>
        <button type="button" class="btn btn-mc btn-mc-sm" data-act="iniciar">Começar inventário</button>`;
      return;
    }
    const precisam = barris.filter((b) => b.precisa);
    const faltam = precisam.filter((b) => !b.pesagem);
    const cheios = barris.filter((b) => !b.precisa && !b.pesagem).length;
    invBox.innerHTML = `<div class="inv-status">
        <span class="op-badge op-badge--em_uso">Em andamento</span>
        <span class="t-muted">Começado em ${MC.fmtDate(inventario.iniciado_em)}${inventario.iniciado_por ? ` por ${MC.esc(inventario.iniciado_por)}` : ""}</span>
        <span class="inv-progresso">${precisam.length - faltam.length} de ${plural(precisam.length, "barril pesado", "barris pesados")}</span>
      </div>
      ${barris.length ? `<div class="table-card"><table>
        <thead><tr><th>Barril</th><th>Tamanho</th><th>Situação</th><th>Pesagem</th><th></th></tr></thead>
        <tbody>${barris.map((b) => `<tr>
          <td><span class="t-strong">#${MC.esc(b.codigo)}</span><br><span class="t-muted">${MC.esc(MC.chopeLabel(b))}</span></td>
          <td>${MC.fmtLitros(b.tamanho_l)}</td>
          <td>${MC.esc(situacao(b))}</td>
          <td>${pesagemCell(b)}</td>
          <td><div class="row-actions"><button type="button" class="${b.precisa && !b.pesagem ? "btn btn-mc btn-mc-sm" : "btn-ghost"}" data-act="pesar" data-id="${b.id}">${b.pesagem ? "Pesar de novo" : "Pesar"}</button></div></td>
        </tr>`).join("")}</tbody></table></div>`
        : '<p class="panel-note">Nenhum barril engatado ou disponível nesta unidade.</p>'}
      <div class="inv-acoes">
        <button type="button" class="btn btn-mc btn-mc-sm" data-act="concluir"${faltam.length ? " disabled" : ""}>Concluir inventário</button>
        ${faltam.length
          ? `<span class="inv-falta">Falta pesar ${plural(faltam.length, "barril", "barris")}.</span>`
          : `<span class="inv-ok">Tudo pesado.${cheios ? ` ${plural(cheios, "barril cheio entra", "barris cheios entram")} como 100%.` : ""}</span>`}
      </div>`;
  }

  async function loadInventario() {
    const r = await MC.run(() => MC.call("inventarios:atual", { unitId: ctx.unitId }));
    if (!r) return;
    estado = r;
    renderInventario();
    document.getElementById("avulsaNota").textContent = estado.inventario
      ? "Há um inventário em andamento: pese pela lista do inventário. Aqui a pesagem fica avulsa, fora do inventário."
      : "Pese um barril engatado ou disponível fora do inventário. No disponível, o resultado passa a ser o saldo do barril.";
  }

  async function iniciar() {
    const r = await MC.run(() => MC.call("inventarios:iniciar", { unitId: ctx.unitId }), "Inventário começado.");
    if (!r) return;
    estado = r;
    renderInventario();
    loadInventario();
  }

  async function concluir() {
    const precisam = estado.barris.filter((b) => b.precisa).length;
    const cheios = estado.barris.filter((b) => !b.precisa && !b.pesagem).length;
    const funcionario = await MC.escolherFuncionario(ctx.unitId);
    const sim = await MC.confirm({
      title: "Concluir inventário",
      text: `Concluir o inventário de ${unidade().nome}? ${plural(precisam, "barril foi pesado", "barris foram pesados")}` +
        (cheios ? ` e ${plural(cheios, "barril cheio entra", "barris cheios entram")} como 100%, sem pesar.` : "."),
      confirmLabel: "Concluir inventário",
      funcionario,
    });
    if (!sim) return;
    try {
      const r = await MC.call("inventarios:concluir", { id: estado.inventario.id, funcionarioId: funcionario ? funcionario.id : undefined });
      await MC.notice({
        title: "Inventário concluído",
        lines: [["Unidade", r.unidade], ["Pesados", String(r.pesados)], ["Cheios (100%, sem pesar)", String(r.cheios)]],
      });
    } catch (err) {
      await MC.notice({ title: "Não foi possível concluir", text: err.message, type: "err" });
    }
    loadInventario();
    loadAvulsa();
  }

  invBox.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "iniciar") return iniciar();
    if (btn.dataset.act === "concluir") return concluir();
    const b = estado.barris.find((x) => x.id === Number(btn.dataset.id));
    if (!b || !estado.inventario) return;
    const r = await MCBarril.pesar({ barril: b, unitId: ctx.unitId, inventarioId: estado.inventario.id });
    if (r) { loadInventario(); loadAvulsa(); loadTaras(); }
  });

  /* ---------- Pesagem avulsa ---------- */
  let avulsos = [];
  async function loadAvulsa() {
    const lista = await MC.run(() => MC.call("barris:list", { unitId: ctx.unitId }));
    if (!lista) return;
    const atual = avulsaSel.value;
    avulsos = lista.filter((b) => b.status === "em_uso" || b.status === "disponivel")
      .sort((a, b) => (a.status === b.status ? 0 : a.status === "em_uso" ? -1 : 1)
        || String(a.codigo).localeCompare(String(b.codigo), "pt-BR", { numeric: true }));
    avulsaSel.innerHTML = avulsos.length
      ? `<option value="">Escolha o barril</option>` + avulsos.map((b) => `<option value="${b.id}">#${MC.esc(b.codigo)} · ${MC.esc(MC.chopeLabel(b))} · ${MC.fmtLitros(b.tamanho_l)} · ${MC.esc(
        b.status === "em_uso" ? (b.torneira_numero ? `Em uso · Torneira ${b.torneira_numero}` : "Em uso") : MC.statusTexto(b))}</option>`).join("")
      : `<option value="">Nenhum barril engatado ou disponível nesta unidade</option>`;
    avulsaSel.value = avulsos.some((b) => String(b.id) === atual) ? atual : "";
  }
  document.getElementById("btnAvulsa").addEventListener("click", async () => {
    const b = avulsos.find((x) => x.id === Number(avulsaSel.value));
    if (!b) { avulsaSel.focus(); return MC.toast("Escolha o barril que vai ser pesado.", "err"); }
    const r = await MCBarril.pesar({ barril: b, unitId: ctx.unitId });
    if (r) { loadAvulsa(); loadInventario(); loadTaras(); }
  });

  /* ---------- Taras dos vasilhames ---------- */
  function renderTaras() {
    tbodyTaras.innerHTML = taras.length
      ? taras.map((t) => {
        const sit = !t.ativo ? ["inativo", "Desativada"] : t.padrao ? ["disponivel", "Padrão"] : ["confirmada", "Ativa"];
        const acoes = podeEditarTara
          ? `<button type="button" class="btn-ghost" data-act="editar" data-id="${t.id}">Editar</button>
             <button type="button" class="btn-ghost" data-act="toggle" data-id="${t.id}">${t.ativo ? "Desativar" : "Reativar"}</button>
             ${t.pesagens ? "" : `<button type="button" class="btn-ghost btn-ghost--danger" data-act="apagar" data-id="${t.id}">Apagar</button>`}`
          : "";
        return `<tr>
          <td class="t-strong">${MC.fmtLitros(t.tamanho_l)}</td>
          <td>${kg(t.peso_kg)} kg</td>
          <td>${t.descricao ? MC.esc(t.descricao) : '<span class="t-muted">—</span>'}</td>
          <td>${MC.fmtDia(String(t.criado_em || "").slice(0, 10))}${t.criado_por ? `<br><span class="t-muted">${MC.esc(t.criado_por)}</span>` : ""}</td>
          <td><span class="op-badge op-badge--${sit[0]}">${sit[1]}</span>${t.pesagens ? `<br><span class="t-muted">${plural(t.pesagens, "pesagem", "pesagens")}</span>` : ""}</td>
          <td><div class="row-actions">${acoes}</div></td></tr>`;
      }).join("")
      : `<tr><td colspan="6" class="table-empty">Nenhuma tara cadastrada. Cadastre o peso do vasilhame vazio de cada tamanho (ou informe na primeira pesagem).</td></tr>`;
  }
  async function loadTaras() {
    const lista = await MC.run(() => MC.call("taras:list", { todos: true }));
    if (!lista) return;
    taras = lista;
    renderTaras();
  }

  // Os tamanhos vêm do cadastro de tamanhos de barril (os ativos, do menor para o maior)
  document.getElementById("btnNovaTara").addEventListener("click", async () => {
    const tamanhos = await MC.run(() => MC.call("tamanhos:list"));
    if (!tamanhos) return;
    const padrao = tamanhos.some((t) => t.litros === 50) ? "50" : String((tamanhos[0] || {}).litros || "");
    const r = await MC.dialog({
      title: "Nova tara de vasilhame",
      intro: "Pese o barril vazio na balança. A tara nova passa a ser a padrão do tamanho.",
      fields: [
        { id: "tamanho", label: "Tamanho do barril", type: "select", value: padrao,
          options: tamanhos.map((t) => ({ value: String(t.litros), label: MC.fmtLitros(t.litros).replace(" L", " litros") })) },
        { id: "peso", label: "Peso do vasilhame vazio (kg)" },
        { id: "descricao", label: "Descrição (opcional)" },
      ],
      submitLabel: "Salvar tara",
      onOpen: (overlay) => { const el = overlay.querySelector("#mcf_peso"); el.setAttribute("inputmode", "decimal"); el.placeholder = "Ex.: 13,5"; },
      onSubmit: (v) => MC.call("taras:create", { tamanho: Number(v.tamanho), pesoKg: v.peso, descricao: v.descricao }),
    });
    if (r && r.id) { MC.toast("Tara cadastrada."); loadTaras(); }
  });

  tbodyTaras.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const t = taras.find((x) => x.id === Number(btn.dataset.id));
    if (!t) return;
    const nome = `tara de ${MC.fmtLitros(t.tamanho_l)} (${kg(t.peso_kg)} kg)`;
    if (btn.dataset.act === "editar") {
      const ok = await MC.dialog({
        title: `Editar tara de ${MC.fmtLitros(t.tamanho_l)}`,
        intro: t.pesagens ? "As pesagens já feitas continuam com o peso antigo." : "",
        fields: [
          { id: "peso", label: "Peso do vasilhame vazio (kg)", value: kg(t.peso_kg) },
          { id: "descricao", label: "Descrição (opcional)", value: t.descricao || "" },
        ],
        submitLabel: "Salvar",
        onOpen: (overlay) => overlay.querySelector("#mcf_peso").setAttribute("inputmode", "decimal"),
        onSubmit: (v) => MC.call("taras:update", { id: t.id, pesoKg: v.peso, descricao: v.descricao }),
      });
      if (ok) { MC.toast("Tara atualizada."); loadTaras(); }
    } else if (btn.dataset.act === "toggle") {
      if (await MC.run(() => MC.call("taras:toggle", { id: t.id }), t.ativo ? "Tara desativada." : "Tara reativada.")) loadTaras();
    } else if (btn.dataset.act === "apagar") {
      if (!await MC.confirm({ title: "Apagar tara", text: `Apagar a ${nome}? Ela nunca foi usada em pesagem.`, confirmLabel: "Apagar tara", type: "err" })) return;
      if (await MC.run(() => MC.call("taras:delete", { id: t.id }), "Tara apagada.")) loadTaras();
    }
  });

  async function load() {
    document.getElementById("subtitle").textContent =
      `Quanto chope tem em cada barril de ${unidade().nome}: inventário, pesagem avulsa e as taras dos vasilhames.`;
    await Promise.all([loadInventario(), loadAvulsa(), loadTaras()]);
  }
  ctx.onUnitChange = load;
  load();
})();
