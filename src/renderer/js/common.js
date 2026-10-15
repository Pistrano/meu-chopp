/* MeuChopp — utilitários compartilhados pelas telas */
const MC = (() => {
  const OP_LABELS = { entrada: "Entrada", transferencia: "Transferência", utilizacao: "Utilização", esgotado: "Chopp Esgotado" };
  const STATUS_LABELS = { disponivel: "Disponível", em_uso: "Em uso", em_transferencia: "Em transferência", esgotado: "Esgotado" };
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

  /* fields: [{id,label,type,autocomplete}]. onSubmit(values) pode lançar erro: ele aparece no diálogo. */
  function dialog({ title, intro, fields = [], submitLabel = "Confirmar", rules = false, onSubmit }) {
    return new Promise((resolve) => {
      const inputs = fields
        .map((f) => `<div class="mb-3"><label class="form-label" for="mcf_${f.id}">${esc(f.label)}</label>
          <input class="form-control" id="mcf_${f.id}" type="${f.type || "text"}" autocomplete="${f.autocomplete || "off"}"></div>`)
        .join("");
      const overlay = openOverlay(`<h2>${esc(title)}</h2>${intro ? `<p class="mc-modal-intro">${esc(intro)}</p>` : ""}
        <form novalidate>${inputs}${rules ? '<ul class="pw-rules" id="mcRules"></ul>' : ""}
        <div class="field-error" id="mcErr" aria-live="polite"></div>
        <div class="mc-modal-actions"><button type="button" class="btn-ghost" data-cancel>Cancelar</button>
        <button type="submit" class="btn btn-mc btn-mc-sm">${esc(submitLabel)}</button></div></form>`);

      const form = overlay.querySelector("form");
      const errEl = overlay.querySelector("#mcErr");
      const first = overlay.querySelector("input");
      if (rules) bindPasswordRules(overlay.querySelector(`#mcf_${rules}`), overlay.querySelector("#mcRules"));
      const close = (value) => { overlay.remove(); resolve(value); };

      overlay.querySelector("[data-cancel]").addEventListener("click", () => close(false));
      overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(false); });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const values = {};
        fields.forEach((f) => (values[f.id] = overlay.querySelector(`#mcf_${f.id}`).value));
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
      if (first) first.focus();
    });
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

  return { OP_LABELS, STATUS_LABELS, TRANSFER_LABELS, call, esc, fmtDate, toast, run, bindPasswordRules, dialog, showSecret };
})();
