/* BarrilFacil — cadastro das unidades (lojas) e de suas torneiras (somente administrador) */
(async () => {
  const ctx = await MCLayout.init("quiosques");
  if (!ctx) return;

  const $ = (id) => document.getElementById(id);
  const tbody = $("tbody");
  const detail = $("detail");
  let list = [];
  let current = null; // unidade aberta nos detalhes

  MC.maskCnpj($("cnpj"));

  const missing = (u) => !u.cnpj || !u.endereco;
  const pendente = '<span class="op-badge op-badge--primeiro">A preencher</span>';

  /* ---------- Lista de unidades ---------- */
  async function load() {
    const data = await MC.run(() => MC.call("units:adminList"));
    if (!data) return;
    list = data;

    const faltando = list.filter((u) => u.ativo && missing(u));
    const note = $("pendingNote");
    note.classList.toggle("d-none", !faltando.length);
    note.textContent = faltando.length
      ? `${faltando.map((u) => u.nome).join(", ")} ainda ${faltando.length > 1 ? "estão" : "está"} sem CNPJ ou localização. Use "Editar" para completar os dados.`
      : "";

    tbody.innerHTML = list.map((u) => `<tr class="${current && current.id === u.id ? "is-selected" : ""}">
      <td><span class="t-strong">${MC.esc(u.nome)}</span><br><span class="t-muted">${MC.esc(u.nome_curto)}</span></td>
      <td class="cell-nowrap">${u.cnpjFormatado ? MC.esc(u.cnpjFormatado) : pendente}</td>
      <td class="cell-address">${u.endereco ? MC.esc(u.endereco) : pendente}</td>
      <td>${u.torneiras}${u.torneiras ? ` <span class="t-muted">· ${u.torneirasOcupadas} ocupada${u.torneirasOcupadas === 1 ? "" : "s"}</span>` : ""}</td>
      <td>${u.barris}</td><td>${u.usuarios}</td>
      <td><span class="op-badge op-badge--${u.ativo ? "disponivel" : "inativo"}">${u.ativo ? "Ativa" : "Desativada"}</span></td>
      <td><div class="row-actions row-actions--nowrap">
        <button class="btn-ghost" data-act="open" data-id="${u.id}">Torneiras</button>
        <button class="btn-ghost" data-act="edit" data-id="${u.id}">Editar</button>
        <button class="btn-ghost ${u.ativo ? "btn-ghost--danger" : ""}" data-act="toggle" data-id="${u.id}">${u.ativo ? "Desativar" : "Reativar"}</button>
      </div></td></tr>`).join("");
  }

  /* ---------- Cadastro ---------- */
  $("formUnit").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await MC.run(
      () => MC.call("units:create", { nome: $("nome").value, nomeCurto: $("curto").value, cnpj: $("cnpj").value, endereco: $("endereco").value }),
      "Unidade cadastrada. Agora cadastre as torneiras e libere o acesso na aba Usuários."
    );
    if (r) { e.target.reset(); await load(); openDetail(r.id); }
  });

  /* ---------- Edição ---------- */
  async function editUnit(id) {
    const u = list.find((x) => x.id === id);
    const saved = await MC.dialog({
      title: "Editar unidade",
      intro: missing(u) ? "Preencha o CNPJ e a localização reais desta unidade." : "",
      fields: [
        { id: "nome", label: "Nome da unidade", value: u.nome },
        { id: "curto", label: "Nome curto", value: u.nome_curto },
        { id: "cnpj", label: "CNPJ", value: u.cnpjFormatado || "" },
        { id: "endereco", label: "Localização (rua, número, bairro, cidade, estado e CEP)", value: u.endereco || "" },
      ],
      submitLabel: "Salvar",
      onOpen: (overlay) => MC.maskCnpj(overlay.querySelector("#mcf_cnpj")),
      onSubmit: (v) => MC.call("units:update", { id, nome: v.nome, nomeCurto: v.curto, cnpj: v.cnpj, endereco: v.endereco }),
    });
    if (saved) {
      MC.toast("Dados da unidade atualizados.");
      await load();
      if (current && current.id === id) openDetail(id);
    }
  }

  /* ---------- Detalhes + torneiras ---------- */
  async function openDetail(id) {
    const d = await MC.run(() => MC.call("units:details", { id }));
    if (!d) return;
    current = d;
    detail.classList.remove("d-none");
    $("detailTitle").textContent = d.nome;
    $("detailSub").textContent = d.ativo ? "Unidade ativa" : "Unidade desativada";
    const ativas = d.torneiras.filter((t) => t.ativo);
    const facts = [
      ["CNPJ", d.cnpjFormatado || "A preencher"],
      ["Localização", d.endereco || "A preencher"],
      ["Torneiras ativas", String(ativas.length)],
      ["Ocupadas agora", String(ativas.filter((t) => t.ocupada).length)],
    ];
    $("detailFacts").innerHTML = facts.map(([k, v]) => `<div><dt>${MC.esc(k)}</dt><dd>${MC.esc(v)}</dd></div>`).join("");
    $("formTaps").classList.toggle("d-none", !d.ativo);

    $("tbodyTaps").innerHTML = d.torneiras.length
      ? d.torneiras.map((t) => {
          const situacao = !t.ativo ? ["inativo", "Desativada"] : t.ocupada ? ["em_uso", "Ocupada"] : ["disponivel", "Livre"];
          const acts = [`<button class="btn-ghost" data-tap="renumber" data-id="${t.id}">Alterar número</button>`];
          // Só mostra "Desativar" quando a torneira está livre (ocupada não pode ser desativada)
          if (t.ativo && !t.ocupada) acts.push(`<button class="btn-ghost btn-ghost--danger" data-tap="toggle" data-id="${t.id}">Desativar</button>`);
          if (!t.ativo) acts.push(`<button class="btn-ghost" data-tap="toggle" data-id="${t.id}">Reativar</button>`);
          return `<tr>
            <td class="t-strong">Torneira ${t.numero}</td>
            <td><span class="op-badge op-badge--${situacao[0]}">${situacao[1]}</span></td>
            <td>${t.ocupada ? `<span class="t-strong">#${MC.esc(t.codigo)}</span> <span class="t-muted">${MC.esc(MC.chopeLabel(t))}</span>` : '<span class="t-muted">—</span>'}</td>
            <td>${t.ocupada ? `${MC.fmtDate(t.engatado_em)} <span class="t-muted">por ${MC.esc(t.engatado_por)}</span>` : '<span class="t-muted">—</span>'}</td>
            <td>${t.usos}</td>
            <td><div class="row-actions">${acts.join("")}</div></td></tr>`;
        }).join("")
      : `<tr><td colspan="6" class="table-empty">Nenhuma torneira cadastrada nesta unidade. Use "Adicionar torneiras" acima.</td></tr>`;

    // Marca a linha da unidade aberta na lista
    tbody.querySelectorAll("tr").forEach((tr) => tr.classList.toggle("is-selected", !!tr.querySelector(`[data-act="open"][data-id="${id}"]`)));
  }

  $("formTaps").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!current) return;
    const r = await MC.run(() => MC.call("taps:create", { unitId: current.id, quantidade: Number($("qtd").value) }));
    if (!r) return;
    MC.toast(r.numeros.length === 1 ? `Torneira ${r.numeros[0]} cadastrada.` : `Torneiras ${r.numeros[0]} a ${r.numeros[r.numeros.length - 1]} cadastradas.`);
    $("qtd").value = 1;
    openDetail(current.id);
    load();
  });

  $("tbodyTaps").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-tap]");
    if (!btn || !current) return;
    const t = current.torneiras.find((x) => x.id === Number(btn.dataset.id));
    if (btn.dataset.tap === "renumber") {
      const saved = await MC.dialog({
        title: `Alterar número da Torneira ${t.numero}`,
        intro: "O histórico continua mostrando o número que a torneira tinha em cada operação.",
        fields: [{ id: "numero", label: "Novo número", type: "number", value: t.numero }],
        submitLabel: "Salvar",
        onSubmit: (v) => MC.call("taps:update", { id: t.id, numero: Number(v.numero) }),
      });
      if (saved) { MC.toast("Número da torneira atualizado."); openDetail(current.id); }
    } else {
      if (t.ativo && !await MC.confirm({
        title: `Desativar Torneira ${t.numero}`,
        text: "A torneira deixará de aparecer como opção para engatar barris.",
        confirmLabel: "Desativar torneira",
        type: "err",
      })) return;
      const ok = await MC.run(() => MC.call("taps:toggle", { id: t.id }), t.ativo ? `Torneira ${t.numero} desativada.` : `Torneira ${t.numero} reativada.`);
      if (ok) { openDetail(current.id); load(); }
    }
  });

  $("btnEditDetail").addEventListener("click", () => current && editUnit(current.id));
  $("btnCloseDetail").addEventListener("click", () => {
    current = null;
    detail.classList.add("d-none");
    tbody.querySelectorAll("tr").forEach((tr) => tr.classList.remove("is-selected"));
  });

  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const u = list.find((x) => x.id === id);
    if (btn.dataset.act === "open") {
      await openDetail(id);
      detail.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (btn.dataset.act === "edit") {
      editUnit(id);
    } else {
      if (u.ativo && !await MC.confirm({
        title: "Desativar unidade",
        text: `Desativar ${u.nome}? Ela deixará de operar no sistema até ser reativada.`,
        confirmLabel: "Desativar unidade",
        type: "err",
      })) return;
      if (!await MC.run(() => MC.call("units:toggle", { id }), u.ativo ? "Unidade desativada." : "Unidade reativada.")) return;
      await load();
      if (current && current.id === id) openDetail(id);
    }
  });

  await load();
  const fromUrl = Number(new URLSearchParams(location.search).get("id"));
  if (fromUrl && list.some((u) => u.id === fromUrl)) openDetail(fromUrl);
})();
