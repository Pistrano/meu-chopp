/* MeuChopp — gestão de usuários (somente administrador) */
(async () => {
  const ctx = await MCLayout.init("usuarios");
  if (!ctx) return;

  const tbody = document.getElementById("tbody");
  const cargo = document.getElementById("cargo");
  const unidade = document.getElementById("unidade");
  const units = await MC.call("units:all");

  unidade.innerHTML = units.map((u) => `<option value="${u.id}">${MC.esc(u.nome_curto)}</option>`).join("");
  const syncUnit = () => { unidade.disabled = cargo.value === "admin"; };
  cargo.addEventListener("change", syncUnit);
  syncUnit();

  function situacao(u) {
    if (!u.ativo) return ["inativo", "Inativo"];
    if (u.bloqueado) return ["bloqueado", "Bloqueado"];
    if (u.trocar_senha || !u.email) return ["primeiro", "Aguardando 1º acesso"];
    return ["disponivel", "Ativo"];
  }

  async function load() {
    const list = await MC.run(() => MC.call("users:list"));
    if (!list) return;
    tbody.innerHTML = list.map((u) => {
      const [cls, label] = situacao(u);
      return `<tr>
        <td class="t-strong">${MC.esc(u.nome)}</td><td>${MC.esc(u.email || u.usuario)}</td>
        <td>${u.cargo === "admin" ? "Administrador" : "Operador"}</td><td>${MC.esc(u.unidade || "Todas")}</td>
        <td><span class="op-badge op-badge--${cls}">${label}</span></td>
        <td><div class="row-actions">
          ${u.bloqueado ? `<button class="btn-ghost" data-act="unlock" data-id="${u.id}">Desbloquear</button>` : ""}
          <button class="btn-ghost" data-act="reset" data-id="${u.id}">Gerar senha temporária</button>
          ${u.id === ctx.user.id ? "" : `<button class="btn-ghost ${u.ativo ? "btn-ghost--danger" : ""}" data-act="toggle" data-id="${u.id}">${u.ativo ? "Desativar" : "Reativar"}</button>`}
        </div></td></tr>`;
    }).join("");
  }

  document.getElementById("formUser").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = { nome: nome.value, email: email.value, cargo: cargo.value, unidadeId: unidade.value };
    const r = await MC.run(() => MC.call("users:create", f));
    if (!r) return;
    e.target.reset(); syncUnit(); load();
    MC.showSecret({ title: "Usuário criado", intro: `Senha temporária para ${r.email}:`, secret: r.senha });
  });

  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "toggle") {
      if (await MC.run(() => MC.call("users:toggle", { id }), "Situação do usuário atualizada.")) load();
    } else if (btn.dataset.act === "unlock") {
      if (await MC.run(() => MC.call("users:unlock", { id }), "Usuário desbloqueado.")) load();
    } else if (btn.dataset.act === "reset") {
      if (!window.confirm("Gerar uma nova senha temporária? A senha atual deixa de funcionar.")) return;
      const r = await MC.run(() => MC.call("users:resetPassword", { id }));
      if (r) { load(); MC.showSecret({ title: "Senha temporária gerada", intro: `Nova senha para ${r.email}:`, secret: r.senha }); }
    }
  });

  load();
})();
