/* BarrilFacil — tema claro/escuro.
   Carregado no <head> (antes de desenhar a tela) para a página já abrir no tema certo, sem piscar.
   Modos: "auto" (segue o Windows/navegador), "claro" e "escuro". A escolha fica só neste aparelho. */
(() => {
  const KEY = "bf:tema";
  const MODOS = ["auto", "claro", "escuro"];
  const ROTULOS = { auto: "Automático", claro: "Claro", escuro: "Escuro" };
  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  const lerModo = () => {
    try { const v = localStorage.getItem(KEY); return MODOS.includes(v) ? v : "auto"; } catch (_) { return "auto"; }
  };
  const escuroAgora = (modo) => modo === "escuro" || (modo === "auto" && !!mq && mq.matches);

  function aplicar(modo) {
    const root = document.documentElement;
    root.dataset.tema = escuroAgora(modo) ? "escuro" : "claro";
    root.dataset.temaModo = modo;
  }

  function definir(modo) {
    if (!MODOS.includes(modo)) return;
    try { localStorage.setItem(KEY, modo); } catch (_) { /* sem armazenamento: vale só até recarregar */ }
    aplicar(modo);
  }

  aplicar(lerModo());
  // Modo automático acompanha a troca de tema do sistema enquanto a tela está aberta
  if (mq) {
    const onChange = () => { if (lerModo() === "auto") aplicar("auto"); };
    if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  // Outra janela do app mudou o tema: acompanha
  window.addEventListener("storage", (e) => { if (e.key === KEY) aplicar(lerModo()); });

  window.BFTema = {
    modo: lerModo,
    rotulo: (modo) => ROTULOS[modo || lerModo()],
    definir,
    // Automático -> Claro -> Escuro -> Automático
    proximo() { const m = MODOS[(MODOS.indexOf(lerModo()) + 1) % MODOS.length]; definir(m); return m; },
  };
})();
