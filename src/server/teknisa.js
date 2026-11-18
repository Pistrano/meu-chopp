/* ==========================================================
   BarrilFacil — leitura do relatório "Vendas Realizadas no Período" da Teknisa (XLSX)
   Cada linha do arquivo é um item de uma venda. As colunas são achadas pelo nome (a posição pode mudar):
     Unidade | Venda | Código | Produto | Qtde. | Un. | Pr. Unit. | Desc. | Acrés. | Vr. Bruto | Vr. Total | Ab. Comanda
   "Venda" é um texto com campos separados por " | "; daqui só saem Caixa, Nr. Ven., Dt. Ven. e Modalidade
   (forma de pagamento, cliente e vendedor não são guardados).

   Horário da venda: a abertura da comanda (Ab. Comanda) quando existe; senão, a data da venda (Dt. Ven.).
   As datas estão no horário da loja (APP_TZ), menos a Dt. Ven. dos terminais de autoatendimento, que a Teknisa
   grava no horário de Brasília (1 h à frente de Cuiabá): essa é lida como America/Sao_Paulo.

   Também ficam aqui as sugestões de volume e de chope pelo nome do produto (a tela mostra e a pessoa confere).
   Biblioteca do XLSX: exceljs (versão fixa no package.json).
   ========================================================== */
const ExcelJS = require("exceljs");

const MAX_ARQUIVO = 10 * 1024 * 1024; // 10 MB
const MSG_RELATORIO = "Este relatório não é aceito. Na Teknisa, exporte 'Vendas Realizadas no Período' em XLSX.";
const FUSO_BRASILIA = "America/Sao_Paulo";
const TERMINAL = "TERMINAL DE AUTOATENDIMENTO";
const LINHAS_PROCURA_CABECALHO = 40; // o cabeçalho pode vir depois do título do relatório

/* Erro com mensagem pronta para a tela (o servidor transforma em AppError) */
class ErroTeknisa extends Error {}

/* ---------- Textos ---------- */
const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
// Nome do produto como chave do de-para: maiúsculas, sem acento e sem espaços repetidos
const normalizar = (s) => semAcento(s).toUpperCase().replace(/\s+/g, " ").trim();
// Para comparar nomes: só letras e números ("Hop Lager" = "HOPLAGER")
const compacto = (s) => normalizar(s).replace(/[^A-Z0-9]/g, "");

/* ---------- Colunas ---------- */
const COLUNAS = {
  unidade: "Unidade", venda: "Venda", codigo: "Código", produto: "Produto", qtde: "Qtde.", un: "Un.",
  prUnit: "Pr. Unit.", desc: "Desc.", acres: "Acrés.", vrBruto: "Vr. Bruto", vrTotal: "Vr. Total", comanda: "Ab. Comanda",
};
const COLUNAS_CHAVE = Object.fromEntries(Object.entries(COLUNAS).map(([k, v]) => [compacto(v), k]));

/* ---------- Células ---------- */
// Valor "cru" da célula do exceljs: número, texto, Date ou null (texto rico, fórmula e link viram o valor)
function valorCelula(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v !== "object") return v;
  if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
  if ("result" in v) return valorCelula(v.result);
  if ("text" in v) return valorCelula(v.text);
  return null;
}
const pad = (n, t = 2) => String(n).padStart(t, "0");
function texto(v) {
  const x = valorCelula(v);
  if (x === null || x === undefined) return "";
  if (x instanceof Date) return dataHoraTexto(relogioDaData(x));
  return String(x).trim();
}
// "51,96", "1.234,56", "51.96" ou número. Vazio: null. Inválido: NaN.
function numero(v) {
  const x = valorCelula(v);
  if (typeof x === "number") return x;
  let t = String(x ?? "").replace(/R\$|\s/g, "");
  if (t === "") return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

/* ---------- Datas ----------
   "Relógio" = data e hora como aparecem no arquivo, sem fuso: { a, m, d, h, mi, s }. */
const relogioDaData = (dt) => ({ // célula com formato de data: o exceljs entrega a hora do arquivo nos campos UTC
  a: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), h: dt.getUTCHours(), mi: dt.getUTCMinutes(), s: dt.getUTCSeconds(),
});
const dataHoraTexto = (r) => `${pad(r.d)}/${pad(r.m)}/${r.a} ${pad(r.h)}:${pad(r.mi)}:${pad(r.s)}`;
// "dd/mm/aaaa hh:mm:ss" (segundos opcionais) ou célula de data. Vazio: null. Inválido: undefined.
function lerRelogio(v) {
  const x = valorCelula(v);
  if (x === null || x === undefined || x === "") return null;
  if (x instanceof Date) return Number.isNaN(x.getTime()) ? undefined : relogioDaData(x);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(x).trim());
  if (!m) return String(x).trim() === "" ? null : undefined;
  const r = { a: +m[3], m: +m[2], d: +m[1], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
  const t = new Date(Date.UTC(r.a, r.m - 1, r.d, r.h, r.mi, r.s));
  if (t.getUTCMonth() !== r.m - 1 || t.getUTCDate() !== r.d || r.h > 23 || r.mi > 59 || r.s > 59) return undefined;
  return r;
}

const formatos = new Map();
function formatoDoFuso(fuso) {
  if (!formatos.has(fuso)) {
    formatos.set(fuso, new Intl.DateTimeFormat("en-US", {
      timeZone: fuso, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }));
  }
  return formatos.get(fuso);
}
// Quanto o fuso está à frente do UTC no instante t (em ms; Cuiabá = -4 h)
function deslocamento(fuso, t) {
  const p = Object.fromEntries(formatoDoFuso(fuso).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}
// Relógio lido no fuso -> instante (Date)
function instante(r, fuso) {
  const comoUTC = Date.UTC(r.a, r.m - 1, r.d, r.h, r.mi, r.s);
  let t = comoUTC - deslocamento(fuso, comoUTC);
  const d2 = deslocamento(fuso, t);
  if (comoUTC - d2 !== t) t = comoUTC - d2; // perto de uma troca de horário de verão
  return new Date(t);
}
const diaFormatos = new Map();
// "AAAA-MM-DD" do instante no fuso
function diaNoFuso(dt, fuso) {
  if (!diaFormatos.has(fuso)) diaFormatos.set(fuso, new Intl.DateTimeFormat("sv-SE", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit" }));
  return diaFormatos.get(fuso).format(dt);
}

/* ---------- Campo "Venda" ----------
   "Caixa : 002 | Nr. Ven.: 0000000123 | Dt. Ven.: 11/11/2026 22:18:32 | ... | Modalidade: Terminal de Autoatendimento | ..." */
function lerVenda(txt) {
  const campos = {};
  for (const parte of String(txt || "").split("|")) {
    const i = parte.indexOf(":");
    if (i < 0) continue;
    const chave = compacto(parte.slice(0, i));
    if (chave && !(chave in campos)) campos[chave] = parte.slice(i + 1).trim();
  }
  return { caixa: campos.CAIXA || "", nr: campos.NRVEN || "", dtVenda: campos.DTVEN || "", modalidade: campos.MODALIDADE || "" };
}

/* "0003 - LOJA EXEMPLO" -> { codigo: "0003", nome: "LOJA EXEMPLO" } */
function lerUnidade(txt) {
  const t = String(txt || "").trim();
  const i = t.indexOf(" - ");
  const codigo = (i > 0 ? t.slice(0, i) : t).trim().toUpperCase();
  return { codigo, nome: i > 0 ? t.slice(i + 3).trim() : t };
}

/* ---------- Arquivo ---------- */
function acharCabecalho(ws) {
  const ultima = Math.min(ws.rowCount, LINHAS_PROCURA_CABECALHO);
  for (let r = 1; r <= ultima; r++) {
    const col = {};
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, c) => {
      const k = COLUNAS_CHAVE[compacto(texto(cell.value))];
      if (k && !(k in col)) col[k] = c;
    });
    if (Object.keys(COLUNAS).every((k) => k in col)) return { linha: r, col };
  }
  return null;
}

/* Lê o arquivo (Buffer) e devolve os itens:
   { unidade, unidadeNome, caixa, nr, linha, produto (nome normalizado), produtoOriginal, codigoProduto, quantidade, valor,
     vendidoEm, dtVenda, comanda (Date ou null), modalidade, dia ("AAAA-MM-DD" no fuso da loja) }
   linha = posição do item dentro da venda (unidade + caixa + número), na ordem do arquivo. */
async function lerArquivo(buf, { tz }) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new ErroTeknisa(MSG_RELATORIO); // XLSX é um ZIP ("PK")
  if (buf.length > MAX_ARQUIVO) throw new ErroTeknisa("O arquivo passa de 10 MB.");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch (_) {
    throw new ErroTeknisa(MSG_RELATORIO);
  }
  for (const ws of wb.worksheets) {
    const cab = acharCabecalho(ws);
    if (cab) return lerLinhas(ws, cab, tz);
  }
  throw new ErroTeknisa(MSG_RELATORIO);
}

function lerLinhas(ws, { linha: linhaCab, col }, tz) {
  const itens = [];
  const posicao = new Map(); // venda -> último número de item
  const erro = (n, msg) => { throw new ErroTeknisa(`Linha ${n} do arquivo: ${msg}`); };
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n <= linhaCab) return;
    const cel = (k) => row.getCell(col[k]).value;
    const unidadeTxt = texto(cel("unidade"));
    const produtoTxt = texto(cel("produto"));
    if (!unidadeTxt || !produtoTxt) return; // totais e linhas em branco
    const venda = lerVenda(texto(cel("venda")));
    if (!venda.caixa || !venda.nr) erro(n, "não foi possível ler o caixa e o número da venda.");
    const quantidade = numero(cel("qtde"));
    if (quantidade === null || Number.isNaN(quantidade)) erro(n, "a quantidade não é um número.");
    const valor = numero(cel("vrTotal"));
    if (Number.isNaN(valor)) erro(n, "o valor total não é um número.");
    const comanda = lerRelogio(cel("comanda"));
    if (comanda === undefined) erro(n, "a data de abertura da comanda não está no formato dd/mm/aaaa hh:mm:ss.");
    const dtVenda = lerRelogio(venda.dtVenda);
    if (dtVenda === undefined) erro(n, "a data da venda não está no formato dd/mm/aaaa hh:mm:ss.");
    if (!comanda && !dtVenda) erro(n, "sem a data da venda e sem a abertura da comanda.");
    const terminal = normalizar(venda.modalidade) === TERMINAL;
    const comandaEm = comanda ? instante(comanda, tz) : null;
    const dtVendaEm = dtVenda ? instante(dtVenda, terminal ? FUSO_BRASILIA : tz) : null;
    const vendidoEm = comandaEm || dtVendaEm;
    const unidade = lerUnidade(unidadeTxt);
    if (!/^[0-9A-Z]{1,10}$/.test(unidade.codigo)) erro(n, `o código da unidade ("${unidadeTxt}") não foi reconhecido.`);
    const chave = `${unidade.codigo}|${venda.caixa}|${venda.nr}`;
    const linha = (posicao.get(chave) || 0) + 1;
    posicao.set(chave, linha);
    itens.push({
      unidade: unidade.codigo, unidadeNome: unidade.nome, caixa: venda.caixa, nr: venda.nr, linha,
      produto: normalizar(produtoTxt), produtoOriginal: produtoTxt, codigoProduto: texto(cel("codigo")) || null,
      quantidade, valor: valor || 0,
      vendidoEm, dtVenda: dtVendaEm, comanda: comandaEm, modalidade: venda.modalidade || null,
      dia: diaNoFuso(vendidoEm, tz),
    });
  });
  if (!itens.length) throw new ErroTeknisa("O arquivo não tem nenhuma venda.");
  return itens;
}

/* ---------- Sugestões pelo nome do produto (nome já normalizado) ---------- */
const ehChope = (nome) => /^CHOPP( |$)/.test(nome);
const decimal = (t) => Number(String(t).replace(",", "."));

/* Litros de chope por unidade vendida:
   chope com "300 ML" ou "355 ML" = 0,36 (a caneca servida é de 360 ml); "1L"/"1 L" = 1 (refil de growler);
   outro volume vem do número no nome ("500ML" = 0,5; "1,5 L" = 1,5). Sem volume no nome: null. */
function sugestaoVolume(nome) {
  if (ehChope(nome) && /(^|[^0-9])(300|355) ?ML\b/.test(nome)) return 0.36;
  if (/(^|[^0-9.,])1 ?(L|LT|LITRO)\b/.test(nome)) return 1;
  const ml = /(\d+(?:[.,]\d+)?) ?ML\b/.exec(nome);
  if (ml) return Math.round(decimal(ml[1])) / 1000;
  const l = /(\d+(?:[.,]\d+)?) ?(L|LT|LITROS?)\b/.exec(nome);
  if (l) return decimal(l[1]);
  return null;
}

/* Nome do chope dentro do produto: o texto entre "CHOPP" e o volume ("CHOPP GOSE LIMAO 300 ML UN" -> "GOSE LIMAO") */
function nomeDoChope(nome) {
  let resto = nome.replace(/^CHOPP\s*/, "");
  const vol = /\s*\d+(?:[.,]\d+)? ?(ML|L|LT|LITROS?)\b/.exec(resto);
  if (vol) resto = resto.slice(0, vol.index);
  else resto = resto.replace(/\s+UN$/, "");
  return resto.trim();
}

/* Distância de edição (quantas letras trocar, pôr ou tirar), parando em max + 1 */
function distancia(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let ant = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let menor = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < menor) menor = cur[j];
    }
    if (menor > max) return max + 1;
    ant = cur;
  }
  return ant[b.length];
}

/* Chope do catálogo para o nome do chope no produto (chopes: [{ id, nome }]):
   - nome igual (sem diferenciar maiúsculas, acentos e espaços): esse chope;
   - senão, parecidos (um começa com o outro, ou diferença de até 2 letras): se for um só, ele com o aviso;
     se forem vários, nenhum (a tela lista os parecidos primeiro).
   Devolve { chopeId, aviso, parecidos: [ids] }. */
function sugerirChope(nomeChope, chopes) {
  const alvo = compacto(nomeChope);
  if (!alvo) return { chopeId: null, aviso: null, parecidos: [] };
  const iguais = chopes.filter((c) => compacto(c.nome) === alvo);
  if (iguais.length === 1) return { chopeId: iguais[0].id, aviso: null, parecidos: [] };
  const parecidos = iguais.length ? iguais : chopes.filter((c) => {
    const k = compacto(c.nome);
    return k && (k.startsWith(alvo) || alvo.startsWith(k) || distancia(k, alvo) <= 2);
  });
  if (parecidos.length === 1) return { chopeId: parecidos[0].id, aviso: "Nome parecido, confira", parecidos: [parecidos[0].id] };
  return { chopeId: null, aviso: null, parecidos: parecidos.map((c) => c.id) };
}

/* Sugestão completa para um produto novo: chope (ou ignorar) e volume */
function sugestaoProduto(nome, chopes) {
  const volume = sugestaoVolume(nome);
  if (!ehChope(nome)) return { ignorar: true, chopeId: null, volume, aviso: null, parecidos: [] };
  return { ignorar: false, volume, ...sugerirChope(nomeDoChope(nome), chopes) };
}

module.exports = {
  MAX_ARQUIVO, MSG_RELATORIO, FUSO_BRASILIA, ErroTeknisa,
  normalizar, compacto, lerVenda, lerUnidade, lerRelogio, instante, diaNoFuso, lerArquivo,
  ehChope, sugestaoVolume, nomeDoChope, distancia, sugerirChope, sugestaoProduto,
};
