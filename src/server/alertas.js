/* ==========================================================
   BarrilFacil — alertas do sino (alerts:list), montados a partir das consultas
   Cada alerta tem o texto do sino (texto, nivel) e a versão curta do Painel do celular, em "Precisa de atenção":
   titulo (em negrito), detalhe (opcional) e etiqueta (a etiqueta colorida), com o tipo, que decide a cor:
     vencido, sem_estoque -> vermelho; acabando -> amarelo; vence_hoje, vence_amanha, transferencia_chegando,
     transferencia_enviada -> azul; vazio -> neutro.
   Ordem (a do sino): validade (vencidos primeiro), transferências pendentes, vazios aguardando recolhimento,
   estoque baixo por chope.
   ========================================================== */
const diaMes = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`; // "2026-10-22" -> "22/10"

/* Estoque baixo: 2 ou menos barris disponíveis de um chope que tem algum barril (não recolhido) na unidade */
const ESTOQUE_BAIXO = 2;

/* Situação do estoque de um chope pelos barris disponíveis: a mesma regra no aviso do sino e na tabela
   "Estoque por chope" do Painel do computador. 0 = sem estoque; 1 ou 2 = acabando; 3 ou mais = ok. */
const situacaoEstoque = (disponiveis) => (disponiveis === 0 ? "sem_estoque" : disponiveis <= ESTOQUE_BAIXO ? "acabando" : "ok");

/* Barris não recolhidos da unidade ({ chope_id, chope_nome, estilo, status }) agrupados por chope, na ordem em que
   aparecem: { chope_id, nome, disponiveis, engatados, situacao }. Barril antigo sem chope do catálogo agrupa pelo nome
   (ou pelo estilo) gravado nele. Entram os chopes com algum barril na unidade, mesmo sem nenhum disponível. */
function estoquePorChope(estoque = []) {
  const porChope = new Map();
  estoque.forEach((b) => {
    const chave = b.chope_id || `${b.chope_nome || ""}|${b.estilo || ""}`;
    const item = porChope.get(chave) || { chope_id: b.chope_id || null, nome: b.chope_nome || b.estilo || "Chope", disponiveis: 0, engatados: 0 };
    if (b.status === "disponivel") item.disponiveis += 1;
    else if (b.status === "em_uso") item.engatados += 1;
    porChope.set(chave, item);
  });
  return [...porChope.values()].map((c) => ({ ...c, situacao: situacaoEstoque(c.disponiveis) }));
}

/* unit: id da unidade; hoje: "AAAA-MM-DD" no fuso da operação.
   validade: fn_alertas_validade ({ codigo, chope, validade }); pendentes: transferências pendentes da unidade, com
   barris(codigo), origem(nome), destino(nome); vazios: fn_alertas_vazios ({ codigo, dias });
   estoque: barris não recolhidos da unidade ({ chope_id, chope_nome, estilo, status }). */
function montarAlertas({ unit, hoje, validade = [], pendentes = [], vazios = [], estoque = [] }) {
  const alerts = [];

  validade.forEach((b) => {
    const quem = `Barril #${b.codigo}${b.chope ? ` (${b.chope})` : ""}`;
    const curto = { titulo: `#${b.codigo}`, detalhe: b.chope || null };
    if (b.validade < hoje)
      alerts.push({ nivel: "erro", texto: `${quem} venceu em ${diaMes(b.validade)}. Confira se estava na câmara fria.`,
        tipo: "vencido", ...curto, etiqueta: "Vencido" });
    else if (b.validade === hoje) alerts.push({ texto: `${quem} vence hoje.`, tipo: "vence_hoje", ...curto, etiqueta: "Vence hoje" });
    else alerts.push({ texto: `${quem} vence amanhã (${diaMes(b.validade)}).`, tipo: "vence_amanha", ...curto, etiqueta: "Vence amanhã" });
  });

  pendentes.forEach((t) => {
    const codigo = t.barris ? t.barris.codigo : "?";
    const chegando = t.destino_id === unit;
    alerts.push(chegando
      ? { texto: `Barril #${codigo} vindo de ${t.origem.nome} aguardando seu recebimento.`,
        tipo: "transferencia_chegando", titulo: `#${codigo}`, detalhe: `de ${t.origem.nome}`, etiqueta: "Chegando" }
      : { texto: `Barril #${codigo} aguardando confirmação de ${t.destino.nome}.`,
        tipo: "transferencia_enviada", titulo: `#${codigo}`, detalhe: `para ${t.destino.nome}`, etiqueta: "Enviado" });
  });

  vazios.forEach((v) => alerts.push({
    texto: `Barril #${v.codigo} vazio aguardando recolhimento há ${v.dias} dias`,
    tipo: "vazio", titulo: `#${v.codigo}`, detalhe: null, etiqueta: `Vazio há ${v.dias} dias`,
  }));

  estoquePorChope(estoque).forEach((b) => {
    if (b.situacao === "ok") return;
    alerts.push(b.situacao === "sem_estoque"
      ? { nivel: "erro", texto: `Estoque baixo: nenhum barril disponível de ${b.nome} nesta unidade.`,
        tipo: "sem_estoque", titulo: b.nome, detalhe: null, etiqueta: "Sem estoque" }
      : { nivel: "aviso", texto: `Estoque baixo: restam ${b.disponiveis} barris disponíveis de ${b.nome} nesta unidade.`,
        tipo: "acabando", titulo: b.nome, detalhe: null, etiqueta: `Acabando · ${b.disponiveis}` });
  });

  return alerts;
}

module.exports = { montarAlertas, estoquePorChope, situacaoEstoque, ESTOQUE_BAIXO };
