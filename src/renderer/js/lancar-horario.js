/* ==========================================================
   BarrilFacil — aba Torneiras: "Lançar com horário" (administrador e gerente, permissão torneiras:horario)
   Para a troca de barril, a retirada ou o engate que não foi lançado na hora: grava o horário em que aconteceu, e não
   o de agora (taps:lancarComHorario). As regras ficam no banco (fn_lancamento_com_horario); a janela confere o que dá
   para conferir aqui (campos, futuro, a ordem entre retirada e engate) e mostra os erros do servidor nela mesma, com o
   campo marcado. Os botões de cada torneira continuam gravando o horário de agora.
   Depende de common.js (MC), layout.js (MCLayout), acoes-barril.js (MCBarril.medir) e leitor-codigo.js (MCLeitor).
   ========================================================== */
const MCLancarHorario = (() => {
  const TIPOS = {
    troca: ["Troca de barril", "Saiu um e entrou outro"],
    retirada: ["Só retirada", "A torneira ficou livre"],
    engate: ["Só engate", "Numa torneira livre"],
  };
  const ATALHOS = [["Hoje", 0], ["Ontem", -1], ["Anteontem", -2]];
  const LIMITE_DIAS = 30;
  // Campo do erro do servidor (info.campo) -> campos marcados na janela
  const CAMPOS = { ret: ["retD", "retH"], eng: ["engD", "engH"], barril: ["lhBarril"], torneira: ["lhTap"], funcionario: ["lhFunc"] };

  const somaDias = (dia, n) => { const d = new Date(`${dia}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const diaHoraTxt = (q) => `${q.dia.slice(8, 10)}/${q.dia.slice(5, 7)} às ${q.hora}`;            // { dia, hora } -> "25/11 às 23:10"
  const tsTxt = (s) => (s ? diaHoraTxt({ dia: s.slice(0, 10), hora: s.slice(11, 16) }) : "");   // "2026-11-24 18:40:25" -> "24/11 às 18:40"
  const tamanho = (b) => (b.tamanho_l ? ` · ${MC.fmtLitros(b.tamanho_l)}` : "");

  /* Relógio da operação: o fuso vem do servidor (taps:board) e a hora é a do servidor (corrigida pela diferença para o
     relógio do aparelho). Devolve () => { dia: "AAAA-MM-DD", hora: "HH:MM" }. */
  function relogio(board) {
    const skew = board.agora ? new Date(board.agora).getTime() - Date.now() : 0;
    const opcoes = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    let fmt;
    try { fmt = new Intl.DateTimeFormat("sv-SE", { ...opcoes, timeZone: board.fuso }); } catch (_) { fmt = new Intl.DateTimeFormat("sv-SE", opcoes); }
    return () => {
      const [dia, hora] = fmt.format(new Date(Date.now() + skew)).split(" ");
      return { dia, hora: hora.slice(0, 5) };
    };
  }

  function campoQuando(id, rotulo, hoje) {
    return `<div class="lh-quando"><span class="form-label d-block" id="${id}L">${rotulo}</span>
      <div class="lh-quando-campos">
        <input type="date" class="form-control" id="${id}D" aria-labelledby="${id}L" aria-label="Dia" value="${hoje}" max="${hoje}" min="${somaDias(hoje, -LIMITE_DIAS)}">
        <input type="time" class="form-control" id="${id}H" aria-label="Hora">
      </div>
      <div class="lh-chips">${ATALHOS.map(([txt, n]) => `<button type="button" class="lh-chip" data-dia="${id}" data-off="${n}" aria-pressed="false">${txt}</button>`).join("")}</div>
    </div>`;
  }

  /* unitId: a unidade aberta. usuario: o nome de quem está lançando (aparece na janela).
     aoSalvar(resultado): a tela recarrega o quadro. */
  async function abrir({ unitId, usuario, aoSalvar }) {
    let board, lista, funcs;
    try {
      [board, lista, funcs] = await Promise.all([
        MC.call("taps:board", { unitId }),
        MC.call("barris:list", { unitId, status: "disponivel" }),
        MC.call("funcionarios:list", { unitId }),
      ]);
    } catch (err) {
      MC.toast(err.message, "err");
      return;
    }
    const taps = board.torneiras;
    if (!taps.length) {
      MC.toast("Esta unidade ainda não tem torneiras cadastradas.", "err");
      return;
    }
    const agora = relogio(board);
    const hoje = agora().dia;
    const barris = [...lista].sort((a, b) =>
      String(MC.chopeLabel(a)).localeCompare(String(MC.chopeLabel(b)), "pt-BR") || String(a.codigo).localeCompare(String(b.codigo), "pt-BR", { numeric: true }));
    const ativos = funcs.filter((f) => f.ativo !== 0);
    const opcaoBarril = (b) => `<option value="${b.id}">#${MC.esc(b.codigo)} · ${MC.esc(MC.chopeLabel(b) || "Chope")}${tamanho(b)}${MC.saldoTexto(b) ? ` · ${MC.esc(MC.saldoTexto(b))}` : ""}</option>`;

    const overlay = MC.openOverlay(`<h2>Lançar com horário</h2>
      <p class="mc-modal-intro">Para registrar um engate ou uma retirada que não foi lançado na hora. O app grava o horário que você informar, e não o de agora.</p>
      <div class="mb-3"><span class="form-label d-block">O que aconteceu</span>
        <div class="lh-tipos" role="radiogroup" aria-label="O que aconteceu">${Object.entries(TIPOS).map(([k, [titulo, dica]]) => `
          <button type="button" class="escolha-btn" role="radio" aria-checked="false" data-tipo="${k}">
            <span class="escolha-titulo">${titulo}</span><span class="escolha-hint">${dica}</span></button>`).join("")}</div></div>
      <div class="mb-3"><label class="form-label" for="lhTap">Torneira</label>
        <select class="form-select" id="lhTap">${taps.map((t) => `<option value="${t.id}">Torneira ${t.numero} · ${t.ocupada
          ? `${MC.esc(MC.chopeLabel(t) || "Chope")} #${MC.esc(t.codigo)}` : "livre"}</option>`).join("")}</select></div>
      <p class="lh-aviso" id="lhAviso" role="status" hidden></p>
      <fieldset class="lh-parte" id="lhRet"><legend>Retirada</legend>
        <div class="lh-sai" id="lhSai"></div>
        ${campoQuando("ret", "Quando foi retirado", hoje)}
        <div><span class="form-label d-block">Como saiu</span>
          <div class="lh-chips" role="radiogroup" aria-label="Como saiu">
            <button type="button" class="lh-chip" role="radio" data-estado="vazio" aria-checked="true">Vazio</button>
            <button type="button" class="lh-chip" role="radio" data-estado="chope" aria-checked="false">Ainda tinha chope</button></div>
          <div class="lh-medida" id="lhMedida" hidden></div></div>
      </fieldset>
      <fieldset class="lh-parte" id="lhEng"><legend>Engate</legend>
        <div><label class="form-label" for="lhBarril">Barril que entrou</label>
          <select class="form-select" id="lhBarril">${barris.length
            ? `<option value="">Escolha o barril</option>${barris.map(opcaoBarril).join("")}`
            : '<option value="">Nenhum barril disponível</option>'}</select></div>
        <div class="lh-leitor"><span class="form-label d-block lh-ou">Ou leia a etiqueta</span><div id="lhLeitor"></div></div>
        ${campoQuando("eng", "Quando foi engatado", hoje)}
        <button type="button" class="lh-chip lh-igual" id="lhIgual">Usar o horário da retirada</button>
      </fieldset>
      <div class="mb-3"><label class="form-label" for="lhFunc">Quem fez</label>
        <select class="form-select" id="lhFunc"><option value="">Não sei</option>${ativos.map((f) => `<option value="${f.id}">${MC.esc(f.nome)}</option>`).join("")}</select>
        <div class="form-hint">Fica gravado também que foi ${MC.esc(usuario)} quem lançou, e quando.</div></div>
      <div class="lh-resumo" id="lhResumo" aria-live="polite"></div>
      <div class="field-error" id="lhErr" role="alert"></div>
      <div class="mc-modal-actions"><button type="button" class="btn-ghost" data-cancel>Cancelar</button>
        <button type="button" class="btn btn-mc btn-mc-sm lh-ok" data-ok>Salvar lançamento</button></div>`);
    const modal = overlay.querySelector(".mc-modal");
    modal.classList.add("mc-modal--horario");
    modal.setAttribute("aria-label", "Lançar com horário");
    const $ = (sel) => modal.querySelector(sel);
    const tapSel = $("#lhTap");
    const barrilSel = $("#lhBarril");
    const funcSel = $("#lhFunc");
    const errEl = $("#lhErr");
    const okBtn = $("[data-ok]");
    const aviso = $("#lhAviso");

    let tipo = "troca";
    let estado = "vazio";  // como o barril saiu
    let medida = null;     // "Ainda tinha chope": a medida da balança ou estimativa
    // Começa na primeira torneira ocupada (a troca é o caso mais comum)
    const primeiraOcupada = taps.find((t) => t.ocupada);
    if (primeiraOcupada) tapSel.value = String(primeiraOcupada.id);
    const tapAtual = () => taps.find((t) => t.id === Number(tapSel.value));

    const ler = (id) => {
      const dia = $(`#${id}D`).value;
      const hora = $(`#${id}H`).value;
      return dia && /^\d{2}:\d{2}/.test(hora) ? { dia, hora: hora.slice(0, 5) } : null;
    };
    const marcar = (ids) => {
      modal.querySelectorAll(".is-invalid").forEach((x) => x.classList.remove("is-invalid"));
      (ids || []).forEach((id) => { const x = $(`#${id}`); if (x) x.classList.add("is-invalid"); });
    };
    const falha = (msg, ids) => {
      marcar(ids);
      errEl.textContent = msg;
      const alvo = ids && ids.length ? $(`#${ids[0]}`) : errEl;
      if (alvo) alvo.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return false;
    };
    const limparErro = () => { errEl.textContent = ""; marcar([]); };

    function textoMedida() {
      if (!medida) return "";
      const litros = medida.litros === null ? "o chope que sobrou" : `${medida.estimado ? "≈ " : ""}${MC.fmtLitros(medida.litros)}`;
      return `${litros} (${medida.estimado ? "estimado" : "pesado"})`;
    }

    function resumo() {
      const t = tapAtual();
      const linhas = [];
      const tRet = ler("ret");
      const tEng = ler("eng");
      const falta = (o) => `<i>(falta ${o})</i>`;
      if (tipo !== "engate" && t.ocupada) {
        const como = estado === "vazio" ? "vazio" : medida ? `com ${MC.esc(textoMedida())}` : `com chope ${falta("a medida")}`;
        linhas.push(`#${MC.esc(t.codigo)} retirado ${como} em ${tRet ? diaHoraTxt(tRet) : falta("o horário")}`);
      }
      if (tipo !== "retirada" && !(tipo === "engate" && t.ocupada)) {
        const b = barris.find((x) => x.id === Number(barrilSel.value));
        linhas.push(`${b ? `#${MC.esc(b.codigo)}` : falta("o barril")} engatado em ${tEng ? diaHoraTxt(tEng) : falta("o horário")}`);
      }
      const box = $("#lhResumo");
      box.hidden = !linhas.length;
      const quem = funcSel.value ? funcSel.options[funcSel.selectedIndex].text : "não informado";
      box.innerHTML = `<b>Vai ficar registrado na Torneira ${t.numero}</b><ul>${linhas.map((l) => `<li>${l}</li>`).join("")}</ul>` +
        `<div class="lh-resumo-quem">Feito por: ${MC.esc(quem)}</div>`;
    }

    function atualizar() {
      const t = tapAtual();
      modal.querySelectorAll("[data-tipo]").forEach((b) => {
        const sim = b.dataset.tipo === tipo;
        b.classList.toggle("is-selected", sim);
        b.setAttribute("aria-checked", String(sim));
      });
      const temRet = tipo !== "engate";
      const temEng = tipo !== "retirada";
      $("#lhRet").hidden = !temRet;
      $("#lhEng").hidden = !temEng;
      $("#lhIgual").hidden = tipo !== "troca";
      let msg = "";
      if (temRet && !t.ocupada) msg = `A Torneira ${t.numero} está livre, não tem barril para retirar. Escolha outra torneira ou use Só engate.`;
      if (tipo === "engate" && t.ocupada) msg = `A Torneira ${t.numero} está com o #${t.codigo}. Para pôr outro barril nela, use Troca de barril.`;
      aviso.textContent = msg;
      aviso.hidden = !msg;
      okBtn.disabled = !!msg;
      $("#lhSai").innerHTML = temRet && t.ocupada
        ? `Sai: #${MC.esc(t.codigo)} · ${MC.esc(MC.chopeLabel(t) || "Chope")}${tamanho(t)}
           <small>Engatado em ${tsTxt(t.engatado_em)}${t.engatado_por ? ` por ${MC.esc(t.engatado_por)}` : ""}</small>`
        : "";
      modal.querySelectorAll("[data-estado]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.estado === estado)));
      const med = $("#lhMedida");
      med.hidden = estado !== "chope";
      med.innerHTML = medida
        ? `Sobraram ${MC.esc(textoMedida())}. <button type="button" class="lh-link" data-medir>Medir de novo</button>`
        : `<button type="button" class="lh-link" data-medir>Medir o chope que sobrou</button> (balança ou estimativa)`;
      ["ret", "eng"].forEach((id) => {
        const v = $(`#${id}D`).value;
        modal.querySelectorAll(`[data-dia="${id}"]`).forEach((c) => c.setAttribute("aria-pressed", String(somaDias(hoje, Number(c.dataset.off)) === v)));
      });
      resumo();
    }

    // Confere o que dá para conferir aqui. As outras regras (último registro do barril, inventário, torneira livre
    // desde quando) voltam do servidor, com a mesma mensagem e o campo.
    function conferir() {
      const t = tapAtual();
      const a = agora();
      const futuro = (q) => `${q.dia} ${q.hora}` > `${a.dia} ${a.hora}`;
      let tRet = null;
      if (tipo !== "engate") {
        tRet = ler("ret");
        if (!tRet) return falha("Informe o dia e a hora da retirada.", $("#retD").value ? ["retH"] : ["retD", "retH"]);
        if (futuro(tRet)) return falha(`A retirada não pode ficar no futuro. Agora são ${a.hora}.`, CAMPOS.ret);
        if (`${tRet.dia} ${tRet.hora}:00` <= String(t.engatado_em || ""))
          return falha(`O #${t.codigo} foi engatado em ${tsTxt(t.engatado_em)}. A retirada tem de ser depois disso.`, CAMPOS.ret);
        if (estado === "chope" && !medida) return falha("Meça o chope que sobrou (balança ou estimativa) ou escolha Vazio.", []);
      }
      if (tipo !== "retirada") {
        if (!barrilSel.value) return falha("Escolha o barril que foi engatado.", CAMPOS.barril);
        const tEng = ler("eng");
        if (!tEng) return falha("Informe o dia e a hora do engate.", $("#engD").value ? ["engH"] : CAMPOS.eng);
        if (futuro(tEng)) return falha(`O engate não pode ficar no futuro. Agora são ${a.hora}.`, CAMPOS.eng);
        if (tRet && `${tEng.dia} ${tEng.hora}` < `${tRet.dia} ${tRet.hora}`)
          return falha(`O engate tem de ser no mesmo horário da retirada ou depois dela (${diaHoraTxt(tRet)}).`, CAMPOS.eng);
      }
      return true;
    }

    async function medirChope() {
      const t = tapAtual();
      const m = await MCBarril.medir({
        barril: { codigo: t.codigo, tamanho_l: t.tamanho_l },
        titulo: `Chope que sobrou no #${t.codigo}`,
        intro: `Barril de ${MC.fmtLitros(t.tamanho_l)}. Quanto chope ainda tinha nele quando saiu?`,
        okLabel: "Usar esta medida",
      });
      if (!m) return;
      if (m.quaseVazio) {
        const sim = await MC.confirm({
          title: "Barril praticamente vazio",
          text: `Sobrou só ${MC.fmtLitros(m.litros)} no barril #${t.codigo}. Lançar a retirada como vazio?`,
          confirmLabel: "Lançar como vazio",
          cancelLabel: "Cancelar",
        });
        if (sim) { estado = "vazio"; medida = null; }
        atualizar();
        return;
      }
      estado = "chope";
      medida = m;
      limparErro();
      atualizar();
    }

    const leitor = MCLeitor.montar($("#lhLeitor"), {
      unitId: () => unitId,
      rotuloCamera: "Ler a etiqueta com a câmera",
      aoAchar: (b) => {
        limparErro();
        const porque = MCLeitor.motivo(b, { unitId, acao: "engatar" });
        if (porque) { leitor.erro(porque); return; }
        if (!barris.some((x) => x.id === b.id)) { // ficou disponível depois que a janela abriu
          barris.push(b);
          barrilSel.insertAdjacentHTML("beforeend", opcaoBarril(b));
        }
        barrilSel.value = String(b.id);
        leitor.ok(`#${b.codigo} · ${MC.chopeLabel(b) || "Chope"}${tamanho(b)} escolhido.`);
        if (window.matchMedia("(pointer: coarse)").matches && document.activeElement) document.activeElement.blur();
        resumo();
      },
    });

    return new Promise((resolve) => {
      const fechar = (r) => { leitor.destruir(); overlay.remove(); resolve(r); };
      overlay.querySelector("[data-cancel]").addEventListener("click", () => fechar(null));
      overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") fechar(null); });

      modal.addEventListener("click", (ev) => {
        const b = ev.target.closest("button");
        if (!b || b.hasAttribute("data-cancel") || b.hasAttribute("data-ok") || b.closest("#lhLeitor")) return;
        if (b.dataset.tipo) { tipo = b.dataset.tipo; limparErro(); }
        else if (b.dataset.estado === "chope") { if (!medida) { medirChope(); return; } estado = "chope"; }
        else if (b.dataset.estado === "vazio") estado = "vazio";
        else if (b.hasAttribute("data-medir")) { medirChope(); return; }
        else if (b.dataset.dia) { $(`#${b.dataset.dia}D`).value = somaDias(hoje, Number(b.dataset.off)); }
        else if (b.id === "lhIgual") { $("#engD").value = $("#retD").value; $("#engH").value = $("#retH").value; }
        else return;
        atualizar();
      });
      modal.addEventListener("input", () => { errEl.textContent = ""; resumo(); });
      modal.addEventListener("change", (ev) => {
        if (ev.target === tapSel) { medida = null; estado = "vazio"; limparErro(); }
        if (ev.target === barrilSel) leitor.limpar();
        ev.target.classList.remove("is-invalid");
        atualizar();
      });

      okBtn.addEventListener("click", async () => {
        limparErro();
        if (!conferir()) return;
        const t = tapAtual();
        const tRet = ler("ret");
        const tEng = ler("eng");
        const pedido = { unitId, torneiraId: t.id, tipo, funcionarioId: Number(funcSel.value) || undefined };
        if (tipo !== "engate") {
          pedido.retirada = { quando: `${tRet.dia}T${tRet.hora}`, vazio: estado === "vazio" };
          if (estado === "chope") {
            pedido.retirada.medida = { metodo: medida.metodo, pesoBruto: medida.pesoBruto, taraId: medida.taraId, taraNovaKg: medida.taraNovaKg, nivel: medida.nivel };
          }
        }
        if (tipo !== "retirada") pedido.engate = { barrilId: Number(barrilSel.value), quando: `${tEng.dia}T${tEng.hora}` };
        okBtn.disabled = true;
        leitor.parar();
        try {
          const r = await MC.call("taps:lancarComHorario", pedido);
          fechar(r);
          const partes = [];
          if (r.retirada) partes.push(`#${r.retirada.codigo} retirado em ${r.retirada.quando}`);
          if (r.engate) partes.push(`#${r.engate.codigo} engatado em ${r.engate.quando}`);
          MC.toast(`Torneira ${r.torneira}: ${partes.join(" e ")}.`, "ok");
          MCLayout.refreshAlerts();
          if (aoSalvar) aoSalvar(r);
        } catch (err) {
          okBtn.disabled = false;
          // Erro de um campo: marca o campo. Quase vazio (balança): a mensagem pede para escolher Vazio.
          falha(err.message, err.code === "CAMPO" && err.info ? CAMPOS[err.info.campo] : []);
        }
      });

      atualizar();
      tapSel.focus({ preventScroll: true });
    });
  }

  return { abrir };
})();
