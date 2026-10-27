/* ==========================================================
   BarrilFacil — regras de negócio (API do servidor) — versão Supabase
   Toda operação passa por aqui: valida permissão, grava no
   banco e registra quem fez (movimentação + auditoria).
   Cada aparelho tem a própria sessão (cookie).

   Mudanças em relação à versão SQLite:
   - Tudo é assíncrono (await). O estado da requisição (usuário logado,
     IP, pedido de login/logout) agora vive num objeto `ctx` por requisição,
     e não mais em variáveis globais (que se misturariam com await).
   - Operações com várias gravações (engatar, esgotar, transferir...) rodam
     como funções SQL (RPC) no Supabase: ou gravam tudo, ou nada.
   ========================================================== */
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { supabase } = require("./supabase");

const handlers = new Map();   // canal -> { fn, auth, perm }

const CARGO_LABEL = { admin: "Administrador", gerente: "Gerente", operador: "Operador" };

/* ---------- Permissões (num lugar só) ----------
   O que cada cargo pode fazer além do dia a dia (barris, engates, transferências, histórico e relatório),
   que é de todos. As rotas pedem uma permissão com handle(canal, fn, { perm }) e as telas perguntam com MC.pode(). */
const PERMISSOES_TODAS = ["usuarios", "unidades", "auditoria", "exportar", "catalogo:editar", "funcionarios"];
const PERMISSOES = {
  admin: PERMISSOES_TODAS,
  gerente: ["catalogo:editar", "funcionarios"],
  operador: [],
};
const pode = (user, perm) => !!user && (PERMISSOES[user.cargo] || []).includes(perm);

/* ---------- Infraestrutura ---------- */
const IDLE_MS = 15 * 60 * 1000;          // sessão expira após 15 min sem atividade
const MAX_FALHAS = 5;                     // tentativas erradas antes de bloquear
const BLOQUEIO_MS = 15 * 60 * 1000;       // duração do bloqueio
const PERMITIDOS_TROCA = new Set(["auth:me", "auth:logout", "auth:ping", "auth:completeProfile"]);

// Fuso da operação, usado para mostrar datas (APP_TZ no .env; APP_TIMEZONE é o nome antigo e continua aceito)
const TZ = process.env.APP_TZ || process.env.APP_TIMEZONE || "America/Cuiaba";
const tsFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const fmtTs = (v) => (v ? tsFmt.format(new Date(v)) : null); // "AAAA-MM-DD HH:MM:SS"
const dayFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hojeTZ = () => dayFmt.format(new Date()); // "AAAA-MM-DD" de hoje no fuso da operação (nunca em UTC)
const somaDias = (dia, n) => {                  // "AAAA-MM-DD" + n dias
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const diaMes = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`; // "2026-10-22" -> "22/10"
// Instante em que o dia "AAAA-MM-DD" começa no fuso da operação (ex.: 2026-10-01 em Cuiabá = 2026-10-01T04:00:00Z)
const inicioDoDia = (dia) => {
  const meiaNoiteUTC = new Date(`${dia}T00:00:00Z`);
  const lidoNoFuso = new Date(tsFmt.format(meiaNoiteUTC).replace(" ", "T") + "Z");
  return new Date(meiaNoiteUTC.getTime() - (lidoNoFuso - meiaNoiteUTC));
};
// Quem entrega os barris: aparece como origem das entradas no histórico (NOME_FORNECEDOR no .env)
const FORNECEDOR = String(process.env.NOME_FORNECEDOR || "").trim() || "Fornecedor";
// APP_ENV=beta marca o ambiente de testes (as telas mostram a faixa amarela). Sem APP_ENV: servidor das lojas.
const AMBIENTE = String(process.env.APP_ENV || "").trim().toLowerCase() || null;
const b2i = (v) => (v ? 1 : 0);

class AppError extends Error {
  constructor(message, code, detail, info) {
    super(message);
    this.appCode = code;
    this.detail = detail;
    this.info = info; // dados extras que a tela usa (vão na resposta junto com o erro)
  }
}

/* auth: true exige sessão; false dispensa; "opcional" usa a sessão se houver uma válida (ex.: config:get na tela de login).
   perm: permissão que o cargo precisa ter (tabela PERMISSOES); sem perm, qualquer usuário logado. */
function handle(channel, fn, { auth = true, perm = null } = {}) {
  handlers.set(channel, { fn, auth, perm });
}

/* Converte erro do Supabase/Postgres em erro do app.
   P0001 = "raise exception" das funções SQL (mensagem pronta para o usuário). */
function dbError(error, dupMsg) {
  if (!error) return;
  if (error.code === "23505") throw new AppError(dupMsg || "Já existe um registro com esse valor.");
  if (error.code === "P0001") throw new AppError(error.message);
  console.error("[supabase]", error);
  throw new Error(error.message || "Falha no banco de dados.");
}
const ok = (res, dupMsg) => { dbError(res.error, dupMsg); return res.data; };
const rpc = async (fn, args) => ok(await supabase.rpc(fn, args));

/* Remove caracteres que quebrariam filtros .or()/.ilike() do PostgREST */
const cleanTerm = (q) => String(q || "").replace("#", "").replace(/[,()%*\\_]/g, "").trim();

/* Limite de tentativas de login por aparelho/IP (somado ao bloqueio por conta) */
const IP_MAX = 30;
const IP_WINDOW_MS = 15 * 60 * 1000;
const ipFails = new Map();
const ipBlocked = (ip) => {
  const r = ipFails.get(ip);
  if (!r) return false;
  if (Date.now() > r.reset) { ipFails.delete(ip); return false; }
  return r.count >= IP_MAX;
};
const ipFail = (ip) => {
  if (ipFails.size > 5000) ipFails.clear();
  const r = ipFails.get(ip);
  if (!r || Date.now() > r.reset) ipFails.set(ip, { count: 1, reset: Date.now() + IP_WINDOW_MS });
  else r.count += 1;
};
const ipInfo = (ctx) => (ctx.clientIp ? ` (IP ${ctx.clientIp})` : "");

/* ---------- Auditoria ---------- */
async function audit(ctx, acao, detalhe, userId) {
  const uid = userId !== undefined ? userId : ctx.session ? ctx.session.id : null;
  const { error } = await supabase.from("auditoria").insert({ usuario_id: uid, acao, detalhe: detalhe || null });
  if (error) console.error("[auditoria]", error.message);
}

/* ---------- Sessões ----------
   Cada login vira uma linha em public.sessoes com o hash SHA-256 do token (o token em si só existe no cookie
   mc_session). Assim a sessão sobrevive a uma atualização do servidor, e desativar um usuário derruba a sessão dele.
   Cache em memória: a sessão lida do banco vale 60 s. Depois disso é relida junto com os dados atuais do usuário,
   então mudança de nome, cargo ou senha vale em até 60 s. ultima_atividade vai para o banco no máximo uma vez por minuto. */
const CACHE_SESSAO_MS = 60 * 1000;
const GRAVA_ATIVIDADE_MS = 60 * 1000;
const sessionCache = new Map(); // hash do token -> { hash, usuarioId, ativo, user, ultimaAtividade, gravadaEm, lidaEm }
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

/* Sessão do token, do cache (lida há menos de 60 s) ou do banco. null = não existe.
   Falha do banco sobe como erro técnico: a chamada nunca passa sem sessão. */
async function buscarSessao(token) {
  const hash = hashToken(token);
  const agora = Date.now();
  const c = sessionCache.get(hash);
  if (c && agora - c.lidaEm < CACHE_SESSAO_MS) return c;
  const r = await supabase.from("sessoes")
    .select("ultima_atividade, usuarios(id, nome, email, usuario, cargo, ativo, trocar_senha)")
    .eq("token_hash", hash).maybeSingle();
  dbError(r.error);
  if (!r.data || !r.data.usuarios) { sessionCache.delete(hash); return null; }
  const u = r.data.usuarios;
  const gravada = new Date(r.data.ultima_atividade).getTime();
  const rec = {
    hash, usuarioId: u.id, ativo: !!u.ativo, user: publicUser(u),
    ultimaAtividade: Math.max(gravada, c ? c.ultimaAtividade : 0), // a memória pode estar até 1 min à frente do banco
    gravadaEm: Math.max(gravada, c ? c.gravadaEm : 0),
    lidaEm: agora,
  };
  sessionCache.set(hash, rec);
  return rec;
}

async function criarSessao(user, ip) {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = hashToken(token);
  dbError((await supabase.from("sessoes").insert({ token_hash: hash, usuario_id: user.id, ip: ip || null })).error);
  const agora = Date.now();
  sessionCache.set(hash, { hash, usuarioId: user.id, ativo: true, user, ultimaAtividade: agora, gravadaEm: agora, lidaEm: agora });
  return token;
}

async function apagarSessao(hash) {
  sessionCache.delete(hash);
  dbError((await supabase.from("sessoes").delete().eq("token_hash", hash)).error);
}

async function marcarAtividade(rec) {
  const agora = Date.now();
  rec.ultimaAtividade = agora;
  if (agora - rec.gravadaEm < GRAVA_ATIVIDADE_MS) return;
  rec.gravadaEm = agora;
  const { error } = await supabase.from("sessoes").update({ ultima_atividade: new Date(agora).toISOString() }).eq("token_hash", rec.hash);
  if (error) console.error("[sessoes] atividade:", error.message);
}

/* Derruba as sessões do usuário, no banco e no cache. excetoToken: a sessão de quem fez a ação continua aberta. */
async function encerrarSessoes(usuarioId, { excetoToken } = {}) {
  const exceto = excetoToken ? hashToken(excetoToken) : null;
  for (const [hash, rec] of sessionCache) if (rec.usuarioId === usuarioId && hash !== exceto) sessionCache.delete(hash);
  let q = supabase.from("sessoes").delete().eq("usuario_id", usuarioId);
  if (exceto) q = q.neq("token_hash", exceto);
  dbError((await q).error);
}

/* Só esquece o cache do usuário: a próxima chamada dele busca os dados novos no banco */
function recarregarSessoes(usuarioId) {
  for (const [hash, rec] of sessionCache) if (rec.usuarioId === usuarioId) sessionCache.delete(hash);
}

/* Executa uma operação para o aparelho identificado por `token` (cookie de sessão).
   Retorna { body, setToken?, clearToken? }. */
async function dispatch(channel, payload, token, meta = {}) {
  const entry = handlers.get(channel);
  if (!entry) return { body: { ok: false, error: "Operação desconhecida.", code: "NOT_FOUND" } };
  const { fn, auth, perm } = entry;
  const ctx = { session: null, sessionAction: null, clientIp: meta.ip || "", token: token || null };

  let body;
  try {
    if (channel === "auth:login" && ipBlocked(ctx.clientIp))
      throw new AppError("Muitas tentativas deste aparelho. Aguarde alguns minutos.");
    if (auth === "opcional") {
      const rec = token ? await buscarSessao(token) : null;
      if (rec && rec.ativo && Date.now() - rec.ultimaAtividade <= IDLE_MS) ctx.session = rec.user;
    } else if (auth) {
      const rec = token ? await buscarSessao(token) : null;
      if (!rec) throw new AppError("Sessão expirada. Faça login novamente.", "SESSION");
      if (!rec.ativo) {
        await apagarSessao(rec.hash);
        throw new AppError("Sessão expirada. Faça login novamente.", "SESSION");
      }
      if (Date.now() - rec.ultimaAtividade > IDLE_MS) {
        ctx.session = rec.user; // a auditoria registra de quem era a sessão
        await audit(ctx, "sessao_expirada", "Encerrada por inatividade");
        ctx.session = null;
        await apagarSessao(rec.hash);
        throw new AppError("Sua sessão expirou por inatividade. Entre novamente.", "SESSION");
      }
      ctx.session = rec.user;
      if (ctx.session.trocarSenha && !PERMITIDOS_TROCA.has(channel))
        throw new AppError("Defina sua senha para continuar.", "MUST_CHANGE");
      await marcarAtividade(rec);
    }
    if (perm && !pode(ctx.session, perm)) throw new AppError("Você não tem permissão para esta ação.");
    const data = await fn(payload || {}, ctx);
    body = { ok: true, data };
  } catch (err) {
    if (err && err.appCode === "FORBIDDEN" && ctx.session) {
      await audit(ctx, "acesso_negado", `${channel}: ${err.detail || err.message}`).catch(() => {});
    }
    if (err instanceof AppError) {
      body = { ok: false, error: err.message, code: err.appCode };   // erro de regra: mensagem para o usuário
      if (err.info) body.info = err.info;
    } else {
      console.error(`[erro] ${channel}:`, err);                       // falha técnica: detalhe só no servidor
      body = { ok: false, error: "Erro inesperado. Tente novamente." };
    }
  }

  const out = { body };
  if (ctx.sessionAction === "end") {
    if (token) await apagarSessao(hashToken(token)).catch((err) => console.error("[sessoes] logout:", err.message));
    out.clearToken = true;
  } else if (ctx.sessionAction === "start" && body.ok) {
    try {
      if (token) await apagarSessao(hashToken(token)); // novo token a cada login (evita fixação de sessão)
      out.setToken = await criarSessao(ctx.session, ctx.clientIp);
    } catch (err) {
      console.error(`[erro] ${channel}: não foi possível criar a sessão:`, err);
      out.body = { ok: false, error: "Erro inesperado. Tente novamente." };
    }
  }
  if (channel === "auth:login") {
    if (body.ok) ipFails.delete(ctx.clientIp);
    else ipFail(ctx.clientIp);
  }
  return out;
}

/* Limpa as sessões vencidas: as do banco (com 1 min de folga, porque ultima_atividade pode estar até
   1 min atrás da memória) e as do cache */
setInterval(async () => {
  const agora = Date.now();
  for (const [h, r] of sessionCache) if (agora - r.ultimaAtividade > IDLE_MS + GRAVA_ATIVIDADE_MS) sessionCache.delete(h);
  try {
    const { error } = await supabase.from("sessoes").delete()
      .lt("ultima_atividade", new Date(agora - IDLE_MS - GRAVA_ATIVIDADE_MS).toISOString());
    if (error) console.error("[sessoes] limpeza:", error.message);
  } catch (err) {
    console.error("[sessoes] limpeza:", err.message);
  }
}, 5 * 60 * 1000).unref();

/* ---------- Segurança de senhas e e-mails ---------- */
const hashPassword = (pw) => bcrypt.hash(String(pw), 12);
const SENHAS_COMUNS = new Set([
  "12345678", "123456789", "1234567890", "11111111", "password", "password1", "senha123", "senha1234",
  "admin123", "admin1234", "qwerty123", "abc12345", "chopp123", "meuchopp1", "meuchopp123",
  "barrilfacil1", "barrilfacil123",
]);

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    throw new AppError("Informe um e-mail válido, como nome@empresa.com.");
  return email;
}

function checkPassword(password, email) {
  const pw = String(password || "");
  if (pw.length < 8) throw new AppError("A senha precisa ter ao menos 8 caracteres.");
  if (pw.length > 72) throw new AppError("A senha pode ter no máximo 72 caracteres.");
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new AppError("A senha precisa ter letras e números.");
  if (SENHAS_COMUNS.has(pw.toLowerCase())) throw new AppError("Essa senha é muito comum. Escolha outra.");
  const local = String(email || "").split("@")[0];
  if (local.length >= 4 && pw.toLowerCase().includes(local))
    throw new AppError("A senha não pode conter o seu e-mail.");
}

/* Senha temporária aleatória (10 caracteres, sem letras ambíguas como I, l, O, 0) */
function generateTempPassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  for (;;) {
    let pw = "";
    for (let i = 0; i < 10; i++) pw += chars[crypto.randomInt(chars.length)];
    if (/[A-Za-z]/.test(pw) && /\d/.test(pw)) return pw;
  }
}

/* ---------- CNPJ ----------
   Aceita o CNPJ numérico e o alfanumérico: 12 caracteres de A-Z/0-9 + 2 dígitos verificadores.
   Cada caractere vale (código ASCII − 48). Guardado sem pontuação. */
function cnpjCheckDigit(chars) {
  const pesos = chars.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const soma = chars.split("").reduce((acc, c, i) => acc + (c.charCodeAt(0) - 48) * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? "0" : String(11 - resto);
}
function normalizeCnpj(value) {
  const raw = String(value || "").toUpperCase().replace(/[.\/\-\s]/g, "");
  if (!raw) throw new AppError("Informe o CNPJ da unidade.");
  if (!/^[A-Z0-9]{12}\d{2}$/.test(raw)) throw new AppError("CNPJ inválido. Ele deve ter 14 caracteres, como 11.222.333/0001-81.");
  if (/^(\d)\1{13}$/.test(raw)) throw new AppError("CNPJ inválido. Confira os números digitados.");
  const dv1 = cnpjCheckDigit(raw.slice(0, 12));
  const dv2 = cnpjCheckDigit(raw.slice(0, 12) + dv1);
  if (raw.slice(12) !== dv1 + dv2) throw new AppError("CNPJ inválido: os dígitos verificadores não conferem.");
  return raw;
}
const formatCnpj = (c) => (c ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : null);

const STATUS_TEXTO = {
  disponivel: "Disponível", em_uso: "Em uso", em_transferencia: "Em transferência",
  esgotado: "Vazio (aguardando recolhimento)", recolhido: "Recolhido",
};

/* Validade (conta a partir da chegada na loja). O sistema só avisa, nunca bloqueia.
   Vazios e recolhidos não têm situação: o chope já saiu do barril. */
function situacaoValidade(validade, status, hoje = hojeTZ()) {
  if (!validade || status === "esgotado" || status === "recolhido") return null;
  if (validade < hoje) return "vencido";
  if (validade === hoje) return "vence_hoje";
  if (validade === somaDias(hoje, 1)) return "vence_amanha";
  return "ok";
}
const MSG_SEM_TORNEIRA = "Não há torneiras disponíveis nesta unidade. Verifique as torneiras cadastradas ou libere uma torneira antes de continuar.";

async function emailTaken(email, exceptId = 0) {
  const rows = ok(await supabase.from("usuarios").select("id").eq("email", email).neq("id", exceptId).limit(1));
  return rows.length > 0;
}

async function findUserByIdent(ident) {
  let r = await supabase.from("usuarios").select("*").eq("email", ident).maybeSingle();
  dbError(r.error);
  if (!r.data) {
    r = await supabase.from("usuarios").select("*").eq("usuario", ident).maybeSingle();
    dbError(r.error);
  }
  return r.data;
}

async function getUserById(id) {
  const r = await supabase.from("usuarios").select("*").eq("id", id).maybeSingle();
  dbError(r.error);
  return r.data;
}

/* ---------- Torneiras ----------
   A situação (livre/ocupada) nunca é gravada na torneira: ela é derivada do engate ativo
   (engates.retirado_em IS NULL). */
const TAPS_SELECT =
  "id, unidade_id, numero, ativo, engates(id, barril_id, engatado_em, retirado_em, barris(codigo, estilo, chope_nome, tamanho_l, validade, status), usuarios!engatado_por(nome))";

function tapRow(t) {
  const e = (t.engates || []).find((x) => x.retirado_em === null) || null;
  return {
    id: t.id,
    unidade_id: t.unidade_id,
    numero: t.numero,
    ativo: b2i(t.ativo),
    engate_id: e ? e.id : null,
    engatado_em: e ? fmtTs(e.engatado_em) : null,
    engatado_em_iso: e ? e.engatado_em : null,
    engatado_por: e && e.usuarios ? e.usuarios.nome : null,
    barril_id: e ? e.barril_id : null,
    codigo: e && e.barris ? e.barris.codigo : null,
    estilo: e && e.barris ? e.barris.estilo : null,
    chope_nome: e && e.barris ? e.barris.chope_nome : null,
    tamanho_l: e && e.barris ? e.barris.tamanho_l : null,
    validade: e && e.barris ? e.barris.validade : null,
    situacao_validade: e && e.barris ? situacaoValidade(e.barris.validade, e.barris.status) : null,
    usos: (t.engates || []).length,
    ocupada: !!e,
  };
}

async function tapsOfUnit(unitId) {
  const rows = ok(
    await supabase.from("torneiras").select(TAPS_SELECT).eq("unidade_id", unitId)
      .order("ativo", { ascending: false }).order("numero", { ascending: true })
  );
  return rows.map(tapRow);
}

async function activeEngateOfTap(torneiraId) {
  const r = await supabase
    .from("engates").select("id, barris(codigo)").eq("torneira_id", torneiraId).is("retirado_em", null).maybeSingle();
  dbError(r.error);
  return r.data ? { id: r.data.id, codigo: r.data.barris ? r.data.barris.codigo : "?" } : null;
}

/* ---------- Acesso por quiosque ----------
   Administrador: todos os quiosques ativos.
   Gerente e operador: somente os quiosques que um administrador liberou para eles. */
async function allowedUnitIds(ctx) {
  if (ctx.session.cargo === "admin") {
    return ok(await supabase.from("unidades").select("id").eq("ativo", true).order("id")).map((r) => r.id);
  }
  const rows = ok(
    await supabase.from("usuario_unidades").select("unidade_id, unidades!inner(ativo)")
      .eq("usuario_id", ctx.session.id).eq("unidades.ativo", true)
  );
  return rows.map((r) => r.unidade_id).sort((a, b) => a - b);
}

async function assertUnit(ctx, unitId) {
  const id = Number(unitId);
  if (!(await allowedUnitIds(ctx)).includes(id))
    throw new AppError("Você não tem acesso a esta unidade.", "FORBIDDEN", `unidade ${id}`);
}

/* Quiosque em uso na tela: o pedido (se permitido) ou o primeiro liberado para o usuário */
async function resolveUnit(ctx, unitId) {
  const allowed = await allowedUnitIds(ctx);
  if (!allowed.length)
    throw new AppError("Você ainda não tem acesso a nenhuma unidade. Peça a um administrador para liberar.");
  const id = Number(unitId);
  if (!id) return allowed[0];
  if (!allowed.includes(id)) throw new AppError("Você não tem acesso a esta unidade.", "FORBIDDEN", `unidade ${id}`);
  return id;
}

async function loadBarril(ctx, id) {
  const r = await supabase.from("barris").select("*").eq("id", Number(id)).maybeSingle();
  dbError(r.error);
  if (!r.data) throw new AppError("Barril não encontrado.");
  await assertUnit(ctx, r.data.unidade_id);
  return r.data;
}

function publicUser(u) {
  return {
    id: u.id,
    nome: u.nome,
    email: u.email || null,
    usuario: u.usuario,
    cargo: u.cargo,
    cargoLabel: CARGO_LABEL[u.cargo],
    permissoes: PERMISSOES[u.cargo] || [],
    iniciais: u.nome.trim().charAt(0).toUpperCase(),
    trocarSenha: !!u.trocar_senha || !u.email,
  };
}

/* ---------- Consulta de movimentações (usada em dashboard, histórico e CSV) ---------- */
async function queryMovements({ unitId, q, operacao, limit }) {
  const unit = Number(unitId);
  let query = supabase
    .from("movimentacoes")
    .select(
      "id, operacao, criado_em, observacao, torneira_numero, barris!inner(codigo, estilo, chope_nome), usuarios(nome)," +
      " origem:unidades!origem_unidade_id(nome), destino:unidades!destino_unidade_id(nome)"
    )
    .or(`origem_unidade_id.eq.${unit},destino_unidade_id.eq.${unit}`)
    .order("id", { ascending: false })
    .limit(Math.min(Number(limit) || 5000, 5000));
  const termo = cleanTerm(q);
  if (termo) query = query.ilike("barris.codigo", `%${termo}%`);
  if (operacao) query = query.eq("operacao", String(operacao));
  const rows = ok(await query);
  return rows.map((m) => ({
    id: m.id,
    operacao: m.operacao,
    criado_em: fmtTs(m.criado_em),
    observacao: m.observacao,
    torneira_numero: m.torneira_numero,
    codigo: m.barris ? m.barris.codigo : null,
    estilo: m.barris ? m.barris.estilo : null,
    chope_nome: m.barris ? m.barris.chope_nome : null,
    responsavel: m.usuarios ? m.usuarios.nome : null,
    origem: m.origem ? m.origem.nome : null,
    destino: m.destino ? m.destino.nome : null,
  }));
}

function registerHandlers() {
  /* ======== Autenticação ======== */
  const GENERIC = "E-mail ou senha incorretos.";
  const unknownAttempts = new Map(); // tentativas com e-mails que não existem (também limitadas)
  let dummyHash = null;              // evita revelar, pelo tempo de resposta, se o e-mail existe

  const lockMessage = (until) => {
    const min = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    return `Muitas tentativas. Tente novamente em ${min} minuto${min > 1 ? "s" : ""}.`;
  };

  const startSession = (ctx, user) => {
    ctx.session = publicUser(user);
    ctx.sessionAction = "start";
    return ctx.session;
  };

  // Verifica se a base está vazia para mostrar a tela de 1º acesso
  handle("auth:needsSetup", async () => {
    const { count, error } = await supabase.from("usuarios").select("id", { count: "exact", head: true });
    if (error) {
      console.error("[needsSetup]", error);
      throw new AppError("Não foi possível acessar o banco de dados. Verifique a configuração do Supabase (arquivo .env e as migrations de supabase/migrations).");
    }
    return count === 0;
  }, { auth: false });

  // Cria a primeira conta de Administrador do sistema
  handle("auth:setup", async ({ nome, email, senha }, ctx) => {
    const { count, error: cErr } = await supabase.from("usuarios").select("id", { count: "exact", head: true });
    dbError(cErr);
    if (count > 0) throw new AppError("O sistema já foi configurado. Entre com o seu e-mail e senha.");

    const name = String(nome || "").trim();
    if (!name) throw new AppError("Informe o seu nome.");
    const em = normalizeEmail(email);
    checkPassword(senha, em);

    const newUser = ok(
      await supabase.from("usuarios")
        .insert({ nome: name, usuario: em, email: em, senha_hash: await hashPassword(senha), cargo: "admin", trocar_senha: false, ativo: true })
        .select().single(),
      "Este e-mail já está em uso."
    );

    startSession(ctx, newUser);
    await audit(ctx, "configuracao_inicial", `Administrador ${em} criado`);
    return ctx.session;
  }, { auth: false });

  handle("auth:login", async ({ identifier, password }, ctx) => {
    const ident = String(identifier || "").trim().toLowerCase();
    const pass = String(password || "");
    if (!ident || !pass) throw new AppError(GENERIC);

    const user = await findUserByIdent(ident);
    const now = Date.now();
    const unknown = unknownAttempts.get(ident);
    const lockedUntil = user ? Number(user.bloqueado_ate) || 0 : unknown ? unknown.until : 0;
    if (lockedUntil > now) {
      await audit(ctx, "login_bloqueado", `Tentativa durante bloqueio (${ident})`, user ? user.id : null);
      throw new AppError(lockMessage(lockedUntil));
    }

    if (!dummyHash) dummyHash = await hashPassword("senha-ficticia-barrilfacil");
    const match = await bcrypt.compare(pass, user && user.ativo ? user.senha_hash : dummyHash);

    if (!(user && user.ativo && match)) {
      let until = 0;
      if (user) {
        const falhas = (user.falhas || 0) + 1;
        if (falhas >= MAX_FALHAS) {
          until = now + BLOQUEIO_MS;
          dbError((await supabase.from("usuarios").update({ falhas: 0, bloqueado_ate: until }).eq("id", user.id)).error);
        } else {
          dbError((await supabase.from("usuarios").update({ falhas }).eq("id", user.id)).error);
        }
      } else {
        if (unknownAttempts.size > 1000) unknownAttempts.clear();
        const rec = unknown || { count: 0, until: 0 };
        rec.count += 1;
        if (rec.count >= MAX_FALHAS) { rec.until = now + BLOQUEIO_MS; rec.count = 0; }
        unknownAttempts.set(ident, rec);
        until = rec.until;
      }
      await audit(ctx, "login_falhou", `Tentativa com "${ident}"${ipInfo(ctx)}`, user ? user.id : null);
      throw new AppError(until > now ? lockMessage(until) : GENERIC);
    }

    dbError(
      (await supabase.from("usuarios")
        .update({ falhas: 0, bloqueado_ate: null, ultimo_login: new Date().toISOString() }).eq("id", user.id)).error
    );
    unknownAttempts.delete(ident);
    startSession(ctx, user);
    await audit(ctx, "login", "Entrou no sistema" + ipInfo(ctx));
    return ctx.session;
  }, { auth: false });

  handle("auth:logout", async (_p, ctx) => {
    await audit(ctx, "logout", "Saiu do sistema");
    ctx.sessionAction = "end";
    return true;
  });

  handle("auth:me", (_p, ctx) => ctx.session);

  // Dados do servidor que as telas usam (carregados junto com o cabeçalho).
  // Sem login (telas de entrar, primeiro acesso e configuração) devolve só o ambiente, para a faixa de testes.
  handle("config:get", (_p, ctx) =>
    ctx.session ? { fornecedor: FORNECEDOR, hoje: hojeTZ(), ambiente: AMBIENTE } : { ambiente: AMBIENTE },
  { auth: "opcional" });
  handle("auth:ping", () => true); // mantém a sessão viva enquanto o usuário está ativo

  /* Primeiro acesso / senha temporária: define e-mail (se faltar) e uma senha nova */
  handle("auth:completeProfile", async ({ email, nova }, ctx) => {
    const u = await getUserById(ctx.session.id);
    const em = normalizeEmail(email || u.email);
    checkPassword(nova, em);
    if (await bcrypt.compare(String(nova), u.senha_hash))
      throw new AppError("A nova senha precisa ser diferente da senha temporária.");
    if (await emailTaken(em, u.id)) throw new AppError("Este e-mail já está sendo usado por outro usuário.");
    dbError(
      (await supabase.from("usuarios")
        .update({ email: em, usuario: em, senha_hash: await hashPassword(nova), trocar_senha: false }).eq("id", u.id)).error,
      "Este e-mail já está sendo usado por outro usuário."
    );
    startSession(ctx, await getUserById(u.id));
    await audit(ctx, "primeiro_acesso", "Definiu e-mail e nova senha");
    return ctx.session;
  });

  handle("auth:changePassword", async ({ atual, nova }, ctx) => {
    const u = await getUserById(ctx.session.id);
    if (!(await bcrypt.compare(String(atual || ""), u.senha_hash))) throw new AppError("Senha atual incorreta.");
    checkPassword(nova, u.email);
    if (String(nova) === String(atual)) throw new AppError("A nova senha precisa ser diferente da atual.");
    dbError((await supabase.from("usuarios").update({ senha_hash: await hashPassword(nova) }).eq("id", u.id)).error);
    await encerrarSessoes(u.id, { excetoToken: ctx.token }); // os outros aparelhos saem; este continua
    await audit(ctx, "senha_alterada", "Alterou a própria senha");
    return true;
  });

  /* ======== Quiosques ======== */
  // Quiosques que o usuário pode acessar (alimenta o seletor do cabeçalho)
  handle("units:list", async (_p, ctx) => {
    const ids = await allowedUnitIds(ctx);
    if (!ids.length) return [];
    return ok(await supabase.from("unidades").select("id, nome, nome_curto").in("id", ids).order("id"));
  });

  // Destinos possíveis de uma transferência: só nomes dos quiosques ativos
  handle("units:all", async () =>
    ok(await supabase.from("unidades").select("id, nome, nome_curto").eq("ativo", true).order("id"))
  );

  handle("units:adminList", async () => {
    const rows = await rpc("fn_unidades_resumo", {});
    return rows.map((u) => ({ ...u, ativo: b2i(u.ativo), cnpjFormatado: formatCnpj(u.cnpj) }));
  }, { perm: "unidades" });

  /* Detalhes de uma unidade + suas torneiras (tela Unidades) */
  handle("units:details", async ({ id }) => {
    const r = await supabase.from("unidades").select("id, nome, nome_curto, ativo, cnpj, endereco").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    if (!r.data) throw new AppError("Unidade não encontrada.");
    const u = r.data;
    return { ...u, ativo: b2i(u.ativo), cnpjFormatado: formatCnpj(u.cnpj), torneiras: await tapsOfUnit(u.id) };
  }, { perm: "unidades" });

  /* Nome, CNPJ e endereço são obrigatórios ao cadastrar e ao editar. */
  const likeEscape = (s) => s.replace(/[\\%_]/g, "\\$&");
  const cleanUnitData = async ({ nome, nomeCurto, cnpj, endereco }, exceptId = 0) => {
    const full = String(nome || "").trim();
    const short = String(nomeCurto || "").trim() || full;
    if (full.length < 2) throw new AppError("Informe o nome da unidade.");
    if (full.length > 60 || short.length > 30) throw new AppError("Nome muito longo (máximo 60 e 30 caracteres).");
    const mesmoNome = ok(await supabase.from("unidades").select("id").ilike("nome", likeEscape(full)).neq("id", exceptId).limit(1));
    if (mesmoNome.length) throw new AppError(`Já existe uma unidade chamada "${full}".`);
    const doc = normalizeCnpj(cnpj);
    const outra = ok(await supabase.from("unidades").select("nome").eq("cnpj", doc).neq("id", exceptId).limit(1));
    if (outra.length) throw new AppError(`Este CNPJ já está cadastrado na unidade "${outra[0].nome}".`);
    const end = String(endereco || "").trim().replace(/\s+/g, " ");
    if (end.length < 8) throw new AppError("Informe a localização completa da unidade (rua, número, bairro, cidade, estado e CEP).");
    if (end.length > 300) throw new AppError("Localização muito longa (máximo 300 caracteres).");
    return { full, short, doc, end };
  };

  handle("units:create", async (p, ctx) => {
    const { full, short, doc, end } = await cleanUnitData(p);
    const row = ok(
      await supabase.from("unidades").insert({ nome: full, nome_curto: short, cnpj: doc, endereco: end }).select("id").single(),
      "Já existe uma unidade com esse nome ou CNPJ."
    );
    await audit(ctx, "unidade_criada", `${full} (CNPJ ${formatCnpj(doc)})`);
    return { id: row.id };
  }, { perm: "unidades" });

  handle("units:update", async (p, ctx) => {
    const id = Number(p.id);
    const ex = ok(await supabase.from("unidades").select("id").eq("id", id));
    if (!ex.length) throw new AppError("Unidade não encontrada.");
    const { full, short, doc, end } = await cleanUnitData(p, id);
    dbError(
      (await supabase.from("unidades").update({ nome: full, nome_curto: short, cnpj: doc, endereco: end }).eq("id", id)).error,
      "Já existe uma unidade com esse nome ou CNPJ."
    );
    await audit(ctx, "unidade_editada", `${full} (CNPJ ${formatCnpj(doc)})`);
    return true;
  }, { perm: "unidades" });

  handle("units:toggle", async ({ id }, ctx) => {
    const r = await supabase.from("unidades").select("*").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    const u = r.data;
    if (!u) throw new AppError("Unidade não encontrada.");
    if (u.ativo) {
      const a = await supabase.from("barris").select("id", { count: "exact", head: true }).eq("unidade_id", u.id).not("status", "in", "(esgotado,recolhido)");
      dbError(a.error);
      const b = await supabase.from("transferencias").select("id", { count: "exact", head: true }).eq("destino_id", u.id).eq("status", "pendente");
      dbError(b.error);
      if (a.count || b.count)
        throw new AppError(
          `Esta unidade ainda tem ${a.count} barril(is) em estoque e ${b.count} transferência(s) a receber. Resolva antes de desativar.`
        );
    }
    dbError((await supabase.from("unidades").update({ ativo: !u.ativo }).eq("id", u.id)).error);
    await audit(ctx, u.ativo ? "unidade_desativada" : "unidade_reativada", u.nome);
    return true;
  }, { perm: "unidades" });

  /* ======== Torneiras ======== */
  const loadTap = async (id) => {
    const r = await supabase.from("torneiras").select("*").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    if (!r.data) throw new AppError("Torneira não encontrada.");
    return r.data;
  };
  const cleanTapNumber = (n) => {
    const num = Number(n);
    if (!Number.isInteger(num) || num < 1 || num > 999) throw new AppError("O número da torneira deve ser um número inteiro entre 1 e 999.");
    return num;
  };
  const tapNumberTaken = async (unitId, numero, exceptId = 0) =>
    ok(await supabase.from("torneiras").select("id").eq("unidade_id", unitId).eq("numero", numero).eq("ativo", true).neq("id", exceptId).limit(1)).length > 0;
  const unitById = async (id) => {
    const r = await supabase.from("unidades").select("nome, ativo").eq("id", id).maybeSingle();
    dbError(r.error);
    return r.data;
  };

  // Cadastra uma ou mais torneiras com os próximos números livres da unidade
  handle("taps:create", async ({ unitId, quantidade = 1 }, ctx) => {
    const numeros = await rpc("fn_torneiras_criar", {
      p_unidade: Number(unitId), p_qtd: Number(quantidade), p_usuario: ctx.session.id,
    });
    return { numeros };
  }, { perm: "unidades" });

  // Altera o número visível. O histórico guarda o número usado em cada operação, então não muda.
  handle("taps:update", async ({ id, numero }, ctx) => {
    const t = await loadTap(id);
    const num = cleanTapNumber(numero);
    if (num === t.numero) return true;
    if (t.ativo && (await tapNumberTaken(t.unidade_id, num, t.id)))
      throw new AppError(`Já existe uma Torneira ${num} ativa nesta unidade.`);
    dbError((await supabase.from("torneiras").update({ numero: num }).eq("id", t.id)).error, `Já existe uma Torneira ${num} ativa nesta unidade.`);
    const un = await unitById(t.unidade_id);
    await audit(ctx, "torneira_renumerada", `${un.nome}: Torneira ${t.numero} → Torneira ${num}`);
    return true;
  }, { perm: "unidades" });

  // Desativa/reativa. Torneiras nunca são apagadas: o histórico de engates continua apontando para elas.
  handle("taps:toggle", async ({ id }, ctx) => {
    const t = await loadTap(id);
    const un = await unitById(t.unidade_id);
    if (t.ativo) {
      const e = await activeEngateOfTap(t.id);
      if (e) throw new AppError(`A Torneira ${t.numero} está ocupada pelo barril #${e.codigo}. Retire o barril antes de desativá-la.`);
    } else {
      if (!un.ativo) throw new AppError("Esta unidade está desativada. Reative-a antes de reativar a torneira.");
      if (await tapNumberTaken(t.unidade_id, t.numero, t.id))
        throw new AppError(`Já existe uma Torneira ${t.numero} ativa nesta unidade. Altere o número desta torneira antes de reativá-la.`);
    }
    dbError((await supabase.from("torneiras").update({ ativo: !t.ativo }).eq("id", t.id)).error);
    await audit(ctx, t.ativo ? "torneira_desativada" : "torneira_reativada", `${un.nome}: Torneira ${t.numero}`);
    return true;
  }, { perm: "unidades" });

  // Torneiras da unidade do barril, para o funcionário escolher no engate (respeita o acesso à unidade)
  handle("taps:forBarril", async ({ barrilId }, ctx) => {
    const b = await loadBarril(ctx, barrilId);
    const r = await supabase.from("unidades").select("id, nome").eq("id", b.unidade_id).single();
    dbError(r.error);
    const torneiras = (await tapsOfUnit(b.unidade_id))
      .filter((t) => t.ativo)
      .map((t) => ({
        id: t.id, numero: t.numero, ocupada: t.ocupada, barril: t.codigo || null, estilo: t.estilo || null, chope_nome: t.chope_nome || null,
      }));
    return {
      barril: {
        id: b.id, codigo: b.codigo, estilo: b.estilo, chope_nome: b.chope_nome || null, status: b.status,
        validade: b.validade, situacao_validade: situacaoValidade(b.validade, b.status),
      },
      unidade: r.data,
      torneiras,
    };
  });

  // Aba Torneiras: situação de cada torneira ativa da unidade (qualquer usuário com acesso à unidade)
  handle("taps:board", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    await assertUnit(ctx, unit);
    const torneiras = (await tapsOfUnit(unit))
      .filter((t) => t.ativo)
      .sort((a, b) => a.numero - b.numero)
      .map((t) => ({
        id: t.id,
        numero: t.numero,
        ocupada: t.ocupada,
        barril_id: t.ocupada ? t.barril_id : null, // para retirar o barril direto pela aba Torneiras
        codigo: t.ocupada ? t.codigo : null,
        chope_nome: t.ocupada ? t.chope_nome : null,
        estilo: t.ocupada ? t.estilo : null,
        tamanho_l: t.ocupada ? t.tamanho_l : null,
        validade: t.ocupada ? t.validade : null,
        situacao_validade: t.ocupada ? t.situacao_validade : null,
        engatado_em: t.engatado_em,
        engatado_em_iso: t.engatado_em_iso,
        engatado_por: t.engatado_por,
      }));
    return { agora: new Date().toISOString(), torneiras }; // "agora" = relógio do servidor, para o "há quanto tempo"
  });

  // Últimos 50 engates de uma torneira, do mais recente para o mais antigo
  handle("taps:history", async ({ torneiraId }, ctx) => {
    const t = await loadTap(torneiraId);
    await assertUnit(ctx, t.unidade_id);
    const rows = ok(
      await supabase.from("engates")
        .select("id, engatado_em, retirado_em, barris(codigo, estilo, chope_nome), usuarios!engatado_por(nome)")
        .eq("torneira_id", t.id)
        .order("engatado_em", { ascending: false })
        .order("id", { ascending: false })
        .limit(50)
    );
    return {
      torneira: { id: t.id, numero: t.numero },
      agora: new Date().toISOString(),
      engates: rows.map((e) => ({
        codigo: e.barris ? e.barris.codigo : null,
        chope_nome: e.barris ? e.barris.chope_nome : null,
        estilo: e.barris ? e.barris.estilo : null,
        engatado_em: fmtTs(e.engatado_em),
        engatado_em_iso: e.engatado_em,
        retirado_em: fmtTs(e.retirado_em),
        retirado_em_iso: e.retirado_em || null,
        engatado_por: e.usuarios ? e.usuarios.nome : null,
      })),
    };
  });

  /* ======== Catálogo de chopes e estilos ========
     Cadastrar: qualquer usuário logado (direto do cadastro de barril).
     Editar e desativar: permissão catalogo:editar (administrador e gerente). Nada é apagado: barris antigos continuam apontando para o chope. */
  const cleanCatalogName = (value, tipo) => {
    const nome = String(value || "").trim().replace(/\s+/g, " ");
    if (nome.length < 2 || nome.length > 60) throw new AppError(`O nome do ${tipo} deve ter de 2 a 60 caracteres.`);
    return nome;
  };
  // Nome repetido, sem diferenciar maiúsculas (o índice único em lower(nome) garante no banco)
  const catalogNameTaken = async (tabela, tipo, nome, exceptId = 0) => {
    const rows = ok(await supabase.from(tabela).select("nome, ativo").ilike("nome", likeEscape(nome)).neq("id", exceptId).limit(10));
    const igual = rows.find((r) => r.nome.toLowerCase() === nome.toLowerCase());
    if (!igual) return;
    const extra = igual.ativo ? "" : " (desativado). Peça a um administrador para reativá-lo";
    throw new AppError(`Já existe um ${tipo} chamado "${igual.nome}"${extra}.`);
  };
  const loadEstilo = async (id) => {
    const r = await supabase.from("estilos").select("*").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    if (!r.data) throw new AppError("Estilo não encontrado.");
    return r.data;
  };
  const loadChope = async (id) => {
    const r = await supabase.from("chopes").select("*, estilos(nome)").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    if (!r.data) throw new AppError("Chope não encontrado.");
    return r.data;
  };
  const wantsAll = (p, ctx) => !!p.todos && pode(ctx.session, "catalogo:editar");

  handle("estilos:list", async (p, ctx) => {
    let query = supabase.from("estilos").select("id, nome, ativo").order("nome");
    if (!wantsAll(p, ctx)) query = query.eq("ativo", true);
    return ok(await query).map((e) => ({ ...e, ativo: b2i(e.ativo) }));
  });

  handle("estilos:create", async ({ nome }, ctx) => {
    const n = cleanCatalogName(nome, "estilo");
    await catalogNameTaken("estilos", "estilo", n);
    const row = ok(await supabase.from("estilos").insert({ nome: n }).select("id, nome").single(), `Já existe um estilo chamado "${n}".`);
    await audit(ctx, "estilo_criado", n);
    return row;
  });

  // Renomear o estilo também atualiza barris.estilo dos barris dos chopes desse estilo
  handle("estilos:update", async ({ id, nome }, ctx) => {
    const e = await loadEstilo(id);
    const n = cleanCatalogName(nome, "estilo");
    if (n === e.nome) return true;
    await catalogNameTaken("estilos", "estilo", n, e.id);
    dbError((await supabase.from("estilos").update({ nome: n }).eq("id", e.id)).error, `Já existe um estilo chamado "${n}".`);
    const chopeIds = ok(await supabase.from("chopes").select("id").eq("estilo_id", e.id)).map((c) => c.id);
    if (chopeIds.length) dbError((await supabase.from("barris").update({ estilo: n }).in("chope_id", chopeIds)).error);
    await audit(ctx, "estilo_editado", `${e.nome} → ${n}`);
    return true;
  }, { perm: "catalogo:editar" });

  handle("estilos:toggle", async ({ id }, ctx) => {
    const e = await loadEstilo(id);
    dbError((await supabase.from("estilos").update({ ativo: !e.ativo }).eq("id", e.id)).error);
    await audit(ctx, e.ativo ? "estilo_desativado" : "estilo_reativado", e.nome);
    return true;
  }, { perm: "catalogo:editar" });

  handle("chopes:list", async (p, ctx) => {
    let query = supabase.from("chopes").select("id, nome, estilo_id, ativo, estilos(nome)").order("nome");
    if (!wantsAll(p, ctx)) query = query.eq("ativo", true);
    return ok(await query).map(({ estilos, ...c }) => ({ ...c, ativo: b2i(c.ativo), estilo: estilos ? estilos.nome : null }));
  });

  handle("chopes:create", async ({ nome, estiloId }, ctx) => {
    const n = cleanCatalogName(nome, "chope");
    if (!Number(estiloId)) throw new AppError("Escolha o estilo do chope.");
    const e = await loadEstilo(estiloId);
    if (!e.ativo) throw new AppError(`O estilo "${e.nome}" está desativado. Escolha outro.`);
    await catalogNameTaken("chopes", "chope", n);
    const row = ok(
      await supabase.from("chopes").insert({ nome: n, estilo_id: e.id }).select("id, nome, estilo_id").single(),
      `Já existe um chope chamado "${n}".`
    );
    await audit(ctx, "chope_criado", `${n} (${e.nome})`);
    return { ...row, estilo: e.nome };
  });

  // Editar o chope atualiza chope_nome e estilo de todos os barris desse chope
  handle("chopes:update", async ({ id, nome, estiloId }, ctx) => {
    const c = await loadChope(id);
    const n = cleanCatalogName(nome, "chope");
    if (!Number(estiloId)) throw new AppError("Escolha o estilo do chope.");
    const e = await loadEstilo(estiloId);
    if (!e.ativo && e.id !== c.estilo_id) throw new AppError(`O estilo "${e.nome}" está desativado. Escolha outro.`);
    await catalogNameTaken("chopes", "chope", n, c.id);
    dbError(
      (await supabase.from("chopes").update({ nome: n, estilo_id: e.id }).eq("id", c.id)).error,
      `Já existe um chope chamado "${n}".`
    );
    dbError((await supabase.from("barris").update({ chope_nome: n, estilo: e.nome }).eq("chope_id", c.id)).error);
    const antes = `${c.nome} (${c.estilos ? c.estilos.nome : "?"})`;
    await audit(ctx, "chope_editado", `${antes} → ${n} (${e.nome})`);
    return true;
  }, { perm: "catalogo:editar" });

  handle("chopes:toggle", async ({ id }, ctx) => {
    const c = await loadChope(id);
    dbError((await supabase.from("chopes").update({ ativo: !c.ativo }).eq("id", c.id)).error);
    await audit(ctx, c.ativo ? "chope_desativado" : "chope_reativado", c.nome);
    return true;
  }, { perm: "catalogo:editar" });

  /* ======== Dashboard ======== */
  handle("dashboard:get", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    const stats = await rpc("fn_dashboard_stats_v2", { p_unit: unit });
    return { stats, movimentacoes: await queryMovements({ unitId: unit, limit: 8 }) };
  });

  /* Ordem: validade (vencidos primeiro), transferências pendentes, vazios aguardando recolhimento.
     nivel "erro" = barril vencido (a tela destaca em vermelho). */
  handle("alerts:list", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    const alerts = [];

    const hoje = hojeTZ();
    const validade = await rpc("fn_alertas_validade", { p_unit: unit, p_hoje: hoje });
    validade.forEach((b) => {
      const quem = `Barril #${b.codigo}${b.chope ? ` (${b.chope})` : ""}`;
      if (b.validade < hoje)
        alerts.push({ nivel: "erro", texto: `${quem} venceu em ${diaMes(b.validade)}. Confira se estava na câmara fria.` });
      else if (b.validade === hoje) alerts.push({ texto: `${quem} vence hoje.` });
      else alerts.push({ texto: `${quem} vence amanhã (${diaMes(b.validade)}).` });
    });

    const pend = ok(
      await supabase.from("transferencias")
        .select("id, origem_id, destino_id, barris(codigo), origem:unidades!origem_id(nome), destino:unidades!destino_id(nome)")
        .eq("status", "pendente")
        .or(`origem_id.eq.${unit},destino_id.eq.${unit}`)
    );
    pend.forEach((t) => {
      const codigo = t.barris ? t.barris.codigo : "?";
      alerts.push({
        texto:
          t.destino_id === unit
            ? `Barril #${codigo} vindo de ${t.origem.nome} aguardando seu recebimento.`
            : `Barril #${codigo} aguardando confirmação de ${t.destino.nome}.`,
      });
    });

    const vazios = await rpc("fn_alertas_vazios", { p_unit: unit });
    vazios.forEach((v) => alerts.push({ texto: `Barril #${v.codigo} vazio aguardando recolhimento há ${v.dias} dias` }));

    // Estoque baixo por chope (considera apenas tipos já presentes na unidade).
    const estoque = ok(await supabase.from("barris")
      .select("chope_id, chope_nome, estilo, status")
      .eq("unidade_id", unit)
      .neq("status", "recolhido")
      .limit(5000));
    const porChope = new Map();
    estoque.forEach((b) => {
      const chave = b.chope_id || `${b.chope_nome || ""}|${b.estilo || ""}`;
      const item = porChope.get(chave) || { nome: b.chope_nome || b.estilo || "Chope", disponiveis: 0 };
      if (b.status === "disponivel") item.disponiveis += 1;
      porChope.set(chave, item);
    });
    porChope.forEach((b) => {
      if (b.disponiveis <= 2) alerts.push({
        nivel: b.disponiveis === 0 ? "erro" : "aviso",
        texto: b.disponiveis === 0
          ? `Estoque baixo: nenhum barril disponível de ${b.nome} nesta unidade.`
          : `Estoque baixo: restam ${b.disponiveis} barris disponíveis de ${b.nome} nesta unidade.`,
      });
    });

    return alerts;
  });

  /* ======== Barris ======== */
  handle("barris:list", async ({ unitId, status, q }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    let query = supabase
      .from("barris")
      .select("*, unidades(nome_curto), engates(retirado_em, torneiras(numero))")
      .eq("unidade_id", unit)
      .order("codigo", { ascending: true })
      .limit(1000);
    // Recolhidos já voltaram para a fábrica: só aparecem quando o filtro pede por eles
    query = status ? query.eq("status", String(status)) : query.neq("status", "recolhido");
    const termo = cleanTerm(q);
    if (termo) query = query.or(`codigo.ilike.*${termo}*,estilo.ilike.*${termo}*,chope_nome.ilike.*${termo}*`);

    const data = ok(await query);
    const hoje = hojeTZ();
    return data.map(({ unidades, engates, ...b }) => {
      const ativo = (engates || []).find((e) => e.retirado_em === null);
      return {
        ...b,
        situacao_validade: situacaoValidade(b.validade, b.status, hoje),
        criado_em: fmtTs(b.criado_em),
        unidade: unidades ? unidades.nome_curto : null,
        torneira_numero: ativo && ativo.torneiras ? ativo.torneiras.numero : null,
      };
    });
  });

  handle("barris:exportStock", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    const rows = ok(await supabase.from("barris")
      .select("codigo, chope_nome, estilo, tamanho_l, validade, status, unidades(nome_curto), engates(retirado_em, torneiras(numero))")
      .eq("unidade_id", unit)
      .neq("status", "recolhido")
      .order("codigo", { ascending: true })
      .limit(5000));
    const labels = { disponivel: "Disponível", em_uso: "Em uso", em_transferencia: "Em transferência", esgotado: "Vazio" };
    const esc = (v) => {
      let t = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return `"${t.replace(/"/g, '""')}"`;
    };
    const header = ["Barril", "Chope", "Estilo", "Tamanho (L)", "Situação", "Validade", "Unidade", "Torneira"];
    const lines = rows.map((b) => {
      const engate = (b.engates || []).find((e) => e.retirado_em === null);
      return ["#" + b.codigo, b.chope_nome, b.estilo, b.tamanho_l, labels[b.status] || b.status, b.validade,
        b.unidades ? b.unidades.nome_curto : "", engate && engate.torneiras ? `Torneira ${engate.torneiras.numero}` : ""]
        .map(esc).join(";");
    });
    await audit(ctx, "relatorio_estoque_exportado", `${rows.length} barris`);
    return {
      filename: `relatorio-estoque-${hojeTZ()}.csv`,
      csv: "\uFEFF" + [header.map(esc).join(";"), ...lines].join("\r\n"),
      total: rows.length,
    };
  }, { perm: "exportar" });

  /* Entrada do barril: chope do catálogo + validade informada (olhando a data no barril).
     A fn_barril_entrada grava o barril (com barris.estilo = estilo do chope, usado no histórico e nas
     transferências), a movimentação e a auditoria numa única transação. */
  const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;
  const diaValido = (v) => DIA_RE.test(v) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;

  handle("barris:create", async ({ codigo, chopeId, tamanho, validade, unitId }, ctx) => {
    const cod = String(codigo || "").replace("#", "").trim().toUpperCase();
    const tam = Number(tamanho);
    if (!cod || !Number(chopeId) || !(tam > 0)) throw new AppError("Preencha código, chope e tamanho do barril.");
    const val = String(validade || "").trim();
    if (!val) throw new AppError("Informe a data de validade do barril.");
    if (!diaValido(val)) throw new AppError("Data de validade inválida.");
    if (val < hojeTZ()) throw new AppError("A validade não pode estar no passado");
    const unit = await resolveUnit(ctx, unitId);
    await assertUnit(ctx, unit);
    const id = await rpc("fn_barril_entrada", {
      p_codigo: cod, p_chope: Number(chopeId), p_tamanho: tam, p_validade: val, p_unidade: unit, p_usuario: ctx.session.id,
    });
    return { id: Number(id) };
  });

  /* Engate (início de uso): disponível → em uso, sempre em uma torneira livre da unidade do barril.
     A função SQL faz todas as verificações e gravações numa única transação. */
  /* Barril vencido: não engata sem confirmação (BARRIL_VENCIDO). Com confirmarVencido, engata e registra
     na auditoria. Nunca bloqueia: quem decide é a gerência. */
  handle("barris:use", async ({ id, torneiraId, unitId, confirmarVencido }, ctx) => {
    const b = await loadBarril(ctx, id); // barril existe + usuário tem acesso à unidade dele
    if (unitId && Number(unitId) !== b.unidade_id)
      throw new AppError(`O barril #${b.codigo} não pertence à unidade selecionada.`);
    const vencido = b.status === "disponivel" && situacaoValidade(b.validade, b.status) === "vencido";
    if (vencido && torneiraId && confirmarVencido !== true)
      throw new AppError(
        `Este barril venceu em ${diaMes(b.validade)}. Confira se ele estava armazenado na câmara fria. Engatar mesmo assim?`,
        "BARRIL_VENCIDO", null, { codigo: b.codigo, validade: b.validade }
      );

    if (!torneiraId) {
      if (b.status !== "disponivel")
        throw new AppError(`O barril #${b.codigo} não pode ser engatado: está "${STATUS_TEXTO[b.status]}". Só barris disponíveis podem ser engatados.`);
      const livres = (await tapsOfUnit(b.unidade_id)).filter((t) => t.ativo && !t.ocupada).length;
      throw new AppError(livres ? "Selecione a torneira em que o barril será engatado." : MSG_SEM_TORNEIRA);
    }
    const r = await rpc("fn_barril_engatar", { p_barril: b.id, p_torneira: Number(torneiraId), p_usuario: ctx.session.id });
    if (vencido) {
      const [ano, mes, dia] = b.validade.split("-");
      await audit(ctx, "engate_barril_vencido",
        `Barril #${b.codigo} (validade ${dia}/${mes}/${ano}) engatado vencido na Torneira ${r.torneira} (${r.unidade})`);
    }
    return r;
  });

  /* Retirada (o barril sai da torneira quando o chopp acaba): em uso → vazio (status esgotado).
     A torneira vem do engate registrado — nunca é escolhida pelo usuário — e é liberada aqui. */
  handle("barris:empty", async ({ id }, ctx) => {
    const b = await loadBarril(ctx, id);
    return rpc("fn_barril_esgotar", { p_barril: b.id, p_usuario: ctx.session.id });
  });

  /* Barris vazios da unidade para o recolhimento, com há quantos dias cada um está vazio */
  handle("barris:emptyList", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    const rows = ok(
      await supabase.from("barris")
        .select("id, codigo, estilo, chope_nome, tamanho_l, movimentacoes(operacao, criado_em)")
        .eq("unidade_id", unit).eq("status", "esgotado").order("codigo")
    );
    const agora = Date.now();
    return rows.map(({ movimentacoes, ...b }) => {
      const datas = (movimentacoes || []).map((m) => ({ op: m.operacao, t: new Date(m.criado_em).getTime() }));
      const vazio = datas.filter((m) => m.op === "esgotado");
      const desde = Math.max(...(vazio.length ? vazio : datas).map((m) => m.t), 0) || null;
      return { ...b, vazio_desde: desde ? fmtTs(desde) : null, dias: desde ? Math.floor((agora - desde) / 86400000) : null };
    });
  });

  /* Recolhimento: a fábrica leva os vasilhames vazios. Vários de uma vez, tudo ou nada (fn_barris_recolher).
     Se o mesmo vasilhame voltar, é um cadastro novo com o mesmo código. */
  handle("barris:collect", async ({ ids, unitId }, ctx) => {
    const lista = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!lista.length) throw new AppError("Marque ao menos um barril para registrar o recolhimento.");
    if (lista.length > 500) throw new AppError("Recolhimento grande demais de uma vez. Divida em partes.");
    const unit = await resolveUnit(ctx, unitId);
    await assertUnit(ctx, unit);
    const codigos = await rpc("fn_barris_recolher", { p_barris: lista, p_unidade: unit, p_usuario: ctx.session.id });
    return { codigos };
  });

  /* ======== Transferências ======== */
  handle("transfer:list", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    const rows = ok(
      await supabase.from("transferencias")
        .select(
          "*, barris(codigo, estilo, chope_nome), origem:unidades!origem_id(nome_curto), destino:unidades!destino_id(nome_curto)," +
          " solicitante:usuarios!solicitante_id(nome), recebedor:usuarios!recebedor_id(nome)"
        )
        .or(`origem_id.eq.${unit},destino_id.eq.${unit}`)
        .order("id", { ascending: false })
        .limit(100)
    );
    return rows.map(({ barris, origem, destino, solicitante, recebedor, ...t }) => ({
      ...t,
      criado_em: fmtTs(t.criado_em),
      resolvido_em: fmtTs(t.resolvido_em),
      codigo: barris ? barris.codigo : null,
      estilo: barris ? barris.estilo : null,
      chope_nome: barris ? barris.chope_nome : null,
      origem: origem ? origem.nome_curto : null,
      destino: destino ? destino.nome_curto : null,
      solicitante: solicitante ? solicitante.nome : null,
      recebedor: recebedor ? recebedor.nome : null,
    }));
  });

  handle("transfer:create", async ({ barrilId, destinoId }, ctx) => {
    const b = await loadBarril(ctx, barrilId);
    return rpc("fn_transferencia_criar", { p_barril: b.id, p_destino: Number(destinoId) || null, p_usuario: ctx.session.id });
  });

  const loadTransfer = async (id) => {
    const r = await supabase.from("transferencias").select("*").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    if (!r.data || r.data.status !== "pendente") throw new AppError("Transferência não está pendente.");
    return r.data;
  };

  handle("transfer:confirm", async ({ id }, ctx) => {
    const t = await loadTransfer(id);
    await assertUnit(ctx, t.destino_id); // quem recebe é quem confirma
    return rpc("fn_transferencia_confirmar", { p_id: t.id, p_usuario: ctx.session.id });
  });

  handle("transfer:cancel", async ({ id }, ctx) => {
    const t = await loadTransfer(id);
    await assertUnit(ctx, t.origem_id); // quem enviou é quem cancela
    return rpc("fn_transferencia_cancelar", { p_id: t.id, p_usuario: ctx.session.id });
  });

  /* ======== Histórico e relatórios ======== */
  handle("history:list", async ({ unitId, q, operacao }, ctx) =>
    queryMovements({ unitId: await resolveUnit(ctx, unitId), q, operacao, limit: 300 })
  );

  handle("history:export", async ({ unitId, q, operacao }, ctx) => {
    const rows = await queryMovements({ unitId: await resolveUnit(ctx, unitId), q, operacao });
    const labels = { entrada: "Entrada", transferencia: "Transferência", utilizacao: "Utilização", esgotado: "Vazio", recolhimento: "Recolhimento" };
    // Células que começam com = + - @ viram texto (evita que o Excel execute fórmulas digitadas por usuários)
    const esc = (v) => {
      let t = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return `"${t.replace(/"/g, '""')}"`;
    };
    const header = ["Data/Hora", "Barril", "Chope", "Estilo", "Operação", "Origem", "Destino", "Torneira", "Responsável", "Observação"];
    const lines = rows.map((r) =>
      [r.criado_em, "#" + r.codigo, r.chope_nome || "", r.estilo, labels[r.operacao], r.origem || FORNECEDOR, r.destino || "",
       r.torneira_numero ? `Torneira ${r.torneira_numero}` : "", r.responsavel, r.observacao]
        .map(esc)
        .join(";")
    );
    const csv = "\uFEFF" + [header.map(esc).join(";"), ...lines].join("\r\n"); // BOM p/ Excel abrir com acentos

    await audit(ctx, "relatorio_exportado", `${rows.length} movimentações`);
    const dia = new Date().toISOString().slice(0, 10);
    return { filename: `relatorio-movimentacoes-${dia}.csv`, csv, total: rows.length };
  }, { perm: "exportar" });

  /* Relatório de barris: uso por estilo e chope num período, mais a situação agora.
     Cada linha de barris é um ciclo (o código se repete depois do recolhimento), por isso o banco conta por barris.id.
     unidadeId vazio = todas as unidades liberadas para o usuário. */
  async function reportUnits(ctx, unidadeId) {
    const allowed = await allowedUnitIds(ctx);
    if (!allowed.length)
      throw new AppError("Você ainda não tem acesso a nenhuma unidade. Peça a um administrador para liberar.");
    if (unidadeId === null || unidadeId === undefined || unidadeId === "")
      return { ids: allowed, nome: "Todas as minhas unidades", slug: "todas" };
    const id = Number(unidadeId);
    if (!allowed.includes(id)) throw new AppError("Você não tem acesso a esta unidade.", "FORBIDDEN", `unidade ${unidadeId}`);
    const u = ok(await supabase.from("unidades").select("nome_curto").eq("id", id).maybeSingle());
    const nome = u ? u.nome_curto : `Unidade ${id}`;
    const slug = nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return { ids: [id], nome, slug: slug || `unidade-${id}` };
  }

  // De e Até contam inteiros, no fuso da operação: do começo de De ao começo do dia seguinte a Até
  function reportPeriod(de, ate) {
    if (!diaValido(String(de || "")) || !diaValido(String(ate || ""))) throw new AppError("Informe as datas De e Até do período.");
    if (de > ate) throw new AppError("A data De não pode ser depois da data Até.");
    const dias = (Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86400000 + 1;
    if (dias > 400) throw new AppError("Escolha um período de até 400 dias.");
    return { de, ate, inicio: inicioDoDia(de).toISOString(), fim: inicioDoDia(somaDias(ate, 1)).toISOString() };
  }

  // Sem o SQL do relatório no banco, o PostgREST responde PGRST202 (função não encontrada)
  async function rpcRelatorio(fn, args) {
    const { data, error } = await supabase.rpc(fn, args);
    if (error && error.code === "PGRST202")
      throw new AppError("O relatório de barris ainda não foi instalado no banco. Peça para rodar o SQL do relatório no Supabase.");
    dbError(error);
    return data;
  }

  const REL_NUMS = ["recebidos", "utilizados", "litros", "esvaziados", "recolhidos", "estoque", "engatados", "vazios", "em_transferencia"];
  const relNums = (src) => Object.fromEntries(REL_NUMS.map((k) => [k, Number(src ? src[k] : 0) || 0]));

  // Linhas do banco (uma por chope) agrupadas por estilo; "Pilsen" de barril antigo cai no mesmo grupo do "Pilsen" do catálogo
  function agruparPorEstilo(linhas) {
    const grupos = new Map();
    for (const l of linhas) {
      const chave = l.estilo.toLocaleLowerCase("pt-BR");
      if (!grupos.has(chave)) grupos.set(chave, { estilo: l.estilo, chopes: [], total: relNums() });
      const g = grupos.get(chave);
      const nums = relNums(l);
      g.chopes.push({
        chope: l.chope || "Chope não informado",
        // Chave para abrir o detalhe: o chope do catálogo ou, no barril antigo, os textos gravados nele
        chave: l.chope_id ? { chopeId: l.chope_id } : { estilo: l.estilo_chave || "", chope: l.chope_chave || "" },
        ...nums,
      });
      for (const k of REL_NUMS) g.total[k] += nums[k];
    }
    return [...grupos.values()];
  }

  async function relatorioBarris(ctx, { unidadeId, de, ate }) {
    const periodo = reportPeriod(de, ate);
    const unidade = await reportUnits(ctx, unidadeId);
    const r = await rpcRelatorio("fn_relatorio_barris", { p_unidades: unidade.ids, p_de: periodo.inicio, p_ate: periodo.fim });
    return {
      de: periodo.de, ate: periodo.ate,
      unidade: unidade.nome, slug: unidade.slug,
      geradoEm: fmtTs(r.gerado_em),
      grupos: agruparPorEstilo(r.linhas || []),
      total: relNums(r.totais),
    };
  }

  handle("reports:barrels", async (p, ctx) => {
    const { slug, ...rel } = await relatorioBarris(ctx, p || {});
    return rel;
  });

  handle("reports:barrelsDetail", async (p, ctx) => {
    const { unidadeId, chopeId, estilo, chope, de, ate } = p || {};
    const periodo = reportPeriod(de, ate);
    const unidade = await reportUnits(ctx, unidadeId);
    const id = Number(chopeId) || null;
    const rows = await rpcRelatorio("fn_relatorio_barris_detalhe", {
      p_unidades: unidade.ids, p_de: periodo.inicio, p_ate: periodo.fim,
      p_chope: id, p_estilo: id ? null : String(estilo ?? "").trim(), p_chope_nome: id ? null : String(chope ?? "").trim(),
    });
    return (rows || []).map((b) => ({
      id: b.id, codigo: b.codigo, tamanho_l: b.tamanho_l, validade: b.validade,
      engatado_em: fmtTs(b.engatado_em), retirado_em: fmtTs(b.retirado_em),
      torneira: b.torneira, unidade: b.unidade,
    }));
  });

  handle("reports:barrelsExport", async (p, ctx) => {
    const rel = await relatorioBarris(ctx, p || {});
    const esc = (v) => {
      let t = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return `"${t.replace(/"/g, '""')}"`;
    };
    const num = (n) => String(n).replace(".", ","); // litros com vírgula, como o Excel em português espera
    const linha = (estilo, chope, n) => [estilo, chope, n.recebidos, n.utilizados, num(n.litros), n.esvaziados, n.recolhidos,
      n.estoque, n.engatados, n.vazios, n.em_transferencia].map(esc).join(";");
    const header = ["Estilo", "Chope", "Recebidos", "Utilizados", "Litros utilizados", "Esvaziados", "Recolhidos",
      "Em estoque agora", "Engatados agora", "Vazios aguardando recolhimento", "Em transferência agora"];
    const lines = [];
    for (const g of rel.grupos) {
      for (const c of g.chopes) lines.push(linha(g.estilo, c.chope, c));
      lines.push(linha(g.estilo, `Total ${g.estilo}`, g.total));
    }
    lines.push(linha("Total geral", "", rel.total));
    const br = (dia) => dia.split("-").reverse().join("/");
    lines.push("", ["Período", `${br(rel.de)} a ${br(rel.ate)}`].map(esc).join(";"),
      ["Unidade", rel.unidade].map(esc).join(";"),
      ["Situação agora em", rel.geradoEm ? `${br(rel.geradoEm.slice(0, 10))} ${rel.geradoEm.slice(11, 16)}` : ""].map(esc).join(";"),
      esc("Utilizado = barril engatado pela primeira vez dentro do período."));
    await audit(ctx, "relatorio_barris_exportado", `${rel.unidade}, ${br(rel.de)} a ${br(rel.ate)}`);
    return {
      filename: `relatorio-barris-${rel.slug}-${rel.de}-a-${rel.ate}.csv`,
      csv: "﻿" + [header.map(esc).join(";"), ...lines].join("\r\n"),
      total: rel.grupos.reduce((s, g) => s + g.chopes.length, 0),
    };
  }, { perm: "exportar" });

  handle("audit:list", async () => {
    const rows = ok(
      await supabase.from("auditoria").select("id, acao, detalhe, criado_em, usuarios(nome)").order("id", { ascending: false }).limit(300)
    );
    return rows.map((a) => ({
      id: a.id, acao: a.acao, detalhe: a.detalhe, criado_em: fmtTs(a.criado_em), usuario: a.usuarios ? a.usuarios.nome : "—",
    }));
  }, { perm: "auditoria" });

  /* ======== Usuários (somente administrador) ======== */
  const CARGOS = Object.keys(CARGO_LABEL);
  const cleanUnitIds = async (ids, cargo = "operador") => {
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean))];
    if (!list.length) throw new AppError(`Escolha ao menos uma unidade para o ${cargo === "gerente" ? "gerente" : "operador"}.`);
    const valid = ok(await supabase.from("unidades").select("id").eq("ativo", true)).map((r) => r.id);
    if (list.some((id) => !valid.includes(id))) throw new AppError("Unidade inválida ou desativada.");
    return list;
  };
  const loadUser = async (id) => {
    const u = await getUserById(Number(id));
    if (!u) throw new AppError("Usuário não encontrado.");
    return u;
  };
  // Existe outro administrador ativo além deste? (o sistema nunca fica sem nenhum)
  const outroAdminAtivo = async (exceptId) =>
    ok(await supabase.from("usuarios").select("id").eq("cargo", "admin").eq("ativo", true).neq("id", exceptId).limit(1)).length > 0;
  const ultimoAdmin = async (u) => u.cargo === "admin" && u.ativo && !(await outroAdminAtivo(u.id));
  // Troca as unidades liberadas: primeiro adiciona as novas, depois remove as que saíram (nunca fica sem acesso no meio do caminho)
  const gravarUnidades = async (usuarioId, units) => {
    dbError(
      (await supabase.from("usuario_unidades")
        .upsert(units.map((uid) => ({ usuario_id: usuarioId, unidade_id: uid })), { onConflict: "usuario_id,unidade_id", ignoreDuplicates: true })).error
    );
    dbError(
      (await supabase.from("usuario_unidades").delete().eq("usuario_id", usuarioId).not("unidade_id", "in", `(${units.join(",")})`)).error
    );
  };

  handle("users:list", async () => {
    const access = ok(await supabase.from("usuario_unidades").select("usuario_id, unidades(id, nome_curto)"))
      .filter((a) => a.unidades)
      .sort((a, b) => a.unidades.id - b.unidades.id);
    const users = ok(
      await supabase.from("usuarios")
        .select("id, nome, email, usuario, cargo, ativo, trocar_senha, bloqueado_ate, ultimo_login")
        .order("nome")
    );
    return users.map((u) => ({
      ...u,
      ativo: b2i(u.ativo),
      trocar_senha: b2i(u.trocar_senha),
      ultimo_login: fmtTs(u.ultimo_login),
      bloqueado: (Number(u.bloqueado_ate) || 0) > Date.now(),
      unidadeIds: access.filter((a) => a.usuario_id === u.id).map((a) => a.unidades.id),
      unidades: access.filter((a) => a.usuario_id === u.id).map((a) => a.unidades.nome_curto),
    }));
  }, { perm: "usuarios" });

  /* Cria o usuário com uma senha temporária aleatória, exibida uma única vez ao administrador */
  handle("users:create", async ({ nome, email, cargo, unidadeIds }, ctx) => {
    const name = String(nome || "").trim();
    if (!name) throw new AppError("Informe o nome.");
    const em = normalizeEmail(email);
    if (!CARGOS.includes(cargo)) throw new AppError("Cargo inválido.");
    const units = cargo === "admin" ? [] : await cleanUnitIds(unidadeIds, cargo);
    if (await emailTaken(em)) throw new AppError(`O e-mail ${em} já está cadastrado.`);

    const senha = generateTempPassword();
    const novo = ok(
      await supabase.from("usuarios")
        .insert({ nome: name, usuario: em, email: em, senha_hash: await hashPassword(senha), cargo, trocar_senha: true })
        .select("id").single(),
      `O e-mail ${em} já está cadastrado.`
    );
    if (units.length) {
      const r = await supabase.from("usuario_unidades").insert(units.map((uid) => ({ usuario_id: novo.id, unidade_id: uid })));
      if (r.error) {
        await supabase.from("usuarios").delete().eq("id", novo.id); // desfaz: não deixa usuário sem acesso pela metade
        dbError(r.error);
      }
    }
    await audit(ctx, "usuario_criado", `${em} (${cargo})`);
    return { email: em, senha };
  }, { perm: "usuarios" });

  /* Altera a quais quiosques o gerente ou operador tem acesso */
  handle("users:setUnits", async ({ id, unidadeIds }, ctx) => {
    const u = await loadUser(id);
    if (u.cargo === "admin") throw new AppError("Administradores têm acesso a todas as unidades.");
    const units = await cleanUnitIds(unidadeIds, u.cargo);
    await gravarUnidades(u.id, units);
    recarregarSessoes(u.id);
    await audit(ctx, "acesso_alterado", `${u.email || u.usuario}: unidades ${units.join(", ")}`);
    return true;
  }, { perm: "usuarios" });

  handle("users:resetPassword", async ({ id }, ctx) => {
    const u = await loadUser(id);
    const senha = generateTempPassword();
    dbError(
      (await supabase.from("usuarios")
        .update({ senha_hash: await hashPassword(senha), trocar_senha: true, falhas: 0, bloqueado_ate: null }).eq("id", u.id)).error
    );
    await encerrarSessoes(u.id); // a pessoa sai de todos os aparelhos e entra de novo com a senha temporária
    await audit(ctx, "senha_temporaria_gerada", u.email || u.usuario);
    return { email: u.email || u.usuario, senha };
  }, { perm: "usuarios" });

  handle("users:unlock", async ({ id }, ctx) => {
    const u = await loadUser(id);
    dbError((await supabase.from("usuarios").update({ falhas: 0, bloqueado_ate: null }).eq("id", u.id)).error);
    await audit(ctx, "usuario_desbloqueado", u.email || u.usuario);
    return true;
  }, { perm: "usuarios" });

  handle("users:toggle", async ({ id }, ctx) => {
    if (Number(id) === ctx.session.id) throw new AppError("Você não pode desativar o seu próprio usuário.");
    const u = await loadUser(id);
    if (await ultimoAdmin(u)) throw new AppError("Não é possível desativar o último administrador ativo.");
    dbError((await supabase.from("usuarios").update({ ativo: !u.ativo }).eq("id", u.id)).error);
    if (u.ativo) await encerrarSessoes(u.id); // desativado: a próxima ação dele leva ao login
    await audit(ctx, u.ativo ? "usuario_desativado" : "usuario_ativado", u.email || u.usuario);
    return true;
  }, { perm: "usuarios" });

  /* Troca o cargo. Gerente e operador precisam de ao menos uma unidade; administrador vê todas (a lista sai). */
  handle("users:setRole", async ({ id, cargo, unidadeIds }, ctx) => {
    if (Number(id) === ctx.session.id) throw new AppError("Você não pode alterar o seu próprio cargo.");
    if (!CARGOS.includes(cargo)) throw new AppError("Cargo inválido.");
    const u = await loadUser(id);
    if (u.cargo === cargo) throw new AppError(`${u.nome} já é ${CARGO_LABEL[cargo]}. Escolha outro cargo.`);
    if (await ultimoAdmin(u)) throw new AppError("Não é possível tirar o cargo do último administrador ativo.");
    const units = cargo === "admin" ? [] : await cleanUnitIds(unidadeIds, cargo);
    if (units.length) await gravarUnidades(u.id, units);
    dbError((await supabase.from("usuarios").update({ cargo }).eq("id", u.id)).error);
    if (!units.length) dbError((await supabase.from("usuario_unidades").delete().eq("usuario_id", u.id)).error);
    recarregarSessoes(u.id); // a próxima chamada da pessoa já usa o cargo novo
    const extra = units.length ? `, unidades ${units.join(", ")}` : "";
    await audit(ctx, "cargo_alterado", `${u.email || u.usuario}: ${CARGO_LABEL[u.cargo]} → ${CARGO_LABEL[cargo]}${extra}`);
    return true;
  }, { perm: "usuarios" });

  /* Antes de apagar: quanto histórico a pessoa tem e para quem ele pode passar */
  const contar = async (tabela, filtro) => {
    const r = await filtro(supabase.from(tabela).select("id", { count: "exact", head: true }));
    dbError(r.error);
    return r.count || 0;
  };
  handle("users:deletePreview", async ({ id }, ctx) => {
    if (Number(id) === ctx.session.id) throw new AppError("Você não pode apagar o seu próprio usuário.");
    const u = await loadUser(id);
    if (await ultimoAdmin(u)) throw new AppError("Não é possível apagar o último administrador ativo.");
    const engates = await contar("engates", (q) => q.or(`engatado_por.eq.${u.id},retirado_por.eq.${u.id}`));
    const movimentacoes = await contar("movimentacoes", (q) => q.eq("usuario_id", u.id));
    const transferencias = await contar("transferencias", (q) => q.or(`solicitante_id.eq.${u.id},recebedor_id.eq.${u.id}`));
    const outros = ok(await supabase.from("usuarios").select("id, nome, email, usuario, ativo").neq("id", u.id).order("nome"));
    return {
      usuario: { id: u.id, nome: u.nome, email: u.email || u.usuario },
      engates, movimentacoes, transferencias, total: engates + movimentacoes + transferencias,
      outros: outros.map((o) => ({ id: o.id, nome: o.nome, email: o.email || o.usuario, ativo: b2i(o.ativo) })),
    };
  }, { perm: "usuarios" });

  /* Apaga de vez (fn_usuario_apagar: tudo ou nada). Com histórico, só passando o histórico para outro usuário (destinoId). */
  handle("users:delete", async ({ id, destinoId }, ctx) => {
    const u = await loadUser(id);
    const destino = Number(destinoId) || null;
    const r = await rpc("fn_usuario_apagar", { p_usuario: u.id, p_destino: destino, p_admin: ctx.session.id });
    recarregarSessoes(u.id); // as sessões saíram do banco junto com o usuário; aqui sai o cache
    let detalhe = u.email || u.usuario;
    if (destino && r.total > 0) {
      const d = await getUserById(destino);
      detalhe += `, histórico passado para ${d ? d.email || d.usuario : `usuário ${destino}`} (${r.total} registros)`;
    }
    await audit(ctx, "usuario_apagado", detalhe);
    return r;
  }, { perm: "usuarios" });
}

module.exports = { registerHandlers, dispatch };
