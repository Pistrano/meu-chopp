/* MeuChopp — cadastro e manutenção dos quiosques (somente administrador) */
(async () => {
  const ctx = await MCLayout.init("quiosques");
  if (!ctx) return;

  const tbody = document.getElementById("tbody");
  let list = [];

  async function load() {
    const data = await MC.run(() => MC.call("units:adminList"));
    if (!data) return;
    list = data;
    tbody.innerHTML = list.map((u) => `<tr>
      <td><span class="t-strong">${MC.esc(u.nome)}</span><br><span class="t-muted">${MC.esc(u.nome_curto)}</span></td>
      <td>${u.barris}</td><td>${u.usuarios}</td>
      <td><span class="op-badge op-badge--${u.ativo ? "disponivel" : "inativo"}">${u.ativo ? "Ativo" : "Desativado"}</span></td>
      <td><div class="row-actions">
        <button class="btn-ghost" data-act="edit" data-id="${u.id}">Editar</button>
        <button class="btn-ghost ${u.ativo ? "btn-ghost--danger" : ""}" data-act="toggle" data-id="${u.id}">${u.ativo ? "Desativar" : "Reativar"}</button>
      </div></td></tr>`).join("");
  }

  document.getElementById("formUnit").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ok = await MC.run(() => MC.call("units:create", { nome: nome.value, nomeCurto: curto.value }), "Quiosque cadastrado. Agora libere o acesso na aba Usuários.");
    if (ok) { e.target.reset(); load(); }
  });

  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const u = list.find((x) => x.id === id);
    if (btn.dataset.act === "toggle") {
      if (await MC.run(() => MC.call("units:toggle", { id }), u.ativo ? "Quiosque desativado." : "Quiosque reativado.")) load();
    } else {
      const saved = await MC.dialog({
        title: "Editar quiosque",
        fields: [{ id: "nome", label: "Nome completo", value: u.nome }, { id: "curto", label: "Nome curto", value: u.nome_curto }],
        submitLabel: "Salvar",
        onSubmit: (v) => MC.call("units:update", { id, nome: v.nome, nomeCurto: v.curto }),
      });
      if (saved) { MC.toast("Quiosque atualizado."); load(); }
    }
  });

  load();
})();
