/* BarrilFacil — gestão de usuários e do acesso de cada um aos quiosques (somente administrador) */
(async () => {
  const ctx = await MCLayout.init("usuarios");
  if (!ctx) return;

  const tbody = document.getElementById("tbody");
  const cargo = document.getElementById("cargo");
  const unitsBox = document.getElementById("unitsBox");
  const unidades = document.getElementById("unidades");
  const units = await MC.call("units:all");

  unidades.innerHTML = units
    .map((u) => `<label class="check-item"><input type="checkbox" value="${u.id}"><span>${MC.esc(u.nome_curto)}</span></label>`)
    .join("") || `<span class="t-muted">Cadastre uma unidade primeiro (aba Unidades).</span>`;
  const syncCargo = () => unitsBox.classList.toggle("d-none", cargo.value === "admin");
  cargo.addEventListener("change", syncCargo);
  syncCargo();

  function situacao(u) {
    if (!u.ativo) return ["inativo", "Inativo"];
    if (u.bloqueado) return ["bloqueado", "Bloqueado"];
    if (u.trocar_senha || !u.email) return ["primeiro", "Aguardando 1º acesso"];
    return ["disponivel", "Ativo"];
  }

  let users = [];
  const sorter = MC.sortable(document.querySelector(".table-card table"), {
    0: (u) => u.nome, 1: (u) => u.email || u.usuario, 2: (u) => u.cargo,
    3: (u) => (u.cargo === "admin" ? "Todas" : u.unidades.join(", ")), 4: (u) => situacao(u)[1],
  }, { key: "usuarios", onChange: () => render() });

  function render() {
    tbody.innerHTML = sorter.apply(users).map((u) => {
      const [cls, label] = situacao(u);
      const quiosques = u.cargo === "admin" ? "Todas" : u.unidades.length ? MC.esc(u.unidades.join(", ")) : '<span class="t-muted">Nenhuma</span>';
      return `<tr>
        <td class="t-strong">${MC.esc(u.nome)}</td><td>${MC.esc(u.email || u.usuario)}</td>
        <td>${u.cargo === "admin" ? "Administrador" : "Operador"}</td><td>${quiosques}</td>
        <td><span class="op-badge op-badge--${cls}">${label}</span></td>
        <td><div class="row-actions">
          ${u.cargo === "operador" ? `<button class="btn-ghost" data-act="units" data-id="${u.id}">Unidades</button>` : ""}
          ${u.bloqueado ? `<button class="btn-ghost" data-act="unlock" data-id="${u.id}">Desbloquear</button>` : ""}
          <button class="btn-ghost" data-act="reset" data-id="${u.id}">Gerar senha temporária</button>
          ${u.id === ctx.user.id ? "" : `<button class="btn-ghost ${u.ativo ? "btn-ghost--danger" : ""}" data-act="toggle" data-id="${u.id}">${u.ativo ? "Desativar" : "Reativar"}</button>`}
        </div></td></tr>`;
    }).join("");
  }

  async function load() {
    const list = await MC.run(() => MC.call("users:list"));
    if (!list) return;
    users = list;
    render();
  }

  document.getElementById("formUser").addEventListener("submit", async (e) => {
    e.preventDefault();
    const unidadeIds = [...unidades.querySelectorAll("input:checked")].map((i) => Number(i.value));
    const f = { nome: nome.value, email: email.value, cargo: cargo.value, unidadeIds };
    const r = await MC.run(() => MC.call("users:create", f));
    if (!r) return;
    e.target.reset(); syncCargo(); load();
    MC.showSecret({ title: "Usuário criado", intro: `Senha temporária para ${r.email}:`, secret: r.senha });
  });

  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const user = users.find((u) => u.id === id);
    if (btn.dataset.act === "toggle") {
      if (user.ativo && !await MC.confirm({
        title: "Desativar usuário",
        text: `Desativar ${user.nome}? A pessoa perderá acesso ao BarrilFácil.`,
        confirmLabel: "Desativar usuário",
        type: "err",
      })) return;
      if (await MC.run(() => MC.call("users:toggle", { id }), "Situação do usuário atualizada.")) load();
    } else if (btn.dataset.act === "unlock") {
      if (await MC.run(() => MC.call("users:unlock", { id }), "Usuário desbloqueado.")) load();
    } else if (btn.dataset.act === "units") {
      const saved = await MC.dialog({
        title: `Unidades de ${user.nome}`,
        intro: "Marque as unidades que esta pessoa pode acessar. Ela só vê e altera o que for marcado.",
        fields: [{ id: "ids", label: "Unidades", type: "checks", options: units.map((u) => ({ value: u.id, label: u.nome_curto, checked: user.unidadeIds.includes(u.id) })) }],
        submitLabel: "Salvar acesso",
        onSubmit: (v) => MC.call("users:setUnits", { id, unidadeIds: v.ids.map(Number) }),
      });
      if (saved) { MC.toast("Acesso atualizado."); load(); }
    } else if (btn.dataset.act === "reset") {
      if (!await MC.confirm({
        title: "Gerar senha temporária",
        text: `A senha atual de ${user.nome} deixará de funcionar. Deseja continuar?`,
        confirmLabel: "Gerar nova senha",
        type: "err",
      })) return;
      const r = await MC.run(() => MC.call("users:resetPassword", { id }));
      if (r) { load(); MC.showSecret({ title: "Senha temporária gerada", intro: `Nova senha para ${r.email}:`, secret: r.senha }); }
    }
  });

  load();
})();
