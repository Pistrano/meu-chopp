/* ==========================================================
   BarrilFacil — leitura da etiqueta do barril (Torneiras e Transferências)
   A etiqueta é um código de barras 1D só com o código do barril, no formato BA5-1463 (BA2 = 20 L, BA3 = 30 L,
   BA5 = 50 L). Três jeitos de ler, no mesmo bloco:
     - câmera: lê continuamente até achar um código (BarcodeDetector do navegador; sem ele, a ZXing de vendor/,
       carregada só quando precisa, como no iPhone). Ao ler, vibra, desliga a câmera e entrega o texto;
     - pistola leitora (USB ou Bluetooth): ela "digita" o código e manda Enter no campo de texto;
     - digitação: o código inteiro ou só os números (2630).
   Depois de ler, procura o barril no servidor (barris:porCodigo, em qualquer situação) e entrega à tela.
   As regras do que dá para fazer com o barril achado ficam em motivo(), usado pelo engate e pela transferência.
   normalizar() e motivo() não usam a página: os testes (tests/leitor-codigo.test.js) carregam este arquivo no Node.
   ========================================================== */
const MCLeitor = (() => {
  /* ---------- O que foi lido: código inteiro, só os números ou outra coisa ----------
     maiúsculas, sem espaços, sem # e sem os * que algumas pistolas mandam no Code 39.
     "BA5-2630", "BA52630", "ba5 2630" -> { codigo: "BA5-2630" }; "2630" -> { numero: "2630" };
     o resto -> { erro }. O prefixo é letra(s) + o dígito do tamanho; o número vem depois. */
  const CODIGO_RE = /^([A-Z]{1,4}\d)-?(\d{1,6})$/;
  const NUMERO_RE = /^\d{2,6}$/;
  function normalizar(texto) {
    const original = String(texto == null ? "" : texto).trim();
    const t = original.toUpperCase().replace(/[\s#*]/g, "").replace(/[\u2010-\u2015\u2212]/g, "-"); // traços "tipográficos" viram hífen
    if (!t) return { erro: "Leia ou digite o código do barril." };
    let m = CODIGO_RE.exec(t);
    if (m) return { codigo: `${m[1]}-${m[2]}` };
    if (NUMERO_RE.test(t)) return { numero: t };
    const mostra = original.length > 30 ? `${original.slice(0, 30)}…` : original;
    return { erro: `“${mostra}” não parece um código de barril. O formato é BA5-1234.` };
  }

  /* ---------- Pode usar o barril achado? ----------
     b: um item de barris:porCodigo. unitId: a unidade aberta na tela. acao: "engatar" ou "enviar".
     naLista: (envio) os ids já escolhidos. Devolve a mensagem que explica por que não dá, ou null. */
  function motivo(b, { unitId, acao = "engatar", naLista = [] } = {}) {
    const cod = `#${b.codigo}`;
    if (b.status === "recolhido")
      return `O barril ${cod} já foi recolhido pela fábrica. Se ele voltou cheio, cadastre de novo na aba Barris.`;
    if (b.status === "em_transferencia") {
      if (b.destino_id && Number(b.destino_id) === Number(unitId))
        return `O barril ${cod} está vindo para esta loja. Confirme o recebimento na aba Transferências antes.`;
      return `O barril ${cod} está em transferência. Confirme o recebimento antes.`;
    }
    if (Number(b.unidade_id) !== Number(unitId) || b.acesso === false)
      return `O barril ${cod} está no ${b.unidade || "outra unidade"}, não nesta loja.`;
    if (b.status === "em_uso")
      return b.torneira_numero ? `O barril ${cod} já está engatado na Torneira ${b.torneira_numero}.` : `O barril ${cod} já está engatado.`;
    if (b.status === "esgotado") return `O barril ${cod} está vazio, aguardando o recolhimento.`;
    if (b.status !== "disponivel") return `O barril ${cod} não está disponível.`;
    if (acao === "enviar" && naLista.map(Number).includes(Number(b.id))) return `O barril ${cod} já está na lista.`;
    return null;
  }

  /* Nada abaixo roda no Node (testes): só a parte acima é usada lá */
  if (typeof window === "undefined") return { normalizar, motivo };

  const esc = (v) => MC.esc(v);
  const FORMATOS = ["code_128", "code_39", "code_93", "codabar", "itf", "ean_13"];
  const ICON_CAMERA = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
  // Celular e tablet (toque): o campo não ganha foco sozinho, senão o teclado cobre a janela. Computador: ganha.
  const toque = () => window.matchMedia && window.matchMedia("(pointer: coarse)").matches;

  /* ---------- Decodificador: BarcodeDetector do navegador ou ZXing ---------- */
  let detectorNativo; // undefined = ainda não conferiu; null = não tem
  async function criarDetectorNativo() {
    if (detectorNativo !== undefined) return detectorNativo;
    detectorNativo = null;
    try {
      if ("BarcodeDetector" in window) {
        const suportados = await window.BarcodeDetector.getSupportedFormats();
        const formatos = FORMATOS.filter((f) => suportados.includes(f));
        if (formatos.length) detectorNativo = new window.BarcodeDetector({ formats: formatos });
      }
    } catch (_) { detectorNativo = null; }
    return detectorNativo;
  }

  // A ZXing (336 KB) só é baixada quando o aparelho não tem o leitor nativo. Mesma versão (?v=) das outras telas.
  let zxingPromessa = null;
  function carregarZXing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    if (!zxingPromessa) {
      zxingPromessa = new Promise((resolve, reject) => {
        const meu = document.querySelector('script[src*="js/leitor-codigo.js"]');
        const v = meu && /\?v=[^"&]+/.exec(meu.getAttribute("src"));
        const s = document.createElement("script");
        s.src = `vendor/zxing-0.21.3.min.js${v ? v[0] : ""}`;
        s.onload = () => (window.ZXing ? resolve(window.ZXing) : reject(new Error("ZXing")));
        s.onerror = () => { zxingPromessa = null; reject(new Error("ZXing")); };
        document.head.appendChild(s);
      });
    }
    return zxingPromessa;
  }
  function criarLeitorZXing(Z) {
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
      Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.CODE_93,
      Z.BarcodeFormat.CODABAR, Z.BarcodeFormat.ITF, Z.BarcodeFormat.EAN_13,
    ]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    const leitor = new Z.MultiFormatReader();
    leitor.setHints(hints);
    const canvas = document.createElement("canvas");
    const c2d = canvas.getContext("2d", { willReadFrequently: true });
    // Lê a faixa do meio do quadro (onde fica a mira), reduzida a no máximo 1000 px de largura
    return (video) => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return null;
      const faixa = Math.round(vh * 0.6);
      const escala = Math.min(1, 1000 / vw);
      canvas.width = Math.round(vw * escala);
      canvas.height = Math.round(faixa * escala);
      c2d.drawImage(video, 0, Math.round((vh - faixa) / 2), vw, faixa, 0, 0, canvas.width, canvas.height);
      try {
        const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
        return leitor.decode(bitmap).getText();
      } catch (_) {
        return null; // nenhum código neste quadro
      } finally {
        leitor.reset();
      }
    };
  }

  /* ---------- O bloco de leitura ----------
     el: onde montar. opções:
       unitId()          a unidade aberta na tela (função: a unidade pode mudar com a tela aberta)
       aoAchar(b)        recebe o barril escolhido (item de barris:porCodigo); a tela decide o que fazer
       manterFoco        depois de cada leitura o campo volta a ter foco (transferência: bipar em sequência)
       rotuloCamera      texto do botão da câmera
     Devolve { erro(msg), ok(msg), mostrar(html), limpar(), focar(), parar(), destruir() }:
       parar() desliga a câmera; destruir() também solta os avisos da página (use ao fechar a janela). */
  function montar(el, { unitId, aoAchar, manterFoco = false, rotuloCamera = "Ler código com a câmera" }) {
    el.classList.add("leitor");
    el.innerHTML = `
      <button type="button" class="btn btn-mc leitor-cam" data-cam>${ICON_CAMERA}<span>${esc(rotuloCamera)}</span></button>
      <div class="leitor-video d-none" data-video-box>
        <video playsinline muted autoplay aria-label="Imagem da câmera"></video>
        <div class="leitor-mira" aria-hidden="true"></div>
        <p class="leitor-video-dica" data-video-dica>Aponte para o código de barras da etiqueta.</p>
        <button type="button" class="btn-ghost leitor-fechar" data-fechar>Fechar câmera</button>
      </div>
      <form class="leitor-manual" novalidate data-form>
        <input type="text" class="form-control leitor-campo" data-campo placeholder="Digite ou use a pistola" aria-label="Código do barril: digite ou use a pistola"
          autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" maxlength="40">
        <button type="submit" class="btn-ghost leitor-ok">OK</button>
      </form>
      <p class="leitor-dica">Pode digitar só os números (ex.: 2630). A pistola de código de barras também funciona neste campo.</p>
      <div class="leitor-saida" data-saida aria-live="polite"></div>`;
    const btnCam = el.querySelector("[data-cam]");
    const caixaVideo = el.querySelector("[data-video-box]");
    const video = el.querySelector("video");
    const dicaVideo = el.querySelector("[data-video-dica]");
    const campo = el.querySelector("[data-campo]");
    const saida = el.querySelector("[data-saida]");

    const mostrar = (html) => { saida.innerHTML = html; };
    const erro = (msg, extra = "") => mostrar(`<div class="leitor-msg leitor-msg--erro" role="alert">${esc(msg)}${extra}</div>`);
    const ok = (msg) => mostrar(`<div class="leitor-msg leitor-msg--ok">${esc(msg)}</div>`);
    const limpar = () => mostrar("");
    const focar = () => campo.focus({ preventScroll: true });

    /* ----- câmera ----- */
    let stream = null;
    let timer = null;
    let ativo = false;
    let ultimo = { texto: "", vezes: 0 };
    let ignorado = "";

    function parar() {
      ativo = false;
      clearTimeout(timer);
      timer = null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
      caixaVideo.classList.add("d-none");
      btnCam.classList.remove("d-none");
    }

    async function lerQuadros(decodificar) {
      if (!ativo) return;
      if (!el.isConnected) { parar(); return; } // a janela fechou sem avisar: desliga a câmera
      let texto = null;
      if (video.readyState >= 2) {
        try { texto = await decodificar(video); } catch (_) { texto = null; }
      }
      if (!ativo) return;
      if (texto) {
        texto = String(texto).trim();
        // O mesmo código em dois quadros seguidos: evita leitura errada de um quadro tremido
        ultimo = ultimo.texto === texto ? { texto, vezes: ultimo.vezes + 1 } : { texto, vezes: 1 };
        if (ultimo.vezes >= 2) {
          if (normalizar(texto).erro) {
            // Outro código de barras (ex.: o de um produto): avisa e continua lendo
            if (ignorado !== texto) {
              ignorado = texto;
              dicaVideo.textContent = `Li “${texto.slice(0, 24)}”, que não é a etiqueta do barril. Aponte para o código BA…`;
            }
          } else {
            if (navigator.vibrate) { try { navigator.vibrate(80); } catch (_) { /* sem vibração */ } }
            parar();
            entregar(texto);
            return;
          }
        }
      }
      timer = setTimeout(() => lerQuadros(decodificar), 150);
    }

    async function abrirCamera() {
      limpar();
      if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        erro("A câmera não está disponível neste aparelho ou navegador. Digite o código ou use a pistola.");
        return;
      }
      btnCam.disabled = true;
      let decodificar = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (!el.isConnected) { parar(); return; }
        // Foco contínuo quando o aparelho deixa (etiqueta de perto)
        const [trilha] = stream.getVideoTracks();
        try {
          const cap = trilha.getCapabilities ? trilha.getCapabilities() : {};
          if (cap.focusMode && cap.focusMode.includes("continuous")) await trilha.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
        } catch (_) { /* sem ajuste de foco */ }
        const nativo = await criarDetectorNativo();
        if (nativo) {
          decodificar = async (v) => { const r = await nativo.detect(v); return r && r.length ? r[0].rawValue : null; };
        } else {
          decodificar = criarLeitorZXing(await carregarZXing());
        }
        video.srcObject = stream;
        caixaVideo.classList.remove("d-none");
        btnCam.classList.add("d-none");
        dicaVideo.textContent = "Aponte para o código de barras da etiqueta.";
        ultimo = { texto: "", vezes: 0 };
        ignorado = "";
        try { await video.play(); } catch (_) { /* o autoplay mudo segue sozinho */ }
        ativo = true;
        lerQuadros(decodificar);
      } catch (err) {
        parar();
        const nome = err && err.name;
        if (nome === "NotAllowedError" || nome === "SecurityError")
          erro("Permita o uso da câmera nas configurações do navegador ou digite o código.");
        else if (nome === "NotFoundError" || nome === "OverconstrainedError" || nome === "DevicesNotFoundError")
          erro("Não achei a câmera deste aparelho. Digite o código ou use a pistola.");
        else if (nome === "NotReadableError")
          erro("A câmera está sendo usada por outro aplicativo. Feche o outro aplicativo ou digite o código.");
        else if (err && err.message === "ZXing")
          erro("Não foi possível carregar o leitor da câmera. Confira a internet ou digite o código.");
        else erro("Não foi possível abrir a câmera. Digite o código ou use a pistola.");
      } finally {
        btnCam.disabled = false;
      }
    }

    /* ----- procurar o barril lido -----
       Uma leitura por vez, na ordem: a pistola pode bipar o próximo barril antes de chegar a resposta do anterior. */
    let fila = Promise.resolve();
    const entregar = (texto) => { fila = fila.then(() => procurar(texto)).catch(() => {}); return fila; };
    async function procurar(texto) {
      const n = normalizar(texto);
      if (n.erro) { erro(n.erro); return; }
      mostrar('<div class="leitor-msg">Procurando o barril…</div>');
      let barris;
      try {
        barris = await MC.call("barris:porCodigo", { unitId: unitId(), codigo: n.codigo, numero: n.numero });
      } catch (err) {
        erro(err.message);
        return;
      }
      if (!el.isConnected) return;
      if (!barris.length) {
        const link = ' <a href="barris.html">Ir para a aba Barris</a>';
        if (n.codigo) erro(`O barril #${n.codigo} não está cadastrado. Cadastre na aba Barris.`, link);
        else erro(`Nenhum barril com o número ${n.numero}. Confira o número ou cadastre na aba Barris.`, link);
        return;
      }
      if (barris.length === 1) { aoAchar(barris[0]); return; }
      // Só os números e mais de um barril (ex.: BA2-1810 e BA3-1810): pergunta qual é
      mostrar(`<div class="leitor-msg">Há ${barris.length} barris com o número ${esc(n.numero || "")}. Qual é?</div>
        <div class="leitor-escolha" role="group" aria-label="Escolha o barril">${barris.map((b, i) => `
          <button type="button" class="leitor-opcao" data-i="${i}"><span class="leitor-codigo">#${esc(b.codigo)}</span>
            <span class="leitor-opcao-info">${b.acesso === false ? `no ${esc(b.unidade || "outra unidade")}` : esc([MC.chopeLabel(b) || "Chope", MC.fmtLitros(b.tamanho_l)].join(" · "))}</span></button>`).join("")}</div>`);
      saida.querySelectorAll("[data-i]").forEach((btn) => btn.addEventListener("click", () => aoAchar(barris[Number(btn.dataset.i)])));
      saida.querySelector("[data-i]").focus({ preventScroll: true });
    }

    btnCam.addEventListener("click", abrirCamera);
    el.querySelector("[data-fechar]").addEventListener("click", () => { parar(); btnCam.focus(); });
    el.querySelector("[data-form]").addEventListener("submit", (e) => {
      e.preventDefault();
      const texto = campo.value;
      if (!texto.trim()) { focar(); return; }
      campo.value = "";
      entregar(texto);
      if (manterFoco || document.activeElement === campo) focar();
    });
    // Celular: a câmera nunca fica ligada com a tela apagada ou em outro aplicativo
    const aoEsconder = () => { if (document.hidden) parar(); };
    document.addEventListener("visibilitychange", aoEsconder);
    window.addEventListener("pagehide", parar);

    if (!toque()) focar(); // computador com pistola: já pode bipar
    return {
      erro, ok, mostrar, limpar, focar, campo, parar,
      destruir() { parar(); document.removeEventListener("visibilitychange", aoEsconder); window.removeEventListener("pagehide", parar); },
    };
  }

  /* Cartão "Barril encontrado" (engate) */
  function cartaoAchado(b, { titulo = "Barril encontrado" } = {}) {
    const validade = b.validade ? `<span class="leitor-achado-validade">Validade ${MC.fmtDia(b.validade)} ${MC.validadeBadge(b.situacao_validade)}</span>` : "";
    const saldo = MC.saldoTexto(b) ? `<span class="leitor-achado-validade">${esc(MC.statusTexto(b))}</span>` : "";
    return `<div class="leitor-achado"><span class="leitor-achado-titulo">${esc(titulo)}</span>
      <span class="leitor-codigo leitor-codigo--grande">#${esc(b.codigo)}</span>
      <span class="leitor-achado-chope">${esc(MC.chopeLabel(b) || "Chope")} · ${esc(MC.fmtLitros(b.tamanho_l))}</span>${validade}${saldo}</div>`;
  }

  return { normalizar, motivo, montar, cartaoAchado };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MCLeitor;
