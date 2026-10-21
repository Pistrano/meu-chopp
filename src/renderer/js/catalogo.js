/* BarrilFacil — catálogo de chopes e estilos
   Todos veem a lista e cadastram chope e estilo novos. Editar, desativar e reativar: só administrador
   (os botões nem aparecem para os outros, e o servidor também bloqueia). */
(async () => {
  const ctx = await MCLayout.init("catalogo");
  if (!ctx) return;

  const $ = (id) => document.getElementById(id);
  const admin = ctx.user.cargo === "admin";
  if (!admin) {
    document.querySelectorAll(".admin-only").forEach((el) => el.remove()); // só ativos aparecem: a coluna Situação não diz nada
    $("subtitle").textContent = "Catálogo usado no cadastro de barris. Para editar ou desativar um chope ou estilo, fale com um administrador.";
  }
  const byName = (a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" });
  let chopes = [];
  let estilos = [];

  const badge = (ativo) =>
    `<span class="op-badge op-badge--${ativo ? "disponivel" : "inativo"}">${ativo ? "Ativo" : "Desativado"}</span>`;
  const actions = (tipo, x) => `<div class="row-actions">
      <button class="btn-ghost" data-tipo="${tipo}" data-act="edit" data-id="${x.id}">Editar</button>
      <button class="btn-ghost ${x.ativo ? "btn-ghost--danger" : ""}" data-tipo="${tipo}" data-act="toggle" data-id="${x.id}">${x.ativo ? "Desativar" : "Reativar"}</button>
    </div>`;

  async function load() {
    const data = await MC.run(() => Promise.all([MC.call("chopes:list", { todos: admin }), MC.call("estilos:list", { todos: admin })]));
    if (!data) return;
    [chopes, estilos] = data;
    chopes.sort(byName);
    estilos.sort(byName);

    $("tbodyChopes").innerHTML = chopes.length
      ? chopes.map((c) => `<tr>
          <td class="t-strong">${MC.esc(c.nome)}</td><td>${MC.esc(c.estilo)}</td>
          ${admin ? `<td>${badge(c.ativo)}</td><td>${actions("chope", c)}</td>` : ""}</tr>`).join("")
      : `<tr><td colspan="${admin ? 4 : 2}" class="table-empty">Nenhum chope cadastrado ainda.</td></tr>`;

    $("tbodyEstilos").innerHTML = estilos.length
      ? estilos.map((e) => `<tr>
          <td class="t-strong">${MC.esc(e.nome)}</td>
          ${admin ? `<td>${badge(e.ativo)}</td><td>${actions("estilo", e)}</td>` : ""}</tr>`).join("")
      : `<tr><td colspan="${admin ? 3 : 1}" class="table-empty">Nenhum estilo cadastrado ainda.</td></tr>`;

    const ativos = estilos.filter((e) => e.ativo);
    const sel = $("chopeEstilo");
    const atual = sel.value;
    sel.innerHTML = `<option value="">${ativos.length ? "Escolha o estilo" : "Cadastre um estilo primeiro"}</option>` +
      ativos.map((e) => `<option value="${e.id}">${MC.esc(e.nome)}</option>`).join("");
    if (ativos.some((e) => String(e.id) === atual)) sel.value = atual;
  }

  /* ---------- Cadastro ---------- */
  $("formChope").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!$("chopeEstilo").value) return MC.toast("Escolha o estilo do chope.", "err");
    const r = await MC.run(() => MC.call("chopes:create", { nome: $("chopeNome").value, estiloId: Number($("chopeEstilo").value) }));
    if (!r) return;
    MC.toast(`Chope "${r.nome}" cadastrado.`);
    e.target.reset();
    load();
  });

  $("formEstilo").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await MC.run(() => MC.call("estilos:create", { nome: $("estiloNome").value }));
    if (!r) return;
    MC.toast(`Estilo "${r.nome}" cadastrado.`);
    e.target.reset();
    load();
  });

  /* ---------- Edição ---------- */
  async function editChope(c) {
    // O estilo atual aparece mesmo se estiver desativado, para não trocar sem querer
    const opcoes = estilos.filter((e) => e.ativo || e.id === c.estilo_id)
      .map((e) => ({ value: e.id, label: e.ativo ? e.nome : `${e.nome} (desativado)` }));
    const saved = await MC.dialog({
      title: `Editar chope ${c.nome}`,
      intro: "O nome e o estilo novos aparecem também em todos os barris deste chope, inclusive no histórico.",
      fields: [
        { id: "nome", label: "Nome do chope", value: c.nome },
        { id: "estilo", label: "Estilo", type: "select", value: c.estilo_id, options: opcoes },
      ],
      submitLabel: "Salvar",
      onSubmit: (v) => MC.call("chopes:update", { id: c.id, nome: v.nome, estiloId: Number(v.estilo) }),
    });
    if (saved) { MC.toast("Chope atualizado."); load(); }
  }

  async function editEstilo(e) {
    const saved = await MC.dialog({
      title: `Editar estilo ${e.nome}`,
      intro: "O nome novo aparece também em todos os barris dos chopes deste estilo, inclusive no histórico.",
      fields: [{ id: "nome", label: "Nome do estilo", value: e.nome }],
      submitLabel: "Salvar",
      onSubmit: (v) => MC.call("estilos:update", { id: e.id, nome: v.nome }),
    });
    if (saved) { MC.toast("Estilo atualizado."); load(); }
  }

  /* ---------- Ações das tabelas ---------- */
  document.querySelector("main").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-tipo]");
    if (!btn || !admin) return;
    const id = Number(btn.dataset.id);
    const chope = btn.dataset.tipo === "chope";
    const item = (chope ? chopes : estilos).find((x) => x.id === id);
    if (!item) return;
    if (btn.dataset.act === "edit") return chope ? editChope(item) : editEstilo(item);

    const canal = chope ? "chopes:toggle" : "estilos:toggle";
    const msg = chope
      ? (item.ativo ? `Chope "${item.nome}" desativado. Ele não aparece mais no cadastro de barris.` : `Chope "${item.nome}" reativado.`)
      : (item.ativo ? `Estilo "${item.nome}" desativado. Ele não aparece mais para novos chopes.` : `Estilo "${item.nome}" reativado.`);
    if (await MC.run(() => MC.call(canal, { id }), msg)) load();
  });

  load();
})();
