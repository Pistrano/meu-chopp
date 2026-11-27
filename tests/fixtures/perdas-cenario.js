/* ==========================================================
   Cenário inventado do relatório de perdas (tests/perdas.test.js). Só dados inventados (o repositório é público).
   montar(gravar, { centro, porto, usuario }) grava tudo, em ordem, e devolve os ids. gravar(tabela, linha) grava uma
   linha e devolve o id (o teste usa o Supabase local).

   Loja Centro, inventários A (05/10 22:40), B (10/10 22:40), C (15/10 22:40) e D (25/10 22:40), horário de Cuiabá.
   Período A -> B, conta de cabeça:
     Pilsen (custo por tamanho: 50 L = R$ 10/L, 30 L = R$ 12/L, 20 L = R$ 15/L)
       BA5-7001 50 L  aberto, balança: 30 em A, 10 em B ..................................... saiu 20
       BA3-7002 30 L  12 em A (balança), acabou antes de B .................................. saiu 12
       BA5-7003 50 L  chegou cheio em 07/10, 25 em B (balança) .............................. saiu 25
       BA5-7004 50 L  cheio fechado nos dois (100%); transferência para o Porto cancelada ... saiu 0
       BA2-7005 20 L  15 em A; retirado com 8 L em 07/10; enviado ao Porto em 08/10 .......... saiu 7
       BA2-7006 20 L  recebido do Porto em 07/10 com 16 L (pesado lá em 06/10); 6 em B ....... saiu 10
       saiu 74; vendido 60 (5 exatamente em A + 30 + 25; os 4 exatamente em B ficam para B -> C); perda 14
       custo do litro = (20×10 + 12×12 + 25×10 + 7×15 + 10×15) / 74 = 849 / 74 = 11,4730; R$ 160,62
     IPA (R$ 20/L)
       BA3-7101 30 L  50% estimado em A (15), 5 em B (balança) .............................. saiu 10, estimado
       BA3-7102 30 L  chegou exatamente em B e foi para o inventário B como cheio (100%) ..... saiu 0
       vendido 12; perda -2 (-20%); R$ -40,00
     Weiss (sem preço)
       BA2-7201 20 L  18 em A, 8 em B (balança) ............................................. saiu 10
       vendido 8; perda 2 (20%); sem R$
     Total: saiu 94, vendido 80, perda 14 (14,8936%), R$ 120,62; fora da conta: Weiss
   Vendas: importação 1 (01/10 a 12/10), importação 2 cancelada (com 100 L de Pilsen no período: não conta),
   importação 3 (só 14/10).
   B -> C: Pilsen vendido 13 (os 4 exatamente em B + 9); BA3-7102 começa com 30 (do inventário B, não "chegou" de novo)
   e termina com 22 na balança; faltam as vendas de 13/10 e 15/10. C -> D: nenhum dia coberto (sem vendas).
   ========================================================== */
// Horário de Cuiabá (UTC-4) -> instante
const cba = (diaHora) => `${diaHora.replace(" ", "T")}:00-04:00`;
const T = {
  A: cba("2026-10-05 22:40"), B: cba("2026-10-10 22:40"), C: cba("2026-10-15 22:40"), D: cba("2026-10-25 22:40"),
};

async function montar(gravar, { centro, porto, usuario }) {
  const id = {};
  // Chopes e preços
  id.pilsen = await gravar("chopes", { nome: "Pilsen Teste", preco_por_tamanho: true });
  id.ipa = await gravar("chopes", { nome: "IPA Teste", preco_por_tamanho: false });
  id.weiss = await gravar("chopes", { nome: "Weiss Teste", preco_por_tamanho: false });
  for (const [litros, preco] of [[50, 500], [30, 360], [20, 300]])
    await gravar("custos_chope", { chope_id: id.pilsen, tamanho_l: litros, preco_barril: preco, custo_litro: preco / litros, inicio: "2026-01-01" });
  await gravar("custos_chope", { chope_id: id.ipa, tamanho_l: null, preco_barril: null, custo_litro: 20, inicio: "2026-01-01" });

  const taras = {};
  for (const [litros, kg] of [[20, 8], [30, 10.5], [50, 14]]) taras[litros] = await gravar("taras", { tamanho_l: litros, peso_kg: kg, criado_por: usuario });

  // Barris: [chave, código, chope, tamanho, unidade agora, status agora, cadastro]
  const chope = { P: ["pilsen", "Pilsen Teste"], I: ["ipa", "IPA Teste"], W: ["weiss", "Weiss Teste"] };
  const barris = [
    ["p1", "BA5-7001", "P", 50, centro, "em_uso", "2026-10-01 09:00"],
    ["p2", "BA3-7002", "P", 30, centro, "esgotado", "2026-10-01 09:00"],
    ["p3", "BA5-7003", "P", 50, centro, "em_uso", "2026-10-07 10:00"],
    ["p4", "BA5-7004", "P", 50, centro, "disponivel", "2026-10-01 09:00"],
    ["p5", "BA2-7005", "P", 20, centro, "em_transferencia", "2026-10-01 09:00"],
    ["p6", "BA2-7006", "P", 20, centro, "esgotado", "2026-10-02 09:00"],
    ["i1", "BA3-7101", "I", 30, centro, "esgotado", "2026-10-01 09:00"],
    ["i2", "BA3-7102", "I", 30, centro, "disponivel", "2026-10-10 22:40"],
    ["w1", "BA2-7201", "W", 20, centro, "em_uso", "2026-10-01 09:00"],
  ];
  for (const [k, codigo, c, tamanho, unidade, status, cadastro] of barris) {
    id[k] = await gravar("barris", {
      codigo, estilo: chope[c][1], chope_nome: chope[c][1], chope_id: id[chope[c][0]], tamanho_l: tamanho,
      unidade_id: unidade, status, validade: "2026-12-31", criado_em: cba(cadastro),
    });
  }
  // BA2-7006 foi cadastrado no Porto: a entrada dele é de lá
  const entradas = [["p1", centro, "2026-10-01 09:00"], ["p2", centro, "2026-10-01 09:00"], ["p3", centro, "2026-10-07 10:00"],
    ["p4", centro, "2026-10-01 09:00"], ["p5", centro, "2026-10-01 09:00"], ["p6", porto, "2026-10-02 09:00"],
    ["i1", centro, "2026-10-01 09:00"], ["i2", centro, "2026-10-10 22:40"], ["w1", centro, "2026-10-01 09:00"]];
  for (const [k, unidade, em] of entradas)
    await gravar("movimentacoes", { barril_id: id[k], operacao: "entrada", usuario_id: usuario, destino_unidade_id: unidade, criado_em: cba(em) });

  // Transferências: BA2-7006 do Porto para o Centro (confirmada em 07/10 15:00); BA2-7005 do Centro para o Porto
  // (pendente); BA5-7004 do Centro para o Porto (cancelada: não conta)
  await gravar("transferencias", { barril_id: id.p6, origem_id: porto, destino_id: centro, solicitante_id: usuario, recebedor_id: usuario,
    status: "confirmada", criado_em: cba("2026-10-06 08:00"), resolvido_em: cba("2026-10-07 15:00") });
  await gravar("movimentacoes", { barril_id: id.p6, operacao: "transferencia", usuario_id: usuario, origem_unidade_id: porto, destino_unidade_id: centro, criado_em: cba("2026-10-06 08:00") });
  await gravar("movimentacoes", { barril_id: id.p6, operacao: "entrada", usuario_id: usuario, origem_unidade_id: porto, destino_unidade_id: centro, criado_em: cba("2026-10-07 15:00"), observacao: "Recebimento de transferência" });
  await gravar("transferencias", { barril_id: id.p5, origem_id: centro, destino_id: porto, solicitante_id: usuario, status: "pendente", criado_em: cba("2026-10-08 12:00") });
  await gravar("movimentacoes", { barril_id: id.p5, operacao: "transferencia", usuario_id: usuario, origem_unidade_id: centro, destino_unidade_id: porto, criado_em: cba("2026-10-08 12:00") });
  await gravar("transferencias", { barril_id: id.p4, origem_id: centro, destino_id: porto, solicitante_id: usuario, status: "cancelada", criado_em: cba("2026-10-08 13:00"), resolvido_em: cba("2026-10-08 14:00") });

  // Inventários (o E fica aberto)
  const inv = async (unidade, fim) => gravar("inventarios", { unidade_id: unidade, iniciado_em: cba(fim.replace("22:40", "22:00")), concluido_em: fim ? cba(fim) : null, usuario_id: usuario });
  id.A = await inv(centro, "2026-10-05 22:40");
  id.B = await inv(centro, "2026-10-10 22:40");
  id.C = await inv(centro, "2026-10-15 22:40");
  id.D = await inv(centro, "2026-10-25 22:40");
  id.E = await gravar("inventarios", { unidade_id: centro, iniciado_em: cba("2026-10-30 22:00"), concluido_em: null, usuario_id: usuario });
  id.porto = await inv(porto, "2026-10-08 22:40");

  // Pesagens: [barril, litros, método, inventário (ou motivo), quando, unidade]
  const balanca = (k, litros, tamanho) => ({ metodo: "balanca", peso_bruto_kg: Math.round((litros * 1.01 + { 20: 8, 30: 10.5, 50: 14 }[tamanho]) * 100) / 100,
    tara_id: taras[tamanho], tara_kg: { 20: 8, 30: 10.5, 50: 14 }[tamanho], densidade: 1.01, litros });
  const estimativa = (litros, nivel) => ({ metodo: "estimativa", nivel_pct: nivel, litros });
  const pesar = (k, unidade, quando, motivo, inventario, medida) => gravar("pesagens", {
    barril_id: id[k], unidade_id: unidade, criado_em: cba(quando), usuario_id: usuario, motivo, inventario_id: inventario, ...medida });
  // Inventário A
  await pesar("p1", centro, "2026-10-05 22:30", "inventario", id.A, balanca("p1", 30, 50));
  await pesar("p2", centro, "2026-10-05 22:30", "inventario", id.A, balanca("p2", 12, 30));
  await pesar("p4", centro, "2026-10-05 22:40", "inventario", id.A, estimativa(50, 100));
  await pesar("p5", centro, "2026-10-05 22:30", "inventario", id.A, balanca("p5", 15, 20));
  await pesar("i1", centro, "2026-10-05 22:30", "inventario", id.A, estimativa(15, 50));
  await pesar("w1", centro, "2026-10-05 22:30", "inventario", id.A, balanca("w1", 18, 20));
  // No período: BA2-7006 pesado no Porto; BA2-7005 retirado com chope antes de ir para o Porto
  await pesar("p6", porto, "2026-10-06 10:00", "avulsa", null, balanca("p6", 16, 20));
  await pesar("p5", centro, "2026-10-07 20:00", "retirada", null, balanca("p5", 8, 20));
  // Inventário B (BA3-7102 chegou na hora e entra como cheio)
  await pesar("p1", centro, "2026-10-10 22:30", "inventario", id.B, balanca("p1", 10, 50));
  await pesar("p3", centro, "2026-10-10 22:30", "inventario", id.B, balanca("p3", 25, 50));
  await pesar("p4", centro, "2026-10-10 22:40", "inventario", id.B, estimativa(50, 100));
  await pesar("p6", centro, "2026-10-10 22:30", "inventario", id.B, balanca("p6", 6, 20));
  await pesar("i1", centro, "2026-10-10 22:30", "inventario", id.B, balanca("i1", 5, 30));
  await pesar("i2", centro, "2026-10-10 22:40", "inventario", id.B, estimativa(30, 100));
  await pesar("w1", centro, "2026-10-10 22:30", "inventario", id.B, balanca("w1", 8, 20));
  // Inventário C e D
  await pesar("p1", centro, "2026-10-15 22:30", "inventario", id.C, balanca("p1", 2, 50));
  await pesar("p3", centro, "2026-10-15 22:30", "inventario", id.C, balanca("p3", 10, 50));
  await pesar("p4", centro, "2026-10-15 22:40", "inventario", id.C, estimativa(50, 100));
  await pesar("i2", centro, "2026-10-15 22:30", "inventario", id.C, balanca("i2", 22, 30));
  await pesar("w1", centro, "2026-10-15 22:30", "inventario", id.C, balanca("w1", 3, 20));
  await pesar("p4", centro, "2026-10-25 22:40", "inventario", id.D, estimativa(50, 100));

  // Vendas
  const produto = {};
  for (const k of ["pilsen", "ipa", "weiss"]) produto[k] = await gravar("produtos_teknisa", { nome: `CHOPP ${k.toUpperCase()} TESTE 300 ML`, chope_id: id[k], volume_l: 0.3 });
  const imp = async (de, ate, cancelada = false) => gravar("importacoes_vendas", { unidade_id: centro, periodo_de: de, periodo_ate: ate, usuario_id: usuario, cancelada });
  id.imp1 = await imp("2026-10-01", "2026-10-12");
  id.imp2 = await imp("2026-10-01", "2026-10-12", true);
  id.imp3 = await imp("2026-10-14", "2026-10-14");
  let nr = 0;
  const vender = (k, litros, quando, importacao = id.imp1) => gravar("vendas_itens", {
    unidade_id: centro, importacao_id: importacao, caixa: "Caixa Teste", nr_venda: String(++nr), linha: 1,
    vendido_em: quando, produto_id: produto[k], chope_id: id[k], quantidade: litros / 0.3, volume_l: 0.3, litros });
  await vender("pilsen", 7, cba("2026-10-05 12:00"));   // antes de A
  await vender("pilsen", 5, T.A);                        // exatamente em A: entra
  await vender("pilsen", 30, cba("2026-10-07 19:00"));
  await vender("pilsen", 25, cba("2026-10-09 20:00"));
  await vender("pilsen", 4, T.B);                        // exatamente em B: fica para B -> C
  await vender("pilsen", 9, cba("2026-10-12 18:00"));
  await vender("pilsen", 100, cba("2026-10-08 18:00"), id.imp2); // importação cancelada
  await vender("ipa", 12, cba("2026-10-08 18:00"));
  await vender("weiss", 8, cba("2026-10-09 18:00"));
  return id;
}

module.exports = { montar, T };
