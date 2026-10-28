/* BarrilFacil — funcionários do quiosque (administrador e gerente). No celular da loja, que fica logado numa conta
   de operador compartilhada, a pessoa toca no próprio nome antes de salvar cada ação. A lista é da unidade aberta
   no cabeçalho; o gerente só vê e cadastra nas unidades liberadas para ele. Funcionário não é apagado, só desativado. */
(async () => {
  const ctx = await MCLayout.init("funcionarios");
  if (!ctx) return;

  const tbody = document.getElementById("tbody");
  const nome = document.getElementById("nome");
  const unidades = document.getElementById("unidades");

  // Unidades que esta pessoa pode usar no cadastro (as do seletor do cabeçalho); a unidade aberta vem marcada
  const checks = (marcadas) => ctx.units
    .map((u) => `<label class="check-item"><input type="checkbox" value="${u.id}" ${marcadas.includes(u.id) ? "checked" : ""}><span>${MC.esc(u.nome_curto)}</span></label>`)
    .join("");
  const marcarUnidadeAberta = () => { unidades.innerHTML = checks([ctx.unitId]); };

  let lista = [];
  const sorter = MC.sortable(document.querySelector(".table-card table"), {
    0: (f) => f.nome, 1: (f) => f.unidades.join(", "), 2: (f) => (f.ativo ? "Ativo" : "Desativado"),
  }, { key: "funcionarios", onChange: () => render() });

  function render() {
    const unit = ctx.units.find((u) => u.id === ctx.unitId);
    tbody.innerHTML = lista.length
      ? sorter.apply(lista).map((f) => `<tr>
          <td class="t-strong">${MC.esc(f.nome)}</td>
          <td>${MC.esc(f.unidades.join(", "))}</td>
          <td><span class="op-badge op-badge--${f.ativo ? "disponivel" : "inativo"}">${f.ativo ? "Ativo" : "Desativado"}</span></td>
          <td><div class="row-actions">
            <button class="btn-ghost" data-act="edit" data-id="${f.id}">Editar</button>
            <button class="btn-ghost ${f.ativo ? "btn-ghost--danger" : ""}" data-act="toggle" data-id="${f.id}">${f.ativo ? "Desativar" : "Reativar"}</button>
          </div></td></tr>`).join("")
      : `<tr><td colspan="4" class="table-empty">Nenhum funcionário cadastrado em ${MC.esc(unit ? unit.nome : "esta unidade")}.</td></tr>`;
  }

  async function load() {
    const unit = ctx.units.find((u) => u.id === ctx.unitId);
    document.getElementById("subtitle").textContent =
      `Quem trabalha em ${unit.nome}. No celular do quiosque, a pessoa toca no próprio nome antes de salvar cada ação.`;
    const r = await MC.run(() => MC.call("funcionarios:list", { unitId: ctx.unitId }));
    if (!r) return;
    lista = r;
    render();
  }

  document.getElementById("formFunc").addEventListener("submit", async (e) => {
    e.preventDefault();
    const unidadeIds = [...unidades.querySelectorAll("input:checked")].map((i) => Number(i.value));
    const r = await MC.run(() => MC.call("funcionarios:create", { nome: nome.value, unidadeIds }));
    if (!r) return;
    MC.toast(`Funcionário cadastrado: ${r.nome}.`);
    nome.value = "";
    marcarUnidadeAberta();
    nome.focus();
    load();
  });

  async function editar(f) {
    const ok = await MC.dialog({
      title: `Editar ${f.nome}`,
      fields: [
        { id: "nome", label: "Nome", value: f.nome },
        { id: "unidades", label: "Unidades onde trabalha", type: "checks", options: ctx.units.map((u) => ({ value: u.id, label: u.nome_curto, checked: f.unidadeIds.includes(u.id) })) },
      ],
      submitLabel: "Salvar",
      onSubmit: (v) => MC.call("funcionarios:update", { id: f.id, nome: v.nome, unidadeIds: v.unidades.map(Number) }),
    });
    if (ok) { MC.toast("Funcionário atualizado."); load(); }
  }

  async function alternar(f) {
    if (f.ativo && !await MC.confirm({
      title: `Desativar ${f.nome}?`,
      text: "O nome deixa de aparecer na escolha de quem está fazendo, em todas as unidades. O histórico dessa pessoa continua guardado e você pode reativar depois.",
      confirmLabel: "Desativar",
      type: "err",
    })) return;
    const ok = await MC.run(() => MC.call("funcionarios:toggle", { id: f.id }), f.ativo ? `Funcionário desativado: ${f.nome}.` : `Funcionário reativado: ${f.nome}.`);
    if (ok) load();
  }

  tbody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const f = lista.find((x) => x.id === Number(btn.dataset.id));
    if (!f) return;
    if (btn.dataset.act === "edit") editar(f);
    else alternar(f);
  });

  ctx.onUnitChange = () => { marcarUnidadeAberta(); load(); };
  marcarUnidadeAberta();
  load();
})();
