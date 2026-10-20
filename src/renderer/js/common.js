/* MeuChopp — utilitários compartilhados pelas telas */
const MC = (() => {
  const OP_LABELS = { entrada: "Entrada", transferencia: "Transferência", utilizacao: "Utilização", esgotado: "Chopp Esgotado" };
  const STATUS_LABELS = { disponivel: "Disponível", em_uso: "Em uso", em_transferencia: "Em transferência", esgotado: "Chopp Esgotado" };
  const TRANSFER_LABELS = { pendente: "Pendente", confirmada: "Confirmada", cancelada: "Cancelada" };

  /* Chama o sistema (processo principal). Lança erro com a mensagem amigável. */
  async function call(channel, payload) {
    const res = await window.api.invoke(channel, payload);
    if (!res.ok) {
      const page = location.pathname;
      if (res.code === "SESSION" && !page.endsWith("index.html")) location.href = "index.html?expirada=1";
      if (res.code === "MUST_CHANGE" && !page.endsWith("primeiro-acesso.html")) location.href = "primeiro-acesso.html";
      const err = new Error(res.error);
      err.code = res.code;
      throw err;
    }
    return res.data;
  }

  function esc(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
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

  /* fields: [{id,label,type,autocomplete}]. onSubmit(values) pode lançar erro: ele aparece no diálogo.
     type "radios": options [{value,label,hint,disabled,checked}] — escolha única (ex.: torneira).
     onOpen(overlay): chamado depois que o diálogo aparece (ex.: aplicar máscara de CNPJ). */
  function dialog({ title, intro, fields = [], submitLabel = "Confirmar", rules = false, onSubmit, onOpen }) {
    return new Promise((resolve) => {
      const radios = (f) => `<fieldset class="mb-3"><legend class="form-label">${esc(f.label)}</legend>
          <div class="radio-list" id="mcf_${f.id}">${f.options
            .map((o) => `<label class="radio-item${o.disabled ? " is-disabled" : ""}">
              <input type="radio" name="mcf_${f.id}" value="${esc(o.value)}" ${o.disabled ? "disabled" : ""} ${o.checked ? "checked" : ""}>
              <span class="radio-main">${esc(o.label)}</span>${o.hint ? `<span class="radio-hint">${esc(o.hint)}</span>` : ""}</label>`)
            .join("")}</div></fieldset>`;
      const inputs = fields
        .map((f) =>
          f.type === "radios" ? radios(f) : f.type === "checks"
            ? `<div class="mb-3"><div class="form-label">${esc(f.label)}</div><div class="check-list" id="mcf_${f.id}">${f.options
                .map((o) => `<label class="check-item"><input type="checkbox" value="${esc(o.value)}" ${o.checked ? "checked" : ""}><span>${esc(o.label)}</span></label>`)
                .join("")}</div></div>`
            : `<div class="mb-3"><label class="form-label" for="mcf_${f.id}">${esc(f.label)}</label>
          <input class="form-control" id="mcf_${f.id}" type="${f.type || "text"}" autocomplete="${f.autocomplete || "off"}" value="${esc(f.value || "")}"></div>`
        )
        .join("");
      const overlay = openOverlay(`<h2>${esc(title)}</h2>${intro ? `<p class="mc-modal-intro">${esc(intro)}</p>` : ""}
        <form novalidate>${inputs}${rules ? '<ul class="pw-rules" id="mcRules"></ul>' : ""}
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
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
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

  /* Aviso com botão único (ex.: "Barril retirado com sucesso!"). lines: [[rótulo, valor], ...] */
  function notice({ title, text, lines = [], type = "ok", buttonLabel = "OK" }) {
    return new Promise((resolve) => {
      const overlay = openOverlay(`<h2 class="notice-title notice-title--${type}">${esc(title)}</h2>
        ${text ? `<p class="mc-modal-intro">${esc(text)}</p>` : ""}
        ${lines.length ? `<dl class="notice-lines">${lines.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}
        <div class="mc-modal-actions"><button type="button" class="btn btn-mc btn-mc-sm" id="mcOk">${esc(buttonLabel)}</button></div>`);
      const close = () => { overlay.remove(); resolve(true); };
      overlay.querySelector("#mcOk").addEventListener("click", close);
      overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
      overlay.querySelector("#mcOk").focus();
    });
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

  return { OP_LABELS, STATUS_LABELS, TRANSFER_LABELS, call, esc, fmtDate, toast, run, bindPasswordRules, dialog, showSecret, notice, maskCnpj };
})();
