/* MeuChopp — utilitários compartilhados pelas telas */
const MC = (() => {
  const OP_LABELS = { entrada: "Entrada", transferencia: "Transferência", utilizacao: "Utilização", esgotado: "Chopp Esgotado" };
  const STATUS_LABELS = { disponivel: "Disponível", em_uso: "Em uso", em_transferencia: "Em transferência", esgotado: "Esgotado" };
  const TRANSFER_LABELS = { pendente: "Pendente", confirmada: "Confirmada", cancelada: "Cancelada" };

  /* Chama o sistema (processo principal). Lança erro com a mensagem amigável. */
  async function call(channel, payload) {
    const res = await window.api.invoke(channel, payload);
    if (!res.ok) throw new Error(res.error);
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

  return { OP_LABELS, STATUS_LABELS, TRANSFER_LABELS, call, esc, fmtDate, toast, run };
})();
