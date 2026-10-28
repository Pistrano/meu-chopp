/* BarrilFacil — utilitários compartilhados pelas telas */
const MC = (() => {
  const OP_LABELS = { entrada: "Entrada", transferencia: "Transferência", utilizacao: "Utilização", esgotado: "Vazio", recolhimento: "Recolhimento" };
  // Rótulo curto (badge). Nos detalhes, o vazio aparece como "Vazio (aguardando recolhimento)".
  const STATUS_LABELS = { disponivel: "Disponível", em_uso: "Em uso", em_transferencia: "Em transferência", esgotado: "Vazio", recolhido: "Recolhido" };
  const TRANSFER_LABELS = { pendente: "Pendente", confirmada: "Confirmada", cancelada: "Cancelada" };

  /* Permissões de quem está logado (vêm do servidor em auth:me; o MCLayout.init guarda aqui).
     MC.pode("exportar") no lugar de comparar cargos. O servidor confere de novo em cada ação. */
  let permissoes = [];
  let cargo = null;
  const setUser = (user) => { permissoes = (user && user.permissoes) || []; cargo = (user && user.cargo) || null; };
  const pode = (perm) => permissoes.includes(perm);

  /* Chama o sistema (processo principal). Lança erro com a mensagem amigável. */
  async function call(channel, payload) {
    const res = await window.api.invoke(channel, payload);
    if (!res.ok) {
      const page = location.pathname;
      if (res.code === "SESSION" && !page.endsWith("index.html")) { clearRemembered(); location.href = "index.html?expirada=1"; }
      if (res.code === "MUST_CHANGE" && !page.endsWith("primeiro-acesso.html")) location.href = "primeiro-acesso.html";
      const err = new Error(res.error);
      err.code = res.code;
      err.info = res.info; // dados extras de alguns erros (ex.: validade do barril vencido)
      throw err;
    }
    return res.data;
  }

  function esc(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  /* Chope do barril com o estilo: "German Pilsen · Pilsen". Barris antigos (sem chope) mostram só o estilo. */
  function chopeLabel(b) {
    if (!b) return "";
    return b.chope_nome ? `${b.chope_nome} · ${b.estilo || ""}` : b.estilo || "";
  }

  /* Validade: "2026-10-22" -> "22/10/2026" e o selo de alerta (amarelo: vence hoje/amanhã; vermelho: vencido) */
  const fmtDia = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "");
  const VALIDADE_SELO = { vence_amanha: ["vence", "Vence amanhã"], vence_hoje: ["vence", "Vence hoje"], vencido: ["vencido", "Vencido"] };
  function validadeBadge(situacao) {
    const selo = VALIDADE_SELO[situacao];
    return selo ? `<span class="op-badge op-badge--${selo[0]}">${selo[1]}</span>` : "";
  }

  /* "2026-10-06 14:32:10" -> "06/10 14:32" */
  function fmtDate(s) {
    if (!s) return "";
    const [d, t] = s.split(" ");
    const [, m, day] = d.split("-");
    return `${day}/${m} ${t.slice(0, 5)}`;
  }

  let toastTimer;
  function toast(message, type = "ok") {
    let el = document.getElementById("toastMc");
    if (!el) {
      el = document.createElement("div");
      el.id = "toastMc";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.className = `toast-mc toast-mc--${type}`;
    el.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 4000);
  }

  /* Executa uma ação e mostra sucesso/erro para o usuário */
  async function run(fn, successMsg) {
    try {
      const r = await fn();
      if (successMsg) toast(successMsg, "ok");
      return r;
    } catch (e) {
      toast(e.message, "err");
      return undefined;
    }
  }

  /* ---------- Regras de senha (a validação final é feita no sistema) ---------- */
  function passwordChecks(pw) {
    return [
      { ok: pw.length >= 8, text: "Pelo menos 8 caracteres" },
      { ok: /[A-Za-z]/.test(pw), text: "Uma letra" },
      { ok: /\d/.test(pw), text: "Um número" },
    ];
  }
  function bindPasswordRules(input, listEl) {
    const render = () => {
      listEl.innerHTML = passwordChecks(input.value)
        .map((c) => `<li class="${c.ok ? "ok" : ""}">${c.ok ? "✓" : "○"} ${c.text}</li>`)
        .join("");
    };
    input.addEventListener("input", render);
    render();
  }

  /* ---------- Janela de diálogo (substitui prompt/confirm: senhas ficam ocultas) ---------- */
  function openOverlay(innerHtml) {
    const overlay = document.createElement("div");
    overlay.className = "mc-overlay";
    overlay.innerHTML = `<div class="mc-modal" role="dialog" aria-modal="true">${innerHtml}</div>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  /* fields: [{id,label,type,autocomplete,hidden}]. onSubmit(values) pode lançar erro: ele aparece no diálogo.
     type "radios": options [{value,label,hint,disabled,checked}] — escolha única (ex.: torneira).
       hintTexto: true = a dica é uma explicação (cinza), não uma situação (verde).
     type "select": options [{value,label}] + value (opção já escolhida).
     hidden: o campo começa escondido (o onOpen mostra quando precisar, pelo [data-field="id"]).
     html: conteúdo extra (já escapado) entre a introdução e os campos. type "err": título em vermelho.
     onOpen(overlay): chamado depois que o diálogo aparece (ex.: aplicar máscara de CNPJ).
     funcionario: a escolha de MC.escolherFuncionario (ou null). A grade de nomes vai antes dos botões e o confirmar
       só habilita depois que a pessoa toca num nome. */
  function dialog({ title, intro, html = "", type = "", fields = [], submitLabel = "Confirmar", rules = false, onSubmit, onOpen, funcionario = null }) {
    return new Promise((resolve) => {
      const radios = (f) => `<fieldset class="mb-3"><legend class="form-label">${esc(f.label)}</legend>
          <div class="radio-list" id="mcf_${f.id}">${f.options
            .map((o) => `<label class="radio-item${o.disabled ? " is-disabled" : ""}">
              <input type="radio" name="mcf_${f.id}" value="${esc(o.value)}" ${o.disabled ? "disabled" : ""} ${o.checked ? "checked" : ""}>
              <span class="radio-main">${esc(o.label)}</span>${o.hint ? `<span class="radio-hint${f.hintTexto ? " radio-hint--texto" : ""}">${esc(o.hint)}</span>` : ""}</label>`)
            .join("")}</div></fieldset>`;
      const inputs = fields
        .map((f) =>
          f.type === "radios" ? radios(f) : f.type === "checks"
            ? `<div class="mb-3${f.hidden ? " d-none" : ""}" data-field="${f.id}"><div class="form-label">${esc(f.label)}</div><div class="check-list" id="mcf_${f.id}">${f.options
                .map((o) => `<label class="check-item"><input type="checkbox" value="${esc(o.value)}" ${o.checked ? "checked" : ""}><span>${esc(o.label)}</span></label>`)
                .join("")}</div></div>`
            : f.type === "select"
            ? `<div class="mb-3${f.hidden ? " d-none" : ""}" data-field="${f.id}"><label class="form-label" for="mcf_${f.id}">${esc(f.label)}</label>
          <select class="form-select" id="mcf_${f.id}">${f.options
            .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? "") ? "selected" : ""}>${esc(o.label)}</option>`)
            .join("")}</select></div>`
            : `<div class="mb-3${f.hidden ? " d-none" : ""}" data-field="${f.id}"><label class="form-label" for="mcf_${f.id}">${esc(f.label)}</label>
          <input class="form-control" id="mcf_${f.id}" type="${f.type || "text"}" autocomplete="${f.autocomplete || "off"}" value="${esc(f.value || "")}"></div>`
        )
        .join("");
      const overlay = openOverlay(`<h2${type ? ` class="notice-title notice-title--${type}"` : ""}>${esc(title)}</h2>${intro ? `<p class="mc-modal-intro">${esc(intro)}</p>` : ""}${html}
        <form novalidate>${inputs}${funcionario ? funcionario.html : ""}${rules ? '<ul class="pw-rules" id="mcRules"></ul>' : ""}
        <div class="field-error" id="mcErr" aria-live="polite"></div>
        <div class="mc-modal-actions"><button type="button" class="btn-ghost" data-cancel>Cancelar</button>
        <button type="submit" class="btn btn-mc btn-mc-sm">${esc(submitLabel)}</button></div></form>`);

      const form = overlay.querySelector("form");
      const errEl = overlay.querySelector("#mcErr");
      const first = overlay.querySelector("input:not([disabled])");
      if (rules) bindPasswordRules(overlay.querySelector(`#mcf_${rules}`), overlay.querySelector("#mcRules"));
      const close = (value) => { overlay.remove(); resolve(value); };

      overlay.querySelector("[data-cancel]").addEventListener("click", () => close(false));
      overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(false); });
      if (funcionario) {
        const btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        funcionario.ligar(overlay, () => { btn.disabled = false; errEl.textContent = ""; });
      }
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (funcionario && !funcionario.id) { errEl.textContent = "Toque no seu nome em \"Quem está fazendo?\"."; return; }
        const values = {};
        fields.forEach((f) => {
          const el = overlay.querySelector(`#mcf_${f.id}`);
          if (f.type === "checks") values[f.id] = [...el.querySelectorAll("input:checked")].map((i) => i.value);
          else if (f.type === "radios") values[f.id] = (el.querySelector("input:checked") || {}).value || "";
          else values[f.id] = el.value;
        });
        const btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        errEl.textContent = "";
        try {
          const result = await onSubmit(values);
          if (funcionario) funcionario.lembrar();
          close(result === undefined ? true : result);
        } catch (err) {
          errEl.textContent = err.message;
          btn.disabled = false;
        }
      });
      if (onOpen) onOpen(overlay);
      if (first) first.focus();
    });
  }

  /* Aviso com botão único (ex.: "Barril retirado com sucesso!"). lines: [[rótulo, valor], ...]
     html: conteúdo extra já escapado (ex.: histórico de uma torneira). */
  function notice({ title, text, lines = [], html = "", type = "ok", buttonLabel = "OK" }) {
    return new Promise((resolve) => {
      const overlay = openOverlay(`<h2 class="notice-title notice-title--${type}">${esc(title)}</h2>
        ${text ? `<p class="mc-modal-intro">${esc(text)}</p>` : ""}
        ${lines.length ? `<dl class="notice-lines">${lines.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}
        ${html}
        <div class="mc-modal-actions"><button type="button" class="btn btn-mc btn-mc-sm" id="mcOk">${esc(buttonLabel)}</button></div>`);
      const close = () => { overlay.remove(); resolve(true); };
      overlay.querySelector("#mcOk").addEventListener("click", close);
      overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
      overlay.querySelector("#mcOk").focus();
    });
  }

  /* Pergunta com dois botões. Resolve true se a pessoa confirmar.
     funcionario: a escolha de MC.escolherFuncionario (ou null); o confirmar só habilita depois da escolha
     e quem chamou lê o escolhido em funcionario.id. */
  function confirm({ title, text, confirmLabel = "Confirmar", cancelLabel = "Cancelar", type = "plain", funcionario = null }) {
    return new Promise((resolve) => {
      const overlay = openOverlay(`<h2 class="notice-title notice-title--${type}">${esc(title)}</h2>
        ${text ? `<p class="mc-modal-intro">${esc(text)}</p>` : ""}${funcionario ? funcionario.html : ""}
        <div class="mc-modal-actions"><button type="button" class="btn-ghost" data-cancel>${esc(cancelLabel)}</button>
        <button type="button" class="btn btn-mc btn-mc-sm" data-ok${funcionario ? " disabled" : ""}>${esc(confirmLabel)}</button></div>`);
      const close = (v) => { overlay.remove(); resolve(v); };
      const okBtn = overlay.querySelector("[data-ok]");
      if (funcionario) funcionario.ligar(overlay, () => { okBtn.disabled = false; });
      overlay.querySelector("[data-cancel]").addEventListener("click", () => close(false));
      okBtn.addEventListener("click", () => {
        if (funcionario && !funcionario.id) return;
        if (funcionario) funcionario.lembrar();
        close(true);
      });
      overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(false); });
      overlay.querySelector("[data-cancel]").focus();
    });
  }

  /* ---------- Quem está fazendo? ----------
     O celular de cada loja fica logado numa conta de operador compartilhada. Antes de salvar uma ação com barril
     (cadastrar, engatar, retirar, recolher e as transferências), a pessoa toca no próprio nome, dentro da confirmação.
     Administrador e gerente usam conta pessoal e não escolhem: a ação fica no nome da conta.
     Unidade sem funcionários ativos: não pergunta, para não travar a loja (o servidor confere de novo).
     Retorna null quando não há escolha. Senão, um objeto para pôr na confirmação (MC.dialog e MC.confirm aceitam
     { funcionario } e fazem tudo; nas janelas próprias, use direto):
       html                        a grade de nomes, em ordem alfabética
       ligar(overlay, aoEscolher)  liga os botões; aoEscolher() avisa a janela para habilitar o confirmar
       id                          o funcionário escolhido (null até a pessoa tocar num nome)
       lembrar()                   guarda neste aparelho quem fez: nos próximos 30 min o nome aparece primeiro,
                                   destacado, mas ainda precisa ser tocado */
  const ULTIMO_FUNC = "bf:ultimoFuncionario";
  const ULTIMO_FUNC_MS = 30 * 60 * 1000;
  async function escolherFuncionario(unitId) {
    if (cargo !== "operador") return null;
    let lista;
    try { lista = await call("funcionarios:list", { unitId }); } catch (_) { return null; } // sem a lista, o servidor decide
    if (!lista || !lista.length) return null;
    let ultimo = null;
    try { ultimo = JSON.parse(localStorage.getItem(ULTIMO_FUNC)); } catch (_) { /* sem armazenamento: sem destaque */ }
    const recente = ultimo && Date.now() - ultimo.em < ULTIMO_FUNC_MS ? lista.find((f) => f.id === ultimo.id) : null;
    const nomes = [...lista].sort((a, b) => collator.compare(a.nome, b.nome));
    const ordem = recente ? [recente, ...nomes.filter((f) => f !== recente)] : nomes;
    const escolha = {
      id: null,
      html: `<fieldset class="func-pick"><legend class="form-label">Quem está fazendo?</legend>
        <div class="func-grid" role="radiogroup" aria-label="Quem está fazendo?">${ordem.map((f) => `
          <button type="button" class="func-btn${f === recente ? " func-btn--ultimo" : ""}" role="radio" aria-checked="false" data-func="${f.id}">
            <span class="func-nome">${esc(f.nome)}</span>${f === recente ? '<span class="func-tag">Último a usar</span>' : ""}</button>`).join("")}</div></fieldset>`,
      ligar(overlay, aoEscolher) {
        const botoes = [...overlay.querySelectorAll(".func-btn")];
        botoes.forEach((b) => b.addEventListener("click", () => {
          botoes.forEach((x) => { x.classList.toggle("is-selected", x === b); x.setAttribute("aria-checked", String(x === b)); });
          escolha.id = Number(b.dataset.func);
          if (aoEscolher) aoEscolher(escolha.id);
        }));
      },
      lembrar() {
        if (!escolha.id) return;
        try { localStorage.setItem(ULTIMO_FUNC, JSON.stringify({ id: escolha.id, em: Date.now() })); } catch (_) { /* só não lembra */ }
      },
    };
    return escolha;
  }

  /* Máscara de CNPJ (numérico ou alfanumérico): 00.000.000/0000-00. A validação final é no servidor. */
  function formatCnpjInput(value) {
    const c = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 14);
    const parts = [c.slice(0, 2), c.slice(2, 5), c.slice(5, 8), c.slice(8, 12), c.slice(12, 14)];
    let out = parts[0];
    if (parts[1]) out += "." + parts[1];
    if (parts[2]) out += "." + parts[2];
    if (parts[3]) out += "/" + parts[3];
    if (parts[4]) out += "-" + parts[4];
    return out;
  }
  function maskCnpj(input) {
    input.setAttribute("maxlength", "18");
    input.setAttribute("autocapitalize", "characters");
    const apply = () => { input.value = formatCnpjInput(input.value); };
    input.addEventListener("input", apply);
    apply();
  }

  /* Mostra uma senha temporária uma única vez para o administrador repassar */
  function showSecret({ title, intro, secret }) {
    return new Promise((resolve) => {
      const overlay = openOverlay(`<h2>${esc(title)}</h2><p class="mc-modal-intro">${esc(intro)}</p>
        <div class="secret-box" id="mcSecret">${esc(secret)}</div>
        <p class="mc-modal-intro">Anote ou copie agora: <strong>esta senha não será exibida de novo</strong>. A pessoa será obrigada a criar uma senha própria no primeiro acesso.</p>
        <div class="mc-modal-actions"><button type="button" class="btn-ghost" id="mcCopy">Copiar senha</button>
        <button type="button" class="btn btn-mc btn-mc-sm" id="mcDone">Fechar</button></div>`);
      overlay.querySelector("#mcCopy").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(secret); toast("Senha copiada."); }
        catch (_) { toast("Não foi possível copiar. Selecione a senha e use Ctrl+C.", "err"); }
      });
      overlay.querySelector("#mcDone").addEventListener("click", () => { overlay.remove(); resolve(true); });
      overlay.querySelector("#mcDone").focus();
    });
  }

  /* ---------- Filtros e ordem lembrados ----------
     Ficam no sessionStorage: valem enquanto a janela estiver aberta (dá para ir de uma aba a outra
     e voltar sem perder a busca) e somem ao fechar ou ao sair do sistema (outra pessoa no mesmo PC
     não herda a tela de quem saiu). Nada disso vai para o servidor. */
  const MEM = "bf:";
  const memGet = (k) => { try { return JSON.parse(sessionStorage.getItem(MEM + k)); } catch (_) { return null; } };
  const memSet = (k, v) => { try { sessionStorage.setItem(MEM + k, JSON.stringify(v)); } catch (_) { /* sem armazenamento: só não lembra */ } };
  function clearRemembered() {
    try { Object.keys(sessionStorage).filter((k) => k.startsWith(MEM)).forEach((k) => sessionStorage.removeItem(k)); } catch (_) { /* ignora */ }
  }

  /* fields: { nome: elemento } (campo de busca, select de filtro...). Chame ANTES da primeira carga da lista. */
  function rememberFields(page, fields) {
    const key = `filtros:${page}`;
    const saved = memGet(key) || {};
    Object.entries(fields).forEach(([name, el]) => {
      if (typeof saved[name] !== "string") return;
      el.value = saved[name];
      if (el.tagName === "SELECT" && el.selectedIndex < 0) el.selectedIndex = 0; // opção que não existe mais
    });
    const save = () => memSet(key, Object.fromEntries(Object.entries(fields).map(([n, el]) => [n, el.value])));
    Object.values(fields).forEach((el) => { el.addEventListener("input", save); el.addEventListener("change", save); });
  }

  /* ---------- Ordenar tabelas clicando no cabeçalho ----------
     columns: { posição da coluna: (linha) => valor para ordenar }. As colunas que não entram (ações,
     observações) ficam como estão. Clique: crescente, depois decrescente, depois ordem original.
     Vazios ficam sempre no fim. Retorna { apply(rows) }: use no lugar da lista ao desenhar a tabela.
     A ordem vale para as linhas já carregadas (o servidor continua devolvendo o que foi pedido). */
  const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });
  function sortable(table, columns, { key, onChange } = {}) {
    const storeKey = key ? `ordem:${key}` : null;
    let state = storeKey ? memGet(storeKey) : null;
    if (state && !columns[state.col]) state = null;
    const ths = [...table.querySelectorAll("thead th")];
    ths.forEach((th, i) => {
      if (!columns[i]) return;
      th.innerHTML = `<button type="button" class="th-sort" data-col="${i}" title="Ordenar por ${esc(th.textContent.trim())}">${esc(th.textContent.trim())}</button>`;
    });
    const paint = () => ths.forEach((th, i) => {
      if (!columns[i]) return;
      if (state && state.col === i) th.setAttribute("aria-sort", state.dir === "asc" ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    });
    table.querySelector("thead").addEventListener("click", (e) => {
      const btn = e.target.closest(".th-sort");
      if (!btn) return;
      const col = Number(btn.dataset.col);
      if (!state || state.col !== col) state = { col, dir: "asc" };
      else if (state.dir === "asc") state = { col, dir: "desc" };
      else state = null;
      if (storeKey) memSet(storeKey, state);
      paint();
      if (onChange) onChange();
    });
    paint();

    function apply(rows) {
      if (!state) return rows;
      const get = columns[state.col];
      const sign = state.dir === "asc" ? 1 : -1;
      const blank = (v) => v == null || v === "";
      return rows
        .map((row, i) => ({ row, i, v: get(row) }))
        .sort((a, b) => {
          if (blank(a.v) || blank(b.v)) return blank(a.v) && blank(b.v) ? a.i - b.i : blank(a.v) ? 1 : -1; // vazio no fim
          const c = typeof a.v === "number" && typeof b.v === "number" ? a.v - b.v : collator.compare(String(a.v), String(b.v));
          return c ? c * sign : a.i - b.i;
        })
        .map((x) => x.row);
    }
    return { apply };
  }

  /* ---------- Tabelas no celular ----------
     Copia o título de cada coluna para as células (data-label). No celular o CSS
     usa isso para mostrar cada linha como um cartão ("Estilo: Pilsen"), sem precisar
     arrastar a tabela para o lado. Funciona sozinho para todas as tabelas .table-card. */
  function labelTable(table) {
    const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    table.querySelectorAll("tbody tr").forEach((tr) =>
      [...tr.children].forEach((td, i) => {
        if (td.colSpan > 1) return; // linha de "nenhum resultado"
        if (heads[i]) td.setAttribute("data-label", heads[i]);
        else td.classList.add("td-actions");
      })
    );
  }
  function watchTables() {
    document.querySelectorAll(".table-card table").forEach((table) => {
      const tbody = table.querySelector("tbody");
      if (!tbody) return;
      labelTable(table);
      new MutationObserver(() => labelTable(table)).observe(tbody, { childList: true });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchTables);
  else watchTables();

  return {
    OP_LABELS, STATUS_LABELS, TRANSFER_LABELS, setUser, pode, call, esc, chopeLabel, fmtDate, fmtDia, validadeBadge, toast, run,
    bindPasswordRules, dialog, showSecret, notice, confirm, openOverlay, maskCnpj, escolherFuncionario,
    rememberFields, sortable, clearRemembered,
  };
})();
