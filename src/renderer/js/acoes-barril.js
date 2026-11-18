/* ==========================================================
   BarrilFacil — ações do barril usadas em mais de uma aba (Barris e Torneiras)
   Engatar numa torneira (com a confirmação de barril vencido), retirar da torneira (vazio ou ainda com chope) e
   pesar (balança ou estimativa, usado também em Mais > Pesagem). Fica num lugar só: mudanças no fluxo valem para
   todas as abas. Depende de common.js (MC) e layout.js (MCLayout).
   Quem está fazendo: a escolha (MC.escolherFuncionario) vai na confirmação. Na retirada, a janela é daqui;
   no engate, cada aba tem a própria janela de escolha (torneira ou barril) e passa a escolha em `funcionario`.
   ========================================================== */
const MCBarril = (() => {
  /* Engate: barris:use. Barril vencido só gera aviso: a pessoa confirma e o engate fica na auditoria.
     Retorna o resultado do servidor ({ codigo, torneira, ... }) ou false se a pessoa desistiu do vencido.
     Erros do servidor (torneira ocupada, barril já usado em outro aparelho...) sobem para quem chamou.
     funcionario: a escolha de MC.escolherFuncionario feita na janela do engate (null = conta pessoal ou loja sem funcionários). */
  async function engatar({ barrilId, torneiraId, unitId, funcionario = null }) {
    if (funcionario && !funcionario.id) throw new Error("Toque no seu nome em \"Quem está fazendo?\".");
    const pedido = { id: barrilId, torneiraId, unitId, funcionarioId: funcionario ? funcionario.id : undefined };
    let result;
    try {
      result = await MC.call("barris:use", pedido);
    } catch (err) {
      if (err.code !== "BARRIL_VENCIDO") throw err;
      const [, mes, dia] = String(err.info && err.info.validade || "").split("-");
      const sim = await MC.confirm({
        title: "Barril vencido",
        type: "err",
        text: `Este barril venceu em ${dia}/${mes}. Confira se ele estava armazenado na câmara fria. Engatar mesmo assim?`,
        confirmLabel: "Engatar mesmo assim",
      });
      if (!sim) return false;
      result = await MC.call("barris:use", { ...pedido, confirmarVencido: true });
    }
    if (funcionario) funcionario.lembrar();
    MC.toast(`Barril #${result.codigo} engatado na Torneira ${result.torneira}.`);
    MCLayout.refreshAlerts();
    return result;
  }

  /* ---------- Medir o chope que sobrou: balança ou estimativa ----------
     Janela usada na retirada com chope, na pesagem avulsa e no inventário (Mais > Pesagem).
     barril: { codigo, tamanho_l }. Balança: peso bruto em kg e a tara (vem a padrão do tamanho; dá para trocar por outra
     ativa do mesmo tamanho). Sem tara para o tamanho, pede o peso do vasilhame vazio, que o servidor salva como tara.
     Os litros aparecem enquanto a pessoa digita (densidade da config do servidor). Estimativa: 100, 75, 50 ou 25%.
     Sem onSubmit, resolve com a medida (ou null se cancelou):
       { metodo: "balanca", pesoBruto, taraId, taraNovaKg, litros, estimado: false, quaseVazio }
       { metodo: "estimativa", nivel, litros, estimado: true, quaseVazio: false }
     quaseVazio: deu 0,5 L ou menos. Com onSubmit(medida), salva dentro da janela (o erro aparece nela) e resolve com o
     resultado. funcionario: a escolha de MC.escolherFuncionario (a grade vai antes dos botões). */
  const NIVEIS = [100, 75, 50, 25];
  const QUASE_VAZIO_L = 0.5;
  const arred = (n) => Math.round(n * 100) / 100;
  const kg = (n) => Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 2 });

  async function medir({ barril, titulo, intro = "", okLabel = "Continuar", funcionario = null, onSubmit = null }) {
    const tamanho = Number(barril.tamanho_l);
    let taras;
    try {
      taras = (await MC.call("taras:list")).filter((t) => Number(t.tamanho_l) === tamanho);
    } catch (err) { MC.toast(err.message, "err"); return null; }
    const densidade = Number(MCLayout.ctx && MCLayout.ctx.config && MCLayout.ctx.config.densidade) || null;
    const tamTxt = MC.fmtLitros(tamanho);

    const campoTara = taras.length
      ? `<div class="mb-3"><label class="form-label" for="medTara">Tara do vasilhame vazio</label>
          <select id="medTara" class="form-select">${taras.map((t) => `<option value="${t.id}">${kg(t.peso_kg)} kg${t.padrao ? " · padrão" : ""}${t.descricao ? ` · ${MC.esc(t.descricao)}` : ""}</option>`).join("")}</select></div>`
      : `<div class="mb-3"><label class="form-label" for="medTaraNova">Primeira pesagem de barril de ${tamTxt}: informe o peso do vasilhame vazio (kg)</label>
          <input id="medTaraNova" class="form-control" inputmode="decimal" autocomplete="off" placeholder="Ex.: 13,5">
          <div class="form-hint">Fica salvo como a tara dos barris de ${tamTxt}. Dá para mudar depois em Mais &gt; Pesagem.</div></div>`;
    const overlay = MC.openOverlay(`<h2>${MC.esc(titulo)}</h2>${intro ? `<p class="mc-modal-intro">${MC.esc(intro)}</p>` : ""}
      <div class="medir-modo" role="radiogroup" aria-label="Como medir o chope que sobrou">
        <button type="button" class="escolha-btn" role="radio" aria-checked="false" data-modo="balanca">
          <span class="escolha-titulo">Pesar na balança</span><span class="escolha-hint">Peso do barril em kg</span></button>
        <button type="button" class="escolha-btn" role="radio" aria-checked="false" data-modo="estimativa">
          <span class="escolha-titulo">Sem balança, estimar</span><span class="escolha-hint">Pelo peso na mão ou pelo visor</span></button>
      </div>
      <div class="medir-sec d-none" data-sec="balanca">
        <div class="mb-3"><label class="form-label" for="medPeso">Peso do barril na balança (kg)</label>
          <input id="medPeso" class="form-control medir-peso" inputmode="decimal" autocomplete="off" placeholder="Ex.: 32,4"></div>
        ${campoTara}
        <div class="medir-resultado" id="medRes" aria-live="polite"></div>
      </div>
      <div class="medir-sec d-none" data-sec="estimativa">
        <div class="medir-niveis" role="radiogroup" aria-label="Quanto chope sobrou">${NIVEIS.map((n) => `
          <button type="button" class="escolha-btn medir-nivel" role="radio" aria-checked="false" data-nivel="${n}">
            <span class="escolha-titulo">Cerca de ${n}%</span><span class="escolha-hint">≈ ${MC.fmtLitros(arred(tamanho * n / 100))}</span></button>`).join("")}</div>
      </div>
      ${funcionario ? `<div class="mt-3">${funcionario.html}</div>` : ""}
      <div class="field-error" id="medErr" aria-live="polite"></div>
      <div class="mc-modal-actions"><button type="button" class="btn-ghost" data-cancel>Cancelar</button>
        <button type="button" class="btn btn-mc btn-mc-sm" data-ok disabled>${MC.esc(okLabel)}</button></div>`);
    overlay.querySelector(".mc-modal").classList.add("mc-modal--medir");

    const okBtn = overlay.querySelector("[data-ok]");
    const errEl = overlay.querySelector("#medErr");
    const resEl = overlay.querySelector("#medRes");
    const peso = overlay.querySelector("#medPeso");
    const taraSel = overlay.querySelector("#medTara");
    const taraNova = overlay.querySelector("#medTaraNova");
    let modo = null;
    let nivel = null;
    let medida = null;

    // Confere o que foi digitado e mostra os litros. Devolve a medida, ou null quando ainda não dá para continuar.
    function calcular() {
      resEl.className = "medir-resultado";
      if (modo === "estimativa") {
        if (!nivel) return null;
        return { metodo: "estimativa", nivel, litros: arred(tamanho * nivel / 100), estimado: true, quaseVazio: false };
      }
      if (modo !== "balanca") return null;
      const bruto = arred(MC.numeroBR(peso.value));
      const taraId = taraSel ? Number(taraSel.value) : null;
      const taraKg = taraSel ? Number(taras.find((t) => t.id === taraId).peso_kg) : arred(MC.numeroBR(taraNova.value));
      resEl.textContent = "";
      if (!(bruto > 0)) return null;
      if (!(taraKg > 0)) { resEl.textContent = "Informe o peso do vasilhame vazio (kg)."; return null; }
      if (bruto < taraKg) {
        resEl.classList.add("is-erro");
        resEl.textContent = `O peso (${kg(bruto)} kg) é menor que a tara do vasilhame (${kg(taraKg)} kg). Confira o peso e a tara.`;
        return null;
      }
      const base = { metodo: "balanca", pesoBruto: bruto, taraId: taraSel ? taraId : null, taraNovaKg: taraSel ? null : taraKg, estimado: false };
      if (!densidade) return { ...base, litros: null, quaseVazio: false }; // sem a densidade, o servidor faz a conta
      const litros = arred((bruto - taraKg) / densidade);
      if (litros > tamanho * 1.05) {
        resEl.classList.add("is-erro");
        resEl.textContent = `Deu ${MC.fmtLitros(litros)}, mais do que cabe no barril de ${tamTxt}. Confira o peso e a tara.`;
        return null;
      }
      const quaseVazio = litros <= QUASE_VAZIO_L;
      resEl.classList.add(quaseVazio ? "is-aviso" : "is-ok");
      resEl.textContent = quaseVazio ? `Sobrou só ${MC.fmtLitros(litros)}: o barril está praticamente vazio.` : `Sobraram ${MC.fmtLitros(litros)} de chope.`;
      return { ...base, litros, quaseVazio };
    }
    const atualizar = () => {
      medida = calcular();
      okBtn.disabled = !medida || !!(funcionario && !funcionario.id);
      errEl.textContent = "";
    };
    const marcar = (botoes, ativo) => botoes.forEach((b) => {
      b.classList.toggle("is-selected", b === ativo);
      b.setAttribute("aria-checked", String(b === ativo));
    });

    const modos = [...overlay.querySelectorAll("[data-modo]")];
    modos.forEach((b) => b.addEventListener("click", () => {
      modo = b.dataset.modo;
      marcar(modos, b);
      overlay.querySelectorAll(".medir-sec").forEach((sec) => sec.classList.toggle("d-none", sec.dataset.sec !== modo));
      atualizar();
      if (modo === "balanca") peso.focus();
    }));
    const niveis = [...overlay.querySelectorAll("[data-nivel]")];
    niveis.forEach((b) => b.addEventListener("click", () => { nivel = Number(b.dataset.nivel); marcar(niveis, b); atualizar(); }));
    [peso, taraSel, taraNova].filter(Boolean).forEach((el) => { el.addEventListener("input", atualizar); el.addEventListener("change", atualizar); });
    if (funcionario) funcionario.ligar(overlay, atualizar);

    return new Promise((resolve) => {
      const fechar = (v) => { overlay.remove(); resolve(v); };
      overlay.querySelector("[data-cancel]").addEventListener("click", () => fechar(null));
      overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") fechar(null); });
      overlay.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT" && !okBtn.disabled) okBtn.click(); });
      okBtn.addEventListener("click", async () => {
        const m = calcular();
        if (!m) return;
        if (funcionario && !funcionario.id) { errEl.textContent = "Toque no seu nome em \"Quem está fazendo?\"."; return; }
        if (!onSubmit) { fechar(m); return; }
        okBtn.disabled = true;
        errEl.textContent = "";
        try {
          const r = await onSubmit(m);
          if (funcionario) funcionario.lembrar();
          fechar(r);
        } catch (err) {
          errEl.textContent = err.message;
          okBtn.disabled = false;
        }
      });
      modos[0].focus();
    });
  }

  const comoMediu = (m) => (m.estimado ? "estimado" : "pesado");
  const torneiraLiberada = (r) => (r.torneira ? `Torneira ${r.torneira}` : "Nenhuma (sem torneira registrada)");

  /* Primeira pergunta da retirada: "vazio" | "chope" | null (cancelou) */
  function perguntarVazio(barril, unidade) {
    const onde = barril.torneira_numero
      ? `Unidade: ${unidade}. O barril está na Torneira ${barril.torneira_numero}, que será liberada.`
      : `Unidade: ${unidade}. Este barril não tem torneira registrada (foi engatado antes do controle de torneiras).`;
    const overlay = MC.openOverlay(`<h2>Retirar barril #${MC.esc(barril.codigo)}</h2>
      <p class="mc-modal-intro">${MC.esc(onde)}</p>
      <p class="pergunta-grande">Este barril está vazio ou ainda tem chope?</p>
      <div class="escolha-grande">
        <button type="button" class="escolha-btn" data-escolha="vazio"><span class="escolha-titulo">Vazio</span>
          <span class="escolha-hint">Fica "Vazio" até a fábrica recolher</span></button>
        <button type="button" class="escolha-btn" data-escolha="chope"><span class="escolha-titulo">Ainda tem chope</span>
          <span class="escolha-hint">Volta para o estoque com o que sobrou</span></button>
      </div>
      <div class="mc-modal-actions"><button type="button" class="btn-ghost" data-cancel>Cancelar</button></div>`);
    return new Promise((resolve) => {
      const fechar = (v) => { overlay.remove(); resolve(v); };
      overlay.querySelectorAll("[data-escolha]").forEach((b) => b.addEventListener("click", () => fechar(b.dataset.escolha)));
      overlay.querySelector("[data-cancel]").addEventListener("click", () => fechar(null));
      overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") fechar(null); });
      overlay.querySelector("[data-escolha]").focus();
    });
  }

  /* Retirada como vazio: confirmação, barris:empty e o aviso de sucesso. O barril fica "Vazio" e a torneira é liberada. */
  async function retirarVazio({ barril, unidade, unitId, aoRetirar, fecharNoErro }) {
    let falha = null;
    const funcionario = await MC.escolherFuncionario(unitId);
    const result = await MC.dialog({
      title: `Retirar barril #${barril.codigo} vazio`,
      intro: barril.torneira_numero
        ? `Unidade: ${unidade}. O barril está na Torneira ${barril.torneira_numero}, que será liberada. Ao ser retirado, o barril fica "Vazio" até a fábrica recolher.`
        : `Unidade: ${unidade}. Este barril não tem torneira registrada (foi engatado antes do controle de torneiras), então nenhuma torneira será liberada. O barril fica "Vazio" até a fábrica recolher.`,
      submitLabel: "Confirmar retirada",
      funcionario,
      onSubmit: async () => {
        try {
          return await MC.call("barris:empty", { id: barril.id, funcionarioId: funcionario ? funcionario.id : undefined });
        } catch (err) {
          if (!fecharNoErro) throw err;
          falha = err;
          return null;
        }
      },
    });
    if (falha) throw falha;
    if (!result || !result.codigo) return null;
    MCLayout.refreshAlerts();
    if (aoRetirar) aoRetirar(result);
    await MC.notice({
      title: "Barril retirado com sucesso!",
      lines: [
        ["Barril", `#${result.codigo}`],
        ["Unidade", result.unidade],
        ["Torneira liberada", torneiraLiberada(result)],
        ["Situação", "Vazio (aguardando recolhimento)"],
      ],
    });
    return result;
  }

  // Deu 0,5 L ou menos: pergunta se retira como vazio
  async function quaseVazio(barril, litros, args) {
    const sim = await MC.confirm({
      title: "Barril praticamente vazio",
      text: `Sobrou só ${MC.fmtLitros(litros)} no barril #${barril.codigo}. Retirar como vazio?`,
      confirmLabel: "Retirar como vazio",
      cancelLabel: "Cancelar",
    });
    return sim ? retirarVazio(args) : null;
  }

  /* Retirada com chope: medida (balança ou estimativa), "Quem está fazendo?" e a confirmação final. */
  async function retirarComChope(args) {
    const { barril, unidade, unitId, aoRetirar, fecharNoErro } = args;
    const medida = await medir({
      barril,
      titulo: `Retirar barril #${barril.codigo} com chope`,
      intro: `Barril de ${MC.fmtLitros(barril.tamanho_l)}. Quanto chope ainda tem nele?`,
    });
    if (!medida) return null;
    if (medida.quaseVazio) return quaseVazio(barril, medida.litros, args);

    let falha = null;
    let quase = null;
    const funcionario = await MC.escolherFuncionario(unitId);
    const litros = medida.litros === null ? "o chope que sobrou" : MC.fmtLitros(medida.litros);
    const result = await MC.dialog({
      title: "Confirmar retirada com chope",
      intro: `Barril #${barril.codigo} volta para o estoque com ${litros} (${comoMediu(medida)}). ` +
        (barril.torneira_numero ? `A Torneira ${barril.torneira_numero} será liberada.` : "Nenhuma torneira será liberada (sem torneira registrada)."),
      submitLabel: "Confirmar retirada",
      funcionario,
      onSubmit: async () => {
        try {
          return await MC.call("barris:retirarComChope", {
            id: barril.id, funcionarioId: funcionario ? funcionario.id : undefined,
            metodo: medida.metodo, pesoBruto: medida.pesoBruto, taraId: medida.taraId, taraNovaKg: medida.taraNovaKg, nivel: medida.nivel,
          });
        } catch (err) {
          if (err.code === "QUASE_VAZIO") { quase = err; return null; }
          if (!fecharNoErro) throw err;
          falha = err;
          return null;
        }
      },
    });
    if (falha) throw falha;
    if (quase) return quaseVazio(barril, quase.info ? quase.info.litros : 0, args);
    if (!result || !result.codigo) return null;
    MCLayout.refreshAlerts();
    if (aoRetirar) aoRetirar(result);
    await MC.notice({
      title: "Barril retirado com chope",
      lines: [
        ["Barril", `#${result.codigo}`],
        ["Unidade", result.unidade],
        ["Torneira liberada", torneiraLiberada(result)],
        ["Situação", `Disponível · ${result.estimado ? "≈ " : ""}${MC.fmtLitros(result.litros)} (${result.estimado ? "estimado" : "pesado"})`],
      ],
    });
    return result;
  }

  /* Retirada: primeiro a pergunta "vazio ou ainda tem chope?".
     barril: { id, codigo, tamanho_l, torneira_numero }. unitId: unidade do barril (para a lista de quem está fazendo).
     aoRetirar(result): a tela se recarrega por trás do aviso.
     fecharNoErro: em vez de mostrar o erro dentro da janela, fecha e repassa o erro (a aba Torneiras
     mostra a mensagem e recarrega o quadro). Retorna o resultado, ou null se a pessoa cancelou. */
  async function retirar(args) {
    const escolha = await perguntarVazio(args.barril, args.unidade);
    if (escolha === "vazio") return retirarVazio(args);
    if (escolha === "chope") return retirarComChope(args);
    return null;
  }

  /* Pesagem avulsa ou de inventário (inventarioId): medida e "Quem está fazendo?" na mesma janela.
     barril: { id, codigo, tamanho_l, status }. Retorna o resultado do servidor ({ codigo, litros, estimado }) ou null. */
  async function pesar({ barril, unitId, inventarioId = null }) {
    const funcionario = await MC.escolherFuncionario(unitId);
    const r = await medir({
      barril,
      titulo: `Pesar barril #${barril.codigo}`,
      intro: `Barril de ${MC.fmtLitros(barril.tamanho_l)}${barril.status === "em_uso" ? ", engatado (continua engatado)" : ""}. Quanto chope tem nele?` +
        (barril.status === "disponivel" ? " O resultado passa a ser o saldo do barril." : ""),
      okLabel: "Salvar pesagem",
      funcionario,
      onSubmit: (m) => MC.call("pesagens:registrar", {
        barrilId: barril.id, inventarioId: inventarioId || undefined, funcionarioId: funcionario ? funcionario.id : undefined,
        metodo: m.metodo, pesoBruto: m.pesoBruto, taraId: m.taraId, taraNovaKg: m.taraNovaKg, nivel: m.nivel,
      }),
    });
    if (!r || !r.codigo) return null;
    MC.toast(`Pesagem do barril #${r.codigo} salva: ${r.estimado ? "≈ " : ""}${MC.fmtLitros(r.litros)} (${r.estimado ? "estimado" : "pesado"}).`);
    return r;
  }

  return { engatar, retirar, medir, pesar };
})();
