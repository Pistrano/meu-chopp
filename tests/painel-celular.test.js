/* ==========================================================
   BarrilFacil — testes: alertas do sino e do "Precisa de atenção" do Painel do celular (src/server/alertas.js)
   Rodam sem banco: montarAlertas recebe o resultado das consultas e devolve a lista do alerts:list.
   ========================================================== */
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { montarAlertas } = require("../src/server/alertas");

const HOJE = "2026-11-26";
const CENTRO = 1, PORTO = 2;

// Uma unidade com um pouco de tudo: vencido, vence hoje e amanhã, transferências, vazio e estoque baixo
const entrada = () => ({
  unit: CENTRO,
  hoje: HOJE,
  validade: [
    { codigo: "BA5-9001", chope: "Hoplager", validade: "2026-11-24" },
    { codigo: "BA5-9002", chope: "Pilsen", validade: HOJE },
    { codigo: "BA2-9003", chope: null, validade: "2026-11-27" },
  ],
  pendentes: [
    { origem_id: PORTO, destino_id: CENTRO, barris: { codigo: "BA5-9010" }, origem: { nome: "Bar do Porto" }, destino: { nome: "Bar do Centro" } },
    { origem_id: CENTRO, destino_id: PORTO, barris: { codigo: "BA5-9011" }, origem: { nome: "Bar do Centro" }, destino: { nome: "Bar do Porto" } },
  ],
  vazios: [{ codigo: "BA5-9020", dias: 5 }],
  estoque: [
    // IPA: nenhum disponível; Neipa: 2; Pilsen: 3 (não avisa)
    { chope_id: 1, chope_nome: "IPA", status: "em_uso" },
    { chope_id: 2, chope_nome: "Neipa", status: "disponivel" },
    { chope_id: 2, chope_nome: "Neipa", status: "disponivel" },
    { chope_id: 2, chope_nome: "Neipa", status: "esgotado" },
    { chope_id: 3, chope_nome: "Pilsen", status: "disponivel" },
    { chope_id: 3, chope_nome: "Pilsen", status: "disponivel" },
    { chope_id: 3, chope_nome: "Pilsen", status: "disponivel" },
  ],
});

describe("alertas do sino e do Painel do celular", () => {
  test("ordem do sino: validade, transferências, vazios e estoque baixo", () => {
    const a = montarAlertas(entrada());
    assert.deepEqual(a.map((x) => x.tipo), [
      "vencido", "vence_hoje", "vence_amanha", "transferencia_chegando", "transferencia_enviada", "vazio", "sem_estoque", "acabando",
    ]);
  });

  test("o texto do sino não mudou", () => {
    const a = montarAlertas(entrada());
    assert.deepEqual(a.map((x) => x.texto), [
      "Barril #BA5-9001 (Hoplager) venceu em 24/11. Confira se estava na câmara fria.",
      "Barril #BA5-9002 (Pilsen) vence hoje.",
      "Barril #BA2-9003 vence amanhã (27/11).",
      "Barril #BA5-9010 vindo de Bar do Porto aguardando seu recebimento.",
      "Barril #BA5-9011 aguardando confirmação de Bar do Porto.",
      "Barril #BA5-9020 vazio aguardando recolhimento há 5 dias",
      "Estoque baixo: nenhum barril disponível de IPA nesta unidade.",
      "Estoque baixo: restam 2 barris disponíveis de Neipa nesta unidade.",
    ]);
    assert.deepEqual(a.map((x) => x.nivel), ["erro", undefined, undefined, undefined, undefined, undefined, "erro", "aviso"]);
  });

  test("versão curta: título, detalhe e etiqueta", () => {
    const curto = montarAlertas(entrada()).map(({ titulo, detalhe, etiqueta }) => [titulo, detalhe, etiqueta]);
    assert.deepEqual(curto, [
      ["#BA5-9001", "Hoplager", "Vencido"],
      ["#BA5-9002", "Pilsen", "Vence hoje"],
      ["#BA2-9003", null, "Vence amanhã"],
      ["#BA5-9010", "de Bar do Porto", "Chegando"],
      ["#BA5-9011", "para Bar do Porto", "Enviado"],
      ["#BA5-9020", null, "Vazio há 5 dias"],
      ["IPA", null, "Sem estoque"],
      ["Neipa", null, "Acabando · 2"],
    ]);
  });

  test("sem nada para avisar: lista vazia", () => {
    assert.deepEqual(montarAlertas({ unit: CENTRO, hoje: HOJE }), []);
    assert.deepEqual(montarAlertas({ unit: CENTRO, hoje: HOJE, estoque: [
      { chope_id: 3, chope_nome: "Pilsen", status: "disponivel" },
      { chope_id: 3, chope_nome: "Pilsen", status: "disponivel" },
      { chope_id: 3, chope_nome: "Pilsen", status: "disponivel" },
    ] }), []);
  });

  test("barril antigo sem chope cadastrado: agrupa pelo estilo gravado nele", () => {
    const a = montarAlertas({ unit: CENTRO, hoje: HOJE, estoque: [{ chope_id: null, chope_nome: null, estilo: "Weiss", status: "em_uso" }] });
    assert.deepEqual(a.map((x) => [x.tipo, x.titulo]), [["sem_estoque", "Weiss"]]);
  });

  test("nenhum valor em dinheiro nos alertas", () => {
    const json = JSON.stringify(montarAlertas(entrada()));
    assert.doesNotMatch(json, /R\$|preco|custo|valor/i);
  });
});
