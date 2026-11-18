/* ==========================================================
   Arquivos inventados do relatório "Vendas Realizadas no Período" da Teknisa, para os testes das vendas.
   Só dados inventados (o repositório é público): loja, caixas, números, produtos e valores de exemplo.

   planilha(vendas, opções) monta o XLSX (Buffer) no formato da Teknisa: título, cabeçalho, uma linha por item
   e a linha de totais no fim (sem Unidade e sem Produto). Os arquivos .xlsx desta pasta saem daqui:
     node tests/fixtures/vendas-teknisa.js
   (regrava vendas-teknisa-10a11.xlsx, vendas-teknisa-11a12.xlsx e outro-relatorio.xlsx)
   ========================================================== */
const path = require("node:path");
const ExcelJS = require("exceljs");

const CABECALHO = ["Unidade", "Venda", "Código", "Produto", "Qtde.", "Un.", "Pr. Unit.", "Desc.", "Acrés.", "Vr. Bruto", "Vr. Total", "Ab. Comanda"];
const LOJA = "0009 - LOJA EXEMPLO";
const TERMINAL = "Terminal de Autoatendimento";
const BALCAO = "Caixa Balcao";

const CODIGOS = {
  "CHOPP PILSEN 300 ML UN": 9000002000, "AGUA MINERAL 500ML UN": 9000003001, "CHOPP GERMAN 300 ML UN": 9000002010,
  "CHOPP HOPLAGER 500ML UN": 9000002020, "CERVEJA LATA 350ML UN": 9000003010, "GROWLER PET 1 L UN": 9000003020,
  "CHOPP PILSEN REFIL GROWLER 1L UN": 9000002030, "CHOPP APA 300 ML UN": 9000002040, "CHOPP GOSE LIMAO 300 ML UN": 9000002050,
  "PORCAO BATATA FRITA": 9000004000, "CHOPP HOP LAGER 300 ML UN": 9000002060,
};

/* Uma venda: { unidade?, caixa, nr, dt ("dd/mm/aaaa hh:mm:ss" da coluna Venda), modalidade, comanda (texto ou ""),
   itens: [[produto, quantidade, preço unitário]] } */
const vendaTexto = (v, total) =>
  `Caixa : ${v.caixa} | Nr. Ven.: ${v.nr} | Dt. Ven.: ${v.dt} | Cup./N. Fiscal: 000000${v.nr.slice(-3)} | Cli./Cons.: PADRAO | ` +
  `Vend.: OPERADOR EXEMPLO | Valor Repique: 0 | Modalidade: ${v.modalidade} | CARTAO - TEF: R$${total.toFixed(2).replace(".", ",")}`;

async function planilha(vendas, { cabecalho = CABECALHO, titulo = "Vendas Realizadas no Período", codigos = {} } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Relatório");
  ws.addRow([titulo]);
  ws.addRow(["Empresa: EMPRESA EXEMPLO LTDA"]);
  ws.addRow([]);
  ws.addRow(cabecalho);
  // Os valores vão pelo nome da coluna: com o cabeçalho em outra ordem, cada valor acompanha a sua coluna
  const linha = (campos) => cabecalho.map((c) => (c in campos ? campos[c] : ""));
  let qtd = 0;
  let soma = 0;
  for (const v of vendas) {
    const total = v.itens.reduce((s, [, q, pu]) => s + q * pu, 0);
    for (const [produto, q, pu] of v.itens) {
      const vr = Math.round(q * pu * 100) / 100;
      qtd += q;
      soma += vr;
      ws.addRow(linha({
        Unidade: v.unidade || LOJA, Venda: vendaTexto(v, total), "Código": codigos[produto] || CODIGOS[produto] || 9000009999,
        Produto: produto, "Qtde.": q, "Un.": "UN", "Pr. Unit.": pu, "Desc.": 0, "Acrés.": 0, "Vr. Bruto": vr, "Vr. Total": vr,
        "Ab. Comanda": v.comanda || "",
      }));
    }
  }
  const somaTotal = Math.round(soma * 100) / 100;
  ws.addRow(linha({ "Qtde.": qtd, "Desc.": 0, "Acrés.": 0, "Vr. Bruto": somaTotal, "Vr. Total": somaTotal }));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* Arquivo de 10 e 11/11/2026 (Cuiabá). Com o catálogo dos testes (Pilsen, German Pilsener, Hop Lager, Goose Limão, IPA,
   APA Session) e APA escolhido como "APA Session": 7 itens de chope, 5,82 L e R$ 226,68; 4 itens ignorados. */
const VENDAS_10A11 = [
  { caixa: "001", nr: "0000000101", dt: "10/11/2026 19:05:10", modalidade: BALCAO, comanda: "10/11/2026 19:05:02",
    itens: [["CHOPP PILSEN 300 ML UN", 2, 12.99], ["AGUA MINERAL 500ML UN", 1, 5]] },
  // Terminal: a Dt. Ven. está no horário de Brasília; vale a abertura da comanda
  { caixa: "002", nr: "0000000123", dt: "11/11/2026 22:18:32", modalidade: TERMINAL, comanda: "11/11/2026 21:17:00",
    itens: [["CHOPP PILSEN 300 ML UN", 4, 12.99]] },
  // Terminal sem comanda: Dt. Ven. lida como Brasília (20:30 = 19:30 em Cuiabá)
  { caixa: "003", nr: "0000000045", dt: "11/11/2026 20:30:00", modalidade: TERMINAL, comanda: "",
    itens: [["CHOPP GERMAN 300 ML UN", 1, 14.99]] },
  // Balcão sem comanda: Dt. Ven. no horário da loja
  { caixa: "001", nr: "0000000102", dt: "10/11/2026 23:10:00", modalidade: BALCAO, comanda: "",
    itens: [["CHOPP HOPLAGER 500ML UN", 1, 19.9], ["CERVEJA LATA 350ML UN", 2, 8], ["GROWLER PET 1 L UN", 1, 15],
      ["CHOPP PILSEN REFIL GROWLER 1L UN", 1, 39.9]] },
  { caixa: "001", nr: "0000000103", dt: "11/11/2026 18:00:05", modalidade: BALCAO, comanda: "11/11/2026 17:40:00",
    itens: [["CHOPP APA 300 ML UN", 3, 13.99], ["CHOPP GOSE LIMAO 300 ML UN", 2, 15.99], ["PORCAO BATATA FRITA", 1, 32]] },
];

/* Arquivo de 11 e 12/11/2026: as vendas do dia 11 iguais às do arquivo anterior (4 itens de chope repetidos) e duas
   vendas novas no dia 12 (2 itens: 0,72 L de Pilsen e 0,36 L de Hop Lager, com um nome de produto novo). */
const VENDAS_11A12 = [
  VENDAS_10A11[1], VENDAS_10A11[2], VENDAS_10A11[4],
  { caixa: "002", nr: "0000000130", dt: "12/11/2026 21:00:00", modalidade: TERMINAL, comanda: "12/11/2026 19:58:00",
    itens: [["CHOPP PILSEN 300 ML UN", 2, 12.99]] },
  { caixa: "001", nr: "0000000110", dt: "12/11/2026 20:15:00", modalidade: BALCAO, comanda: "12/11/2026 20:14:30",
    itens: [["CHOPP HOP LAGER 300 ML UN", 1, 14.99]] },
];

const arquivo10a11 = () => planilha(VENDAS_10A11);
// O código do Pilsen muda neste relatório: o de-para vai pelo nome
const arquivo11a12 = () => planilha(VENDAS_11A12, { codigos: { "CHOPP PILSEN 300 ML UN": 9000002999 } });
async function outroRelatorio() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Produtos");
  ws.addRow(["Produtos Vendidos"]);
  ws.addRow(["Código", "Produto", "Qtde", "Valor"]);
  ws.addRow([9000002000, "CHOPP PILSEN 300 ML UN", 6, 77.94]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { CABECALHO, LOJA, TERMINAL, BALCAO, VENDAS_10A11, VENDAS_11A12, planilha, arquivo10a11, arquivo11a12, outroRelatorio };

if (require.main === module) {
  const fs = require("node:fs");
  (async () => {
    const arquivos = [["vendas-teknisa-10a11.xlsx", arquivo10a11], ["vendas-teknisa-11a12.xlsx", arquivo11a12], ["outro-relatorio.xlsx", outroRelatorio]];
    for (const [nome, gerar] of arquivos) {
      fs.writeFileSync(path.join(__dirname, nome), await gerar());
      console.log("gravado:", nome);
    }
  })();
}
