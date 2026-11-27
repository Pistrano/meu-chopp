/* ==========================================================
   BarrilFacil — Painel do computador (dashboard:computador): monta a resposta a partir das consultas
   A perda NÃO é calculada aqui: vem pronta do banco, das mesmas funções do Relatório de perdas (fn_perdas_periodos para
   a lista e o gráfico de linhas, fn_perdas_periodo para o período escolhido, por chope), e passa pelo perdas.js, que tira
   o dinheiro de quem não tem "catalogo:editar". O estoque por chope usa a regra do aviso de estoque baixo (alertas.js).
   ========================================================== */
const perdas = require("./perdas");
const { estoquePorChope } = require("./alertas");

// Quantos períodos o Painel mostra (a lista do topo e o gráfico de linhas): os 8 últimos
const PAINEL_PERIODOS = 8;

const ORDEM_SITUACAO = { sem_estoque: 0, acabando: 1, ok: 2 };
const chaveNome = (n) => String(n || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/* Estoque por chope: sem estoque, depois acabando, depois ok; dentro de cada grupo, o que mais saiu no período primeiro
   (sem período, ou empate, pelo nome) */
function ordenarEstoque(linhas) {
  return linhas.slice().sort((a, b) => ORDEM_SITUACAO[a.situacao] - ORDEM_SITUACAO[b.situacao]
    || (b.saiu || 0) - (a.saiu || 0)
    || a.nome.localeCompare(b.nome, "pt-BR"));
}

/* Litros que saíram de cada chope do estoque no período: pelo chope do catálogo e, para o barril antigo sem chope do
   catálogo, pelo nome (só entre os chopes do período que não casaram pelo catálogo). Sem período: null. */
function comSaiu(linhas, periodo) {
  if (!periodo) return linhas.map((l) => ({ ...l, saiu: null }));
  const porId = new Map();
  const porNome = new Map();
  periodo.chopes.forEach((c) => { if (c.chope_id) porId.set(c.chope_id, c); });
  const usados = new Set(linhas.filter((l) => l.chope_id && porId.has(l.chope_id)).map((l) => l.chope_id));
  periodo.chopes.forEach((c) => { if (!c.chope_id || !usados.has(c.chope_id)) porNome.set(chaveNome(c.nome), c); });
  return linhas.map((l) => {
    const c = (l.chope_id && porId.get(l.chope_id)) || (!l.chope_id && porNome.get(chaveNome(l.nome))) || null;
    return { ...l, saiu: c ? c.saiu : 0 };
  });
}

/* periodos: o que fn_perdas_periodos devolve (ou null se o relatório de perdas não está instalado no banco);
   relatorio: fn_perdas_periodo do período escolhido (null sem período); estoque: barris não recolhidos da unidade
   ({ chope_id, chope_nome, estilo, status }); movimentacoes: queryMovements; semFuncionarios: como no dashboard:get.
   dinheiro: a pessoa tem "catalogo:editar". fmtTs: data -> "AAAA-MM-DD HH:MM:SS" no fuso. */
function montarPainelComputador({ periodos, relatorio, estoque = [], movimentacoes = [], semFuncionarios = null, semPerdas = null },
  { dinheiro, fmtTs }) {
  const lista = periodos ? perdas.montarPeriodos(periodos, { dinheiro, fmtTs }) : { inventarios: [], aberto: null, periodos: [] };
  const periodo = relatorio ? perdas.montarRelatorio(relatorio, { dinheiro, fmtTs }) : null;
  return {
    dinheiro: !!dinheiro,
    // Se o SQL do relatório de perdas ainda não rodou no banco, a mensagem (o resto do Painel funciona)
    semPerdas,
    inventariosConcluidos: lista.inventarios.length,
    aberto: lista.aberto,
    // Do mais velho para o mais novo (a ordem do gráfico); o último é o período mais recente
    periodos: lista.periodos.slice().reverse(),
    // O período escolhido, com os números por chope (para as barras e a coluna "Saiu no período")
    periodo,
    estoque: ordenarEstoque(comSaiu(estoquePorChope(estoque), periodo)),
    noEstoque: estoque.filter((b) => b.status === "disponivel" || b.status === "em_uso").length,
    vazios: estoque.filter((b) => b.status === "esgotado").length,
    movimentacoes,
    semFuncionarios,
  };
}

module.exports = { montarPainelComputador, ordenarEstoque, PAINEL_PERIODOS };
