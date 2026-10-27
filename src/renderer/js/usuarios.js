/* BarrilFacil — gestão de usuários: cargo, acesso de cada um aos quiosques e apagar conta (somente administrador) */
(async () => {
  const ctx = await MCLayout.init("usuarios");
  if (!ctx) return;

  const tbody = document.getElementById("tbody");
  const cargo = document.getElementById("cargo");
  const cargoInfo = document.getElementById("cargoInfo");
  const unitsBox = document.getElementById("unitsBox");
  const unidades = document.getElementById("unidades");
  const units = await MC.call("units:all");

  // O que cada cargo faz (o servidor é quem decide; aqui é só a explicação para quem escolhe)
  const CARGOS = [
    { value: "admin", label: "Administrador", texto: "Tudo, inclusive usuários e exportar." },
    { value: "gerente", label: "Gerente", texto: "O dia a dia, mais catálogo e funcionários do quiosque. Sem mexer em usuários, unidades e cadastro de torneiras, e sem exportar." },
    { value: "operador", label: "Operador", texto: "O dia a dia das lojas: barris, engates, transferências e relatório, sem exportar." },
  ];
  const cargoLabel = (c) => (CARGOS.find((x) => x.value === c) || { label: c }).label;

  unidades.innerHTML = units
    .map((u) => `<label class="check-item"><input type="checkbox" value="${u.id}"><span>${MC.esc(u.nome_curto)}</span></label>`)
    .join("") || `<span class="t-muted">Cadastre uma unidade primeiro (aba Unidades).</span>`;
  cargoInfo.innerHTML = CARGOS.map((c) => `<li data-cargo="${c.value}"><strong>${c.label}:</strong> ${MC.esc(c.texto)}</li>`).join("");
  const syncCargo = () => {
    unitsBox.classList.toggle("d-none", cargo.value === "admin");
    cargoInfo.querySelectorAll("li").forEach((li) => li.classList.toggle("is-sel", li.dataset.cargo === cargo.value));
  };
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
    0: (u) => u.nome, 1: (u) => u.email || u.usuario, 2: (u) => cargoLabel(u.cargo),
    3: (u) => (u.cargo === "admin" ? "Todas" : u.unidades.join(", ")), 4: (u) => situacao(u)[1],
  }, { key: "usuarios", onChange: () => render() });

  function render() {
    tbody.innerHTML = sorter.apply(users).map((u) => {
      const [cls, label] = situacao(u);
      const quiosques = u.cargo === "admin" ? "Todas" : u.unidades.length ? MC.esc(u.unidades.join(", ")) : '<span class="t-muted">Nenhuma</span>';
      return `<tr>
        <td class="t-strong">${MC.esc(u.nome)}</td><td>${MC.esc(u.email || u.usuario)}</td>
        <td>${MC.esc(cargoLabel(u.cargo))}</td><td>${quiosques}</td>
        <td><span class="op-badge op-badge--${cls}">${label}</span></td>
        <td><div class="row-actions">
          ${u.id === ctx.user.id ? "" : `<button class="btn-ghost" data-act="cargo" data-id="${u.id}">Cargo</button>`}
          ${u.cargo !== "admin" ? `<button class="btn-ghost" data-act="units" data-id="${u.id}">Unidades</button>` : ""}
          ${u.bloqueado ? `<button class="btn-ghost" data-act="unlock" data-id="${u.id}">Desbloquear</button>` : ""}
          <button class="btn-ghost" data-act="reset" data-id="${u.id}">Gerar senha temporária</button>
          ${u.id === ctx.user.id ? "" : `<button class="btn-ghost ${u.ativo ? "btn-ghost--danger" : ""}" data-act="toggle" data-id="${u.id}">${u.ativo ? "Desativar" : "Reativar"}</button>`}
          ${u.id === ctx.user.id ? "" : `<button class="btn-ghost btn-ghost--apagar" data-act="delete" data-id="${u.id}">Apagar</button>`}
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
    } else if (btn.dataset.act === "cargo") {
      trocarCargo(user);
    } else if (btn.dataset.act === "delete") {
      apagar(user);
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

  /* Trocar o cargo. Gerente e operador precisam de ao menos uma unidade; administrador vê todas. */
  async function trocarCargo(user) {
    const saved = await MC.dialog({
      title: `Cargo de ${user.nome}`,
      intro: "A pessoa vê o menu do cargo novo na próxima tela que abrir.",
      fields: [
        { id: "cargo", label: "Cargo", type: "radios", hintTexto: true,
          options: CARGOS.map((c) => ({ value: c.value, label: c.value === user.cargo ? `${c.label} (atual)` : c.label, hint: c.texto, checked: c.value === user.cargo })) },
        { id: "ids", label: "Unidades que esta pessoa pode acessar", type: "checks", hidden: user.cargo === "admin",
          options: units.map((u) => ({ value: u.id, label: u.nome_curto, checked: user.unidadeIds.includes(u.id) })) },
      ],
      submitLabel: "Salvar cargo",
      onOpen: (overlay) => {
        const box = overlay.querySelector('[data-field="ids"]');
        overlay.querySelector("#mcf_cargo").addEventListener("change", (e) => box.classList.toggle("d-none", e.target.value === "admin"));
      },
      onSubmit: async (v) => {
        if (!v.cargo) throw new Error("Escolha o cargo.");
        await MC.call("users:setRole", { id: user.id, cargo: v.cargo, unidadeIds: v.cargo === "admin" ? [] : v.ids.map(Number) });
        return v.cargo;
      },
    });
    if (saved) { MC.toast(`${user.nome} agora é ${cargoLabel(saved)}.`); load(); }
  }

  /* Apagar de vez. Sem histórico: só confirma. Com histórico: só passando o histórico para a outra conta da pessoa. */
  async function apagar(user) {
    const prev = await MC.run(() => MC.call("users:deletePreview", { id: user.id }));
    if (!prev) return;
    const quem = `${prev.usuario.nome} (${prev.usuario.email})`;

    if (!prev.total) {
      if (!await MC.confirm({
        title: "Apagar usuário",
        text: `Apagar ${quem}? Isso não pode ser desfeito.`,
        confirmLabel: "Apagar usuário",
        type: "err",
      })) return;
      if (await MC.run(() => MC.call("users:delete", { id: user.id }))) {
        MC.toast(`${prev.usuario.nome} foi apagado.`);
        load();
      }
      return;
    }

    const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
    const contagens = [
      ["Engates", plural(prev.engates, "engate", "engates")],
      ["Movimentações", plural(prev.movimentacoes, "movimentação", "movimentações")],
      ["Transferências", plural(prev.transferencias, "transferência", "transferências")],
    ];
    const r = await MC.dialog({
      title: "Apagar usuário com histórico",
      type: "err",
      intro: `${quem} tem histórico no sistema:`,
      html: `<dl class="notice-lines mb-3">${contagens.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
        <p class="apagar-aviso">Use só quando for a mesma pessoa com outra conta (por exemplo, cadastro com e-mail errado). Se a pessoa saiu da empresa, desative em vez de apagar.</p>`,
      fields: [{
        id: "destino", label: "Passar o histórico para", type: "select", value: "",
        options: [{ value: "", label: "Escolha a outra conta da pessoa" }]
          .concat(prev.outros.map((o) => ({ value: o.id, label: `${o.nome} (${o.email})${o.ativo ? "" : " · inativo"}` }))),
      }],
      submitLabel: "Passar histórico e apagar",
      onOpen: (overlay) => {
        const sel = overlay.querySelector("#mcf_destino");
        const ok = overlay.querySelector('[type="submit"]');
        const sync = () => { ok.disabled = !sel.value; };
        sel.addEventListener("change", sync);
        sync();
      },
      onSubmit: async (v) => {
        if (!v.destino) throw new Error("Escolha para quem passar o histórico.");
        const res = await MC.call("users:delete", { id: user.id, destinoId: Number(v.destino) });
        return { res, destino: prev.outros.find((o) => o.id === Number(v.destino)) };
      },
    });
    if (!r) return;
    MC.toast(`${prev.usuario.nome} foi apagado. O histórico (${plural(r.res.total, "registro", "registros")}) passou para ${r.destino ? r.destino.nome : "a outra conta"}.`);
    load();
  }

  load();
})();
