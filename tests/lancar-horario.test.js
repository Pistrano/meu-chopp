/* ==========================================================
   BarrilFacil — testes: "Lançar com horário" na aba Torneiras (taps:lancarComHorario)
   Troca de barril, só retirada (vazia ou com chope) e só engate gravados com o horário informado; as regras
   (futuro, 30 dias, depois do engate, do inventário e da última retirada da torneira) e quem pode lançar.
   Rodar:  npm test   (precisa do Supabase local; veja "Rodar os testes" no README)
   ========================================================== */
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SEM_BANCO, banco, limparBanco, startServer, setupAdmin, makeUser } = require("./helpers");

const SEM_PERMISSAO = /Você não tem permissão para esta ação/;
const somaDias = (dia, n) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// Relógio de Cuiabá (o fuso padrão do servidor, UTC-4 o ano todo)
const CBA = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Cuiaba", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const localDe = (ms) => CBA.format(new Date(ms)).replace(" ", "T"); // instante -> "AAAA-MM-DDTHH:MM" em Cuiabá
const ddmm = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;

describe("lançar com horário", { skip: SEM_BANCO }, () => {
  let srv, admin, gerente, quiosque, chope, validade, hoje, ontem, anteontem;
  const u = {};
  const f = {};
  const b = {};
  const tap = {};

  const consulta = async (q) => {
    const { data, error } = await q;
    assert.ifError(error);
    return data;
  };
  const muda = async (q) => { const { error } = await q; assert.ifError(error); };
  // Instante para gravar direto no banco: dia relativo a hoje e hora de Cuiabá
  const instante = (dias, hm) => `${somaDias(hoje, dias)}T${hm}:00-04:00`;
  // O que a tela manda: "AAAA-MM-DDTHH:MM" no fuso da operação
  const quando = (dias, hm) => `${somaDias(hoje, dias)}T${hm}`;
  const barrilDb = async (id) => (await consulta(banco().from("barris").select("*").eq("id", id)))[0];
  const engatesDe = async (id) => consulta(banco().from("engates").select("*").eq("barril_id", id).order("id"));
  const movsDe = async (id) => consulta(banco().from("movimentacoes").select("*").eq("barril_id", id).order("id"));
  const lancar = (c, dados) => c("taps:lancarComHorario", { unitId: u.centro, ...dados });

  before(async () => {
    await limparBanco();
    srv = await startServer();
    admin = await setupAdmin(srv.base);
    u.centro = (await admin.ok("units:create", { razaoSocial: "Bar do Centro Bebidas Ltda", nome: "Bar do Centro", nomeCurto: "Centro", cnpj: "11.222.333/0001-81", endereco: "Av. Brasil, 100, Centro, Cuiabá - MT" })).id;
    u.porto = (await admin.ok("units:create", { razaoSocial: "Bar do Porto Bebidas Ltda", nome: "Bar do Porto", nomeCurto: "Porto", cnpj: "11.444.777/0001-61", endereco: "Rua do Porto, 200, Cuiabá - MT" })).id;
    await admin.ok("taps:create", { unitId: u.centro, quantidade: 4 });
    chope = (await admin.ok("chopes:create", { nome: "Chopp Pilsen", custoLitro: 12 })).id;
    hoje = (await admin.ok("config:get")).hoje;
    ontem = somaDias(hoje, -1);
    anteontem = somaDias(hoje, -2);
    validade = somaDias(hoje, 10);
    gerente = await makeUser(srv.base, admin, { nome: "Gina", email: "gina@barrilfacil.test", cargo: "gerente", unidadeIds: [u.centro] });
    quiosque = await makeUser(srv.base, admin, { nome: "Quiosque Centro", email: "quiosque@barrilfacil.test", cargo: "operador", unidadeIds: [u.centro] });
    f.ana = (await admin.ok("funcionarios:create", { nome: "Ana", unidadeIds: [u.centro] })).id;
    f.bia = (await admin.ok("funcionarios:create", { nome: "Bia", unidadeIds: [u.porto] })).id;

    for (const t of (await admin.ok("taps:board", { unitId: u.centro })).torneiras) tap[t.numero] = t.id;
    const novo = async (codigo, tamanho = 50) =>
      (await admin.ok("barris:create", { codigo, chopeId: chope, tamanho, validade, unitId: u.centro })).id;
    b.a = await novo("BA5-9121");          // engatado na Torneira 1
    b.b = await novo("BA5-9122");          // disponível
    b.c = await novo("BA2-9118", 20);      // engatado na Torneira 2
    b.d = await novo("BA2-9131", 20);      // disponível
    b.e = await novo("BA5-9113");          // passou pela Torneira 3 e saiu vazio
    b.f = await novo("BA5-9140");          // disponível (só engate)
    await admin.ok("barris:use", { id: b.a, torneiraId: tap[1], unitId: u.centro });
    await admin.ok("barris:use", { id: b.c, torneiraId: tap[2], unitId: u.centro });
    await admin.ok("barris:use", { id: b.e, torneiraId: tap[3], unitId: u.centro });
    await admin.ok("barris:empty", { id: b.e });

    // Histórico: entrada há 3 dias, engates anteontem; a Torneira 3 ficou livre anteontem às 16:00
    await muda(banco().from("barris").update({ criado_em: instante(-3, "09:00") }).eq("unidade_id", u.centro));
    await muda(banco().from("movimentacoes").update({ criado_em: instante(-3, "09:00") }).eq("operacao", "entrada"));
    const engatado = { [b.a]: instante(-2, "18:40"), [b.c]: instante(-2, "11:13"), [b.e]: instante(-3, "10:00") };
    for (const [id, em] of Object.entries(engatado)) {
      await muda(banco().from("engates").update({ engatado_em: em }).eq("barril_id", Number(id)));
      await muda(banco().from("movimentacoes").update({ criado_em: em }).eq("barril_id", Number(id)).eq("operacao", "utilizacao"));
    }
    await muda(banco().from("engates").update({ retirado_em: instante(-2, "16:00") }).eq("barril_id", b.e));
    await muda(banco().from("movimentacoes").update({ criado_em: instante(-2, "16:00") }).eq("barril_id", b.e).eq("operacao", "esgotado"));

    // Inventário de ontem às 22:30: pesou os engatados; os cheios entraram como 100%
    const inv = (await admin.ok("inventarios:iniciar", { unitId: u.centro })).inventario.id;
    for (const id of [b.a, b.c]) await admin.ok("pesagens:registrar", { barrilId: id, inventarioId: inv, metodo: "estimativa", nivel: 50 });
    await admin.ok("inventarios:concluir", { id: inv });
    const pesouEm = `${ontem}T22:30:41-04:00`;
    await muda(banco().from("pesagens").update({ criado_em: pesouEm }).eq("inventario_id", inv));
    await muda(banco().from("movimentacoes").update({ criado_em: pesouEm }).eq("operacao", "pesagem"));
  });
  after(async () => { if (srv) await srv.stop(); });

  test("só administrador e gerente: o operador não vê a permissão e a rota recusa", async () => {
    assert.ok((await admin.ok("auth:me")).permissoes.includes("torneiras:horario"));
    assert.ok((await gerente.ok("auth:me")).permissoes.includes("torneiras:horario"));
    assert.ok(!(await quiosque.ok("auth:me")).permissoes.includes("torneiras:horario"));
    await quiosque.fail("taps:lancarComHorario",
      { unitId: u.centro, torneiraId: tap[1], tipo: "retirada", retirada: { quando: quando(-1, "23:10"), vazio: true } }, SEM_PERMISSAO);
    assert.equal((await barrilDb(b.a)).status, "em_uso");
  });

  test("regras do horário: futuro, mais de 30 dias, antes do engate e antes da pesagem do inventário", async () => {
    const ret = (q, extra = {}) => lancar(admin, { torneiraId: tap[1], tipo: "retirada", retirada: { quando: q, vazio: true }, ...extra });
    let r = await ret(localDe(Date.now() + 2 * 3600e3));
    assert.equal(r.ok, false);
    assert.match(r.error, /^A retirada não pode ficar no futuro\. Agora são \d{2}:\d{2}\.$/);
    assert.equal(r.code, "CAMPO");
    assert.deepEqual(r.info, { campo: "ret" });

    r = await ret(quando(-31, "12:00"));
    assert.match(r.error, /^A retirada tem de ser dos últimos 30 dias/);

    r = await ret(quando(-2, "18:00"));
    assert.equal(r.error, `O #BA5-9121 foi engatado em ${ddmm(anteontem)} às 18:40. A retirada tem de ser depois disso.`);

    r = await ret(quando(-1, "22:30")); // no minuto da pesagem (22:30:41): ainda antes dela
    assert.equal(r.error, `O #BA5-9121 foi pesado no inventário de ${ddmm(ontem)} às 22:30, ainda na torneira. A retirada tem de ser depois disso.`);

    r = await ret("ontem 23:10");
    assert.equal(r.error, "Informe o dia e a hora da retirada.");
    assert.deepEqual(r.info, { campo: "ret" });

    // Retirada numa torneira livre e funcionário de outra unidade
    r = await lancar(admin, { torneiraId: tap[4], tipo: "retirada", retirada: { quando: quando(-1, "23:10"), vazio: true } });
    assert.equal(r.error, "A Torneira 4 está livre, não tem barril para retirar. Escolha outra torneira ou use Só engate.");
    r = await ret(quando(-1, "23:10"), { funcionarioId: f.bia });
    assert.equal(r.error, "Bia não está cadastrado nesta unidade. Escolha outro nome.");
    assert.deepEqual(r.info, { campo: "funcionario" });

    assert.equal((await barrilDb(b.a)).status, "em_uso"); // nada foi gravado
  });

  test("troca recusada (engate antes da retirada, barril que não está disponível): nada fica gravado", async () => {
    const troca = (ret, eng, barrilId = b.b) => lancar(admin, {
      torneiraId: tap[1], tipo: "troca", retirada: { quando: ret, vazio: true }, engate: { barrilId, quando: eng },
    });
    let r = await troca(quando(-1, "23:10"), quando(-1, "23:00"));
    assert.equal(r.error, `O engate tem de ser no mesmo horário da retirada ou depois dela (${ddmm(ontem)} às 23:10).`);
    assert.deepEqual(r.info, { campo: "eng" });

    // A retirada está certa, o engate não (o barril está engatado na Torneira 2): a retirada também não fica
    r = await troca(quando(-1, "23:10"), quando(-1, "23:10"), b.c);
    assert.equal(r.error, 'O barril #BA2-9118 não pode ser engatado: está "Em uso". Só barris disponíveis podem ser engatados.');
    assert.deepEqual(r.info, { campo: "barril" });
    assert.equal((await barrilDb(b.a)).status, "em_uso");
    assert.equal((await engatesDe(b.a)).at(-1).retirado_em, null);
    assert.equal((await movsDe(b.a)).filter((m) => m.lancado_em).length, 0);
  });

  test("troca de ontem às 23:10: grava os horários informados, quem fez, quem lançou e a auditoria", async () => {
    const eu = (await admin.ok("auth:me")).id;
    const r = await lancar(admin, {
      torneiraId: tap[1], tipo: "troca", funcionarioId: f.ana,
      retirada: { quando: quando(-1, "23:10"), vazio: true }, engate: { barrilId: b.b, quando: quando(-1, "23:10") },
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.torneira, 1);
    assert.deepEqual([r.data.retirada.codigo, r.data.retirada.quando, r.data.retirada.vazio], ["BA5-9121", `${ddmm(ontem)} às 23:10`, true]);
    assert.deepEqual([r.data.engate.codigo, r.data.engate.quando], ["BA5-9122", `${ddmm(ontem)} às 23:10`]);

    const saiu = (await engatesDe(b.a)).at(-1);
    assert.equal(Date.parse(saiu.retirado_em), Date.parse(instante(-1, "23:10")));
    assert.equal(saiu.retirada_lancada_por, eu);
    assert.ok(saiu.retirada_lancada_em);
    assert.equal(saiu.retirado_func_id, f.ana);
    assert.equal(saiu.engate_lancado_em, null); // o engate dele foi lançado na hora
    const entrou = (await engatesDe(b.b))[0];
    assert.equal(Date.parse(entrou.engatado_em), Date.parse(instante(-1, "23:10")));
    assert.equal(entrou.engate_lancado_por, eu);
    assert.ok(entrou.engate_lancado_em);
    assert.equal(entrou.engatado_func_id, f.ana);
    assert.equal(entrou.retirado_em, null);
    assert.equal((await barrilDb(b.a)).status, "esgotado");
    assert.equal((await barrilDb(b.b)).status, "em_uso");

    const movA = (await movsDe(b.a)).at(-1);
    assert.equal(movA.operacao, "esgotado");
    assert.equal(Date.parse(movA.criado_em), Date.parse(instante(-1, "23:10")));
    assert.ok(movA.lancado_em);
    const movB = (await movsDe(b.b)).at(-1);
    assert.equal(movB.operacao, "utilizacao");
    assert.equal(Date.parse(movB.criado_em), Date.parse(instante(-1, "23:10")));
    assert.ok(movB.lancado_em);

    const aud = (await consulta(banco().from("auditoria").select("usuario_id, detalhe").eq("acao", "lancamento_com_horario")))[0];
    assert.equal(aud.usuario_id, eu);
    assert.equal(aud.detalhe,
      `Torneira 1 (Bar do Centro): #BA5-9121 retirado vazio em ${ddmm(ontem)} às 23:10; #BA5-9122 engatado em ${ddmm(ontem)} às 23:10 · funcionário Ana`);

    // Quadro, histórico da torneira e aba Histórico
    const board = await admin.ok("taps:board", { unitId: u.centro });
    assert.equal(board.fuso, "America/Cuiaba");
    const t1 = board.torneiras.find((t) => t.numero === 1);
    assert.deepEqual([t1.codigo, t1.engate_lancado, t1.engatado_por, t1.engatado_em.slice(0, 16)], ["BA5-9122", true, "Ana", `${ontem} 23:10`]);
    assert.equal(board.torneiras.find((t) => t.numero === 2).engate_lancado, false);
    const hist = (await admin.ok("taps:history", { torneiraId: tap[1] })).engates;
    assert.deepEqual([hist[0].codigo, hist[0].engatado_por, hist[0].engate_lancado.por, hist[0].retirada_lancada], ["BA5-9122", "Ana", "Eduardo", null]);
    assert.deepEqual([hist[1].codigo, hist[1].retirado_por, hist[1].retirada_lancada.por, hist[1].engate_lancado], ["BA5-9121", "Ana", "Eduardo", null]);
    const movs = await admin.ok("history:list", { unitId: u.centro });
    assert.equal(movs.filter((m) => m.lancado_em).length, 2);
    for (let i = 1; i < movs.length; i++) assert.ok(movs[i - 1].criado_em >= movs[i].criado_em, "Histórico em ordem de horário");
  });

  test("só retirada com chope (gerente, sem funcionário): a pesagem fica no horário informado", async () => {
    const r = await lancar(gerente, {
      torneiraId: tap[2], tipo: "retirada", retirada: { quando: quando(-1, "23:30"), vazio: false, medida: { metodo: "estimativa", nivel: 50 } },
    });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual([r.data.retirada.codigo, Number(r.data.retirada.litros), r.data.retirada.estimado, r.data.engate], ["BA2-9118", 10, true, null]);
    const c = await barrilDb(b.c);
    assert.deepEqual([c.status, Number(c.saldo_l), c.saldo_estimado], ["disponivel", 10, true]);
    const pes = (await consulta(banco().from("pesagens").select("*").eq("barril_id", b.c).order("id"))).at(-1);
    assert.deepEqual([pes.motivo, Date.parse(pes.criado_em), !!pes.lancado_em], ["retirada", Date.parse(instante(-1, "23:30")), true]);
    const mov = (await movsDe(b.c)).at(-1);
    assert.deepEqual([mov.operacao, Date.parse(mov.criado_em), !!mov.lancado_em], ["retirada_com_chope", Date.parse(instante(-1, "23:30")), true]);
    const e = (await engatesDe(b.c)).at(-1);
    assert.equal(e.retirado_func_id, null);
    assert.equal(Number(e.litros_fim), 10);
    // "Não sei": no histórico não aparece quem retirou, só quem lançou
    const hist = (await admin.ok("taps:history", { torneiraId: tap[2] })).engates;
    assert.deepEqual([hist[0].retirado_por, hist[0].retirada_lancada.por], [null, "Gina"]);
    const aud = (await consulta(banco().from("auditoria").select("detalhe").eq("acao", "lancamento_com_horario").order("id", { ascending: false }).limit(1)))[0];
    assert.match(aud.detalhe, /#BA2-9118 retirado com 10 L \(estimado\) em .* · funcionário não informado$/);
  });

  test("só engate: depois da última retirada da torneira e depois do último registro do barril", async () => {
    const eng = (t, barrilId, q) => lancar(admin, { torneiraId: tap[t], tipo: "engate", engate: { barrilId, quando: q }, funcionarioId: f.ana });
    let r = await eng(1, b.f, quando(-1, "23:50"));
    assert.equal(r.error, "A Torneira 1 está com o #BA5-9122. Para pôr outro barril nela, use Troca de barril.");
    assert.deepEqual(r.info, { campo: "torneira" });
    r = await eng(3, b.f, quando(-2, "15:00"));
    assert.equal(r.error, `A Torneira 3 só ficou livre em ${ddmm(anteontem)} às 16:00, quando o #BA5-9113 saiu. O engate tem de ser depois disso.`);
    // O BA5-9140 estava cheio no estoque e entrou no inventário de ontem como 100%
    r = await eng(3, b.f, quando(-2, "16:00"));
    assert.equal(r.error, `O #BA5-9140 foi pesado no inventário de ${ddmm(ontem)} às 22:30, fora da torneira. O engate tem de ser depois disso.`);
    // A Torneira 2 ficou livre às 23:30 (teste anterior): o BA2-9118 saiu com chope e não volta antes disso
    r = await eng(4, b.c, quando(-1, "23:20"));
    assert.equal(r.error, `O #BA2-9118 foi retirado da Torneira 2 em ${ddmm(ontem)} às 23:30. O engate tem de ser depois disso.`);
    r = await eng(2, b.d, quando(-1, "23:29"));
    assert.equal(r.error, `A Torneira 2 só ficou livre em ${ddmm(ontem)} às 23:30, quando o #BA2-9118 saiu. O engate tem de ser depois disso.`);

    r = await eng(3, b.f, quando(-1, "23:50"));
    assert.equal(r.ok, true, r.error);
    const e = (await engatesDe(b.f))[0];
    assert.equal(Date.parse(e.engatado_em), Date.parse(instante(-1, "23:50")));
    assert.ok(e.engate_lancado_em);
    const t3 = (await admin.ok("taps:board", { unitId: u.centro })).torneiras.find((t) => t.numero === 3);
    assert.deepEqual([t3.codigo, t3.engate_lancado], ["BA5-9140", true]);
    // No mesmo minuto em que a torneira ficou livre também vale
    r = await eng(2, b.d, quando(-1, "23:30"));
    assert.equal(r.ok, true, r.error);
  });

  test("apagar quem lançou passa os lançamentos para quem recebe o histórico", async () => {
    const eu = (await admin.ok("auth:me")).id;
    const gina = (await admin.ok("users:list")).find((x) => x.nome === "Gina").id;
    await admin.ok("users:delete", { id: gina, destinoId: eu });
    const lancados = await consulta(banco().from("engates").select("retirada_lancada_por").eq("barril_id", b.c));
    assert.ok(lancados.some((e) => e.retirada_lancada_por === eu));
    assert.equal((await consulta(banco().from("engates").select("id").eq("retirada_lancada_por", gina))).length, 0);
  });
});
