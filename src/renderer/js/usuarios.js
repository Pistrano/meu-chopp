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

  async function load() {
    const list = await MC.run(() => MC.call("users:list"));
    if (!list) return;
    tbody.innerHTML = list.map((u) => `<tr>
      <td class="t-strong">${MC.esc(u.nome)}</td><td>${MC.esc(u.usuario)}</td>
      <td>${u.cargo === "admin" ? "Administrador" : "Operador"}</td><td>${MC.esc(u.unidade || "Todas")}</td>
      <td><span class="op-badge op-badge--${u.ativo ? "disponivel" : "inativo"}">${u.ativo ? "Ativo" : "Inativo"}</span></td>
      <td><div class="row-actions">
        <button class="btn-ghost" data-act="reset" data-id="${u.id}">Redefinir senha</button>
        ${u.id === ctx.user.id ? "" : `<button class="btn-ghost ${u.ativo ? "btn-ghost--danger" : ""}" data-act="toggle" data-id="${u.id}">${u.ativo ? "Desativar" : "Reativar"}</button>`}
      </div></td></tr>`).join("");
  }

  document.getElementById("formUser").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = { nome: nome.value, usuario: usuario.value, senha: senha.value, cargo: cargo.value, unidadeId: unidade.value };
    const ok = await MC.run(() => MC.call("users:create", f), "Usuário criado.");
    if (ok) { e.target.reset(); syncUnit(); load(); }
  });

  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === "toggle") {
      if (await MC.run(() => MC.call("users:toggle", { id }), "Situação do usuário atualizada.")) load();
    } else {
      const senha = window.prompt("Nova senha para este usuário (mínimo 6 caracteres):");
      if (senha === null) return;
      await MC.run(() => MC.call("users:resetPassword", { id, senha }), "Senha redefinida.");
    }
  });

  load();
})();
