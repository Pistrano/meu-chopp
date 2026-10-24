/* ==========================================================
   BarrilFacil — ações do barril usadas em mais de uma aba (Barris e Torneiras)
   Engatar numa torneira (com a confirmação de barril vencido) e retirar da torneira.
   Fica num lugar só: mudanças no fluxo (ex.: perguntar se o barril retirado ainda tem chope)
   valem para as duas abas. Depende de common.js (MC) e layout.js (MCLayout).
   ========================================================== */
const MCBarril = (() => {
  /* Engate: barris:use. Barril vencido só gera aviso: a pessoa confirma e o engate fica na auditoria.
     Retorna o resultado do servidor ({ codigo, torneira, ... }) ou false se a pessoa desistiu do vencido.
     Erros do servidor (torneira ocupada, barril já usado em outro aparelho...) sobem para quem chamou. */
  async function engatar({ barrilId, torneiraId, unitId }) {
    const pedido = { id: barrilId, torneiraId, unitId };
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
    MC.toast(`Barril #${result.codigo} engatado na Torneira ${result.torneira}.`);
    MCLayout.refreshAlerts();
    return result;
  }

  /* Retirada: confirmação, barris:empty e o aviso de sucesso. O barril fica "Vazio" e a torneira é liberada.
     barril: { id, codigo, torneira_numero }. aoRetirar(result): a tela se recarrega por trás do aviso.
     fecharNoErro: em vez de mostrar o erro dentro da janela, fecha e repassa o erro (a aba Torneiras
     mostra a mensagem e recarrega o quadro). Retorna o resultado, ou null se a pessoa cancelou. */
  async function retirar({ barril, unidade, aoRetirar, fecharNoErro = false }) {
    let falha = null;
    const result = await MC.dialog({
      title: `Retirar barril #${barril.codigo}`,
      intro: barril.torneira_numero
        ? `Unidade: ${unidade}. O barril está na Torneira ${barril.torneira_numero}, que será liberada. Ao ser retirado, o barril fica "Vazio" até a fábrica recolher.`
        : `Unidade: ${unidade}. Este barril não tem torneira registrada (foi engatado antes do controle de torneiras), então nenhuma torneira será liberada. O barril fica "Vazio" até a fábrica recolher.`,
      submitLabel: "Confirmar retirada",
      onSubmit: async () => {
        try {
          return await MC.call("barris:empty", { id: barril.id });
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
        ["Torneira liberada", result.torneira ? `Torneira ${result.torneira}` : "Nenhuma (sem torneira registrada)"],
        ["Situação", "Vazio (aguardando recolhimento)"],
      ],
    });
    return result;
  }

  return { engatar, retirar };
})();
