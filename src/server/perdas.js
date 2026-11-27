/* ==========================================================
   BarrilFacil — relatório de perdas (Mais > Relatório de perdas): monta as respostas das rotas perdas:* e o CSV
   A conta é toda do banco (fn_perdas_periodo; fn_perdas_periodos chama a mesma para cada par de inventários).
   Aqui os números viram Number, as datas vão para o fuso da operação e, para quem não pode ver dinheiro
   (sem "catalogo:editar"), os campos de dinheiro não saem do servidor: custo do litro, R$ e "sem preço".
   ========================================================== */
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

// "2026-11-12" -> "12/11"
const diaMes = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
const proximoDia = (dia) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
/* Dias sem vendas em texto, com os seguidos juntos: ["2026-11-12","2026-11-13","2026-11-15"] -> "12/11 a 13/11 e 15/11".
   Dois dias seguidos ficam "12/11 e 13/11"; três ou mais, "12/11 a 14/11". */
function textoDias(dias) {
  const faixas = [];
  [...(dias || [])].sort().forEach((d) => {
    const ult = faixas[faixas.length - 1];
    if (ult && proximoDia(ult[ult.length - 1]) === d) ult.push(d);
    else faixas.push([d]);
  });
  const partes = faixas.flatMap((f) => (f.length === 1 ? [diaMes(f[0])]
    : f.length === 2 ? [diaMes(f[0]), diaMes(f[1])] : [`${diaMes(f[0])} a ${diaMes(f[f.length - 1])}`]));
  return partes.length > 1 ? `${partes.slice(0, -1).join(", ")} e ${partes[partes.length - 1]}` : partes[0] || "";
}

function barril(b, dinheiro) {
  const x = {
    id: b.barril_id, codigo: b.codigo, tamanho_l: num(b.tamanho_l),
    inicio: num(b.inicio), inicio_estimado: !!b.inicio_estimado, chegou: !!b.chegou,
    recebido: num(b.recebido), recebido_de: b.recebido_de || null,
    enviado: num(b.enviado), enviado_para: b.enviado_para || null,
    fim: num(b.fim), fim_estimado: !!b.fim_estimado, acabou: !!b.acabou,
    saiu: num(b.saiu),
  };
  if (dinheiro) x.custo_litro = num(b.custo_litro);
  return x;
}

function chope(c, dinheiro) {
  const x = {
    chope_id: c.chope_id ?? null, nome: c.nome,
    saiu: num(c.saiu), vendido: num(c.vendido), perda: num(c.perda), pct: num(c.pct), estimado: !!c.estimado,
    barris: (c.barris || []).map((b) => barril(b, dinheiro)),
  };
  if (dinheiro) Object.assign(x, { custo_litro: num(c.custo_litro), reais: num(c.reais), sem_preco: !!c.sem_preco });
  return x;
}

function totais(t, dinheiro) {
  const x = { saiu: num(t.saiu), vendido: num(t.vendido), perda: num(t.perda), pct: num(t.pct), estimado: !!t.estimado };
  if (dinheiro) Object.assign(x, { reais: num(t.reais), sem_preco: Array.isArray(t.sem_preco) ? t.sem_preco : [] });
  return x;
}

const inventario = (i, fmtTs) => (i ? { id: i.id, iniciado_em: fmtTs(i.iniciado_em), concluido_em: fmtTs(i.concluido_em) } : null);

/* r: o que fn_perdas_periodo devolve. dinheiro: a pessoa tem "catalogo:editar". fmtTs: data -> "AAAA-MM-DD HH:MM:SS" no fuso. */
function montarRelatorio(r, { dinheiro, fmtTs }) {
  const dias = Array.isArray(r.dias_sem_vendas) ? r.dias_sem_vendas : [];
  return {
    unidade: r.unidade ? { id: r.unidade.id, nome: r.unidade.nome } : null,
    inventario_de: inventario(r.inventario_de, fmtTs),
    inventario_ate: inventario(r.inventario_ate, fmtTs),
    de: fmtTs(r.de), ate: fmtTs(r.ate),
    sem_vendas: !!r.sem_vendas,
    dias_sem_vendas: dias,
    dias_sem_vendas_texto: textoDias(dias),
    dinheiro: !!dinheiro,
    total: totais(r.total || {}, dinheiro),
    chopes: (r.chopes || []).map((c) => chope(c, dinheiro)),
  };
}

/* r: o que fn_perdas_periodos devolve (inventários concluídos do mais novo para o mais velho, o aberto e os períodos). */
function montarPeriodos(r, { dinheiro, fmtTs }) {
  return {
    inventarios: (r.inventarios || []).map((i) => inventario(i, fmtTs)),
    aberto: r.aberto ? { id: r.aberto.id, iniciado_em: fmtTs(r.aberto.iniciado_em) } : null,
    periodos: (r.periodos || []).map((p) => ({
      inventario_de: p.inventario_de, inventario_ate: p.inventario_ate, de: fmtTs(p.de), ate: fmtTs(p.ate),
      sem_vendas: !!p.sem_vendas, dias_sem_vendas: Array.isArray(p.dias_sem_vendas) ? p.dias_sem_vendas : [],
      ...totais(p, dinheiro),
    })),
  };
}

/* ---------- CSV (mesmo formato do Relatório de barris: ";" entre colunas, números com vírgula, BOM para o Excel) ---------- */
// Texto: começando com = + - @, leva um apóstrofo para o Excel não ler como fórmula (como no Relatório de barris)
const esc = (v) => {
  let t = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return `"${t.replace(/"/g, '""')}"`;
};
// Número com vírgula e casas fixas; negativo continua número para o Excel (sem o apóstrofo de proteção)
const dec = (v, casas) => (v === null || v === undefined ? '""' : `"${Number(v).toFixed(casas).replace(".", ",")}"`);
// "2026-11-16 22:40:00" -> "16/11/2026 22:40"
const diaHora = (ts) => (ts ? `${ts.slice(8, 10)}/${ts.slice(5, 7)}/${ts.slice(0, 4)} ${ts.slice(11, 16)}` : "");
const slug = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* rel: a resposta de montarRelatorio. As colunas de dinheiro só entram se rel.dinheiro. */
function csv(rel) {
  const d = rel.dinheiro;
  const header = ["Chope", "Saiu dos barris (L)", "Vendido no caixa (L)", "Perda (L)", "% do que saiu",
    ...(d ? ["Custo do litro (R$)", "Perda (R$)"] : []), "Estimado"].map(esc).join(";");
  const linha = (nome, x) => [esc(nome), dec(x.saiu, 2), dec(x.vendido, 2), dec(x.perda, 2), dec(x.pct, 1),
    ...(d ? [dec(x.custo_litro, 2), dec(x.reais, 2)] : []), esc(x.estimado ? "sim" : "")].join(";");
  const lines = rel.chopes.map((c) => linha(c.nome, c));
  lines.push(linha("Total", { ...rel.total, custo_litro: null }));
  lines.push("", [esc("Período"), esc(`De ${diaHora(rel.de)} até ${diaHora(rel.ate)}`)].join(";"),
    [esc("Unidade"), esc(rel.unidade ? rel.unidade.nome : "")].join(";"));
  if (rel.sem_vendas)
    lines.push(esc("Faltam as vendas deste período: a perda não foi calculada. Importe a planilha em Mais > Vendas."));
  else if (rel.dias_sem_vendas.length)
    lines.push(esc(`Faltam as vendas de ${rel.dias_sem_vendas_texto}: a perda aparece maior do que é.`));
  if (d && rel.total.sem_preco && rel.total.sem_preco.length)
    lines.push(esc(`Fora da conta (sem preço): ${rel.total.sem_preco.join(", ")}`));
  if (rel.total.estimado)
    lines.push(esc("Estimado: algum barril aberto do chope foi medido a olho num dos dois inventários, então o número é aproximado."));
  lines.push(esc("Saiu dos barris = no início + chegou + recebido de outra loja - enviado para outra loja - no fim. Perda = saiu - vendido."));
  const dia = (ts) => (ts ? ts.slice(0, 10) : "");
  return {
    filename: `relatorio-perdas-${slug(rel.unidade && rel.unidade.nome) || "unidade"}-${dia(rel.de)}-a-${dia(rel.ate)}.csv`,
    csv: "﻿" + [header, ...lines].join("\r\n"),
  };
}

module.exports = { montarRelatorio, montarPeriodos, csv, textoDias };
