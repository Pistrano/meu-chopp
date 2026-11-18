/* BarrilFacil — preço do chope e tamanhos de barril, usados na tela Chopes e no cadastro de barril.
   Só aparecem para quem tem a permissão catalogo:editar (administrador e gerente); o servidor também bloqueia.
   Preço único (caixa desmarcada): custo por litro. Por tamanho (caixa marcada): o preço do barril de cada tamanho ativo,
   com o custo por litro calculado enquanto a pessoa digita. O servidor recalcula e grava. */
window.MCPrecos = (() => {
  /* R$ com duas casas: 15 -> "R$ 15,00" */
  const reais = (n) => `R$ ${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  /* "300", "300,50", "1.234,56" ou "R$ 575,00" -> número. Vazio -> null. Inválido -> NaN. */
  function dinheiro(v) {
    let t = String(v ?? "").replace(/R\$|\s/g, "");
    if (t === "") return null;
    if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
    return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  }
  const campoValor = (n) => (n === null || n === undefined ? ""
    : Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }));
  const idTamanho = (t) => `prT_${String(t).replace(".", "_")}`;

  /* Custo por litro do chope para a lista: o valor, a faixa ou "Sem preço" (em destaque). */
  function custoTexto(custo) {
    if (!custo || custo.semPreco) return '<span class="sem-preco">Sem preço</span>';
    const faixa = custo.min === custo.max ? `${reais(custo.min)}/L` : `${reais(custo.min)} a ${reais(custo.max)}`;
    const falta = (custo.semPrecoTamanhos || []).map((t) => MC.fmtLitros(t));
    return MC.esc(faixa) + (falta.length ? `<br><span class="sem-preco sem-preco--parcial">Sem preço: ${MC.esc(falta.join(", "))}</span>` : "");
  }

  /* Campos de preço. tamanhos: litros dos tamanhos ativos, do menor para o maior. atual: o que vale hoje
     (custoLitro, ou precos = [{ tamanho, precoBarril }]). inicio: mostra o campo Início com esta data (tela Preços). */
  function html({ tamanhos, porTamanho = false, custoLitro = null, precos = [], inicio = null }) {
    const precoDe = (t) => (precos.find((p) => p.tamanho === t) || {}).precoBarril;
    return `<div class="precos" data-precos>
      <label class="check-item precos-caixa"><input type="checkbox" id="prPorTamanho" ${porTamanho ? "checked" : ""}>
        <span>O preço muda conforme o tamanho do barril?</span></label>
      <div class="mb-3 precos-unico${porTamanho ? " d-none" : ""}">
        <label class="form-label" for="prCustoLitro">Custo por litro (R$)</label>
        <input class="form-control" id="prCustoLitro" inputmode="decimal" autocomplete="off" placeholder="Ex.: 12,50" value="${campoValor(custoLitro)}">
      </div>
      <div class="precos-tamanhos${porTamanho ? "" : " d-none"}">
        ${tamanhos.map((t) => `<div class="mb-3">
          <label class="form-label" for="${idTamanho(t)}">Barril de ${MC.esc(MC.fmtLitros(t))} (R$)</label>
          <div class="preco-linha"><input class="form-control" id="${idTamanho(t)}" data-tamanho="${t}" inputmode="decimal" autocomplete="off"
            placeholder="Sem preço" value="${campoValor(precoDe(t))}"><span class="preco-litro" aria-live="polite"></span></div></div>`).join("")}
        <p class="form-hint precos-dica">Preencha pelo menos um tamanho. O que ficar vazio fica "Sem preço".</p>
      </div>
      ${inicio ? `<div class="mb-3"><label class="form-label" for="prInicio">Início</label>
        <input class="form-control" id="prInicio" type="date" value="${MC.esc(inicio)}" aria-describedby="prInicioDica">
        <div id="prInicioDica" class="form-hint">Vale para os barris cadastrados a partir desta data.</div></div>` : ""}
    </div>`;
  }

  /* Liga a caixa (mostra um modo ou o outro) e o custo por litro de cada tamanho enquanto digita ("R$ 15,00/L") */
  function ligar(raiz) {
    const box = raiz.querySelector("[data-precos]");
    if (!box) return;
    const caixa = box.querySelector("#prPorTamanho");
    const sync = () => {
      box.querySelector(".precos-unico").classList.toggle("d-none", caixa.checked);
      box.querySelector(".precos-tamanhos").classList.toggle("d-none", !caixa.checked);
    };
    caixa.addEventListener("change", () => {
      sync();
      const foco = caixa.checked ? box.querySelector("[data-tamanho]") : box.querySelector("#prCustoLitro");
      if (foco) foco.focus();
    });
    box.querySelectorAll("[data-tamanho]").forEach((input) => {
      const saida = input.parentElement.querySelector(".preco-litro");
      const calcula = () => {
        const v = dinheiro(input.value);
        saida.textContent = v === null ? "" : v > 0 ? `${reais(v / Number(input.dataset.tamanho))}/L` : "valor inválido";
        saida.classList.toggle("preco-litro--erro", v !== null && !(v > 0));
      };
      input.addEventListener("input", calcula);
      calcula();
    });
    sync();
  }

  /* Lê os campos para mandar ao servidor ({ precoPorTamanho, custoLitro, precos, inicio }). Lança erro com a mensagem. */
  function ler(raiz) {
    const box = raiz.querySelector("[data-precos]");
    const porTamanho = box.querySelector("#prPorTamanho").checked;
    const inicio = box.querySelector("#prInicio");
    const r = { precoPorTamanho: porTamanho, inicio: inicio ? inicio.value : undefined };
    if (inicio && !inicio.value) throw new Error("Informe a data de início do preço.");
    if (!porTamanho) {
      const v = dinheiro(box.querySelector("#prCustoLitro").value);
      if (v === null) throw new Error("Informe o custo por litro (R$).");
      if (!(v > 0)) throw new Error("Custo por litro inválido. Use só números, com vírgula nos centavos (ex.: 12,50).");
      return { ...r, custoLitro: v };
    }
    const precos = {};
    for (const input of box.querySelectorAll("[data-tamanho]")) {
      const v = dinheiro(input.value);
      if (v === null) continue;
      if (!(v > 0)) throw new Error(`Preço do barril de ${MC.fmtLitros(input.dataset.tamanho)} inválido. Use só números, com vírgula nos centavos.`);
      precos[input.dataset.tamanho] = v;
    }
    if (!Object.keys(precos).length) throw new Error("Informe o preço de pelo menos um tamanho de barril.");
    return { ...r, precos };
  }

  /* Cadastro de tamanho de barril (tela Barris e tela Chopes). Resolve com o tamanho criado ({ id, litros, prefixo })
     ou false se a pessoa cancelar. */
  function novoTamanho() {
    return MC.dialog({
      title: "Novo tamanho de barril",
      intro: "O tamanho novo aparece no cadastro de barril e nos preços dos chopes. Os chopes com preço por tamanho ficam \"Sem preço\" nele até alguém preencher.",
      fields: [
        { id: "litros", label: "Litros (inteiro ou uma casa decimal)", value: "" },
        { id: "prefixo", label: "Prefixo do código (opcional, ex.: BA4)", value: "" },
      ],
      submitLabel: "Cadastrar tamanho",
      onOpen: (overlay) => {
        overlay.querySelector("#mcf_litros").setAttribute("inputmode", "decimal");
        const pre = overlay.querySelector("#mcf_prefixo");
        pre.setAttribute("maxlength", "10");
        pre.style.textTransform = "uppercase";
      },
      onSubmit: (v) => {
        const litros = String(v.litros).trim().replace(",", ".");
        if (!litros) throw new Error("Informe os litros do barril.");
        if (!/^\d+(\.\d)?$/.test(litros)) throw new Error("Use um número inteiro ou com uma casa decimal (ex.: 40 ou 7,5).");
        return MC.call("tamanhos:create", { litros: Number(litros), prefixo: v.prefixo });
      },
    });
  }

  return { reais, dinheiro, custoTexto, html, ligar, ler, novoTamanho };
})();
