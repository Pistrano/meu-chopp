/* ==========================================================
   MeuChopp — regras de negócio (API do servidor) — versão Supabase
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

const handlers = new Map();   // canal -> { fn, auth, admin }
const sessions = new Map();   // token -> { user, lastActivity }

const CARGO_LABEL = { admin: "Administrador", operador: "Operador" };

/* ---------- Infraestrutura ---------- */
const IDLE_MS = 15 * 60 * 1000;          // sessão expira após 15 min sem atividade
const MAX_FALHAS = 5;                     // tentativas erradas antes de bloquear
const BLOQUEIO_MS = 15 * 60 * 1000;       // duração do bloqueio
const PERMITIDOS_TROCA = new Set(["auth:me", "auth:logout", "auth:ping", "auth:completeProfile"]);

// Fuso usado para mostrar datas (troque com APP_TIMEZONE no .env se precisar)
const TZ = process.env.APP_TIMEZONE || "America/Cuiaba";
const tsFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const fmtTs = (v) => (v ? tsFmt.format(new Date(v)) : null); // "AAAA-MM-DD HH:MM:SS"
const b2i = (v) => (v ? 1 : 0);

class AppError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.appCode = code;
    this.detail = detail;
  }
}

function handle(channel, fn, { auth = true, admin = false } = {}) {
  handlers.set(channel, { fn, auth, admin });
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

/* Executa uma operação para o aparelho identificado por `token` (cookie de sessão).
   Retorna { body, setToken?, clearToken? }. */
async function dispatch(channel, payload, token, meta = {}) {
  const entry = handlers.get(channel);
  if (!entry) return { body: { ok: false, error: "Operação desconhecida.", code: "NOT_FOUND" } };
  const { fn, auth, admin } = entry;
  let rec = token ? sessions.get(token) : null;
  const ctx = { session: rec ? rec.user : null, sessionAction: null, clientIp: meta.ip || "" };

  let body;
  try {
    if (channel === "auth:login" && ipBlocked(ctx.clientIp))
      throw new AppError("Muitas tentativas deste aparelho. Aguarde alguns minutos.");
    if (auth) {
      if (rec && Date.now() - rec.lastActivity > IDLE_MS) {
        await audit(ctx, "sessao_expirada", "Encerrada por inatividade");
        sessions.delete(token);
        rec = null;
        ctx.session = null;
        throw new AppError("Sua sessão expirou por inatividade. Entre novamente.", "SESSION");
      }
      if (!rec) throw new AppError("Sessão expirada. Faça login novamente.", "SESSION");
      if (ctx.session.trocarSenha && !PERMITIDOS_TROCA.has(channel))
        throw new AppError("Defina sua senha para continuar.", "MUST_CHANGE");
      rec.lastActivity = Date.now();
    }
    if (admin && ctx.session.cargo !== "admin") throw new AppError("Apenas administradores podem executar esta ação.");
    const data = await fn(payload || {}, ctx);
    body = { ok: true, data };
  } catch (err) {
    if (err && err.appCode === "FORBIDDEN" && ctx.session) {
      await audit(ctx, "acesso_negado", `${channel}: ${err.detail || err.message}`).catch(() => {});
    }
    if (err instanceof AppError) {
      body = { ok: false, error: err.message, code: err.appCode };   // erro de regra: mensagem para o usuário
    } else {
      console.error(`[erro] ${channel}:`, err);                       // falha técnica: detalhe só no servidor
      body = { ok: false, error: "Erro inesperado. Tente novamente." };
    }
  }

  const out = { body };
  if (ctx.sessionAction === "end") {
    if (token) sessions.delete(token);
    out.clearToken = true;
  } else if (ctx.sessionAction === "start" && body.ok) {
    if (token) sessions.delete(token); // novo token a cada login (evita fixação de sessão)
    const novo = crypto.randomBytes(32).toString("hex");
    sessions.set(novo, { user: ctx.session, lastActivity: Date.now() });
    out.setToken = novo;
  }
  if (channel === "auth:login") {
    if (body.ok) ipFails.delete(ctx.clientIp);
    else ipFail(ctx.clientIp);
  }
  return out;
}

/* Limpa sessões esquecidas */
setInterval(() => {
  const limite = Date.now() - IDLE_MS;
  for (const [t, r] of sessions) if (r.lastActivity < limite) sessions.delete(t);
}, 5 * 60 * 1000).unref();

/* ---------- Segurança de senhas e e-mails ---------- */
const hashPassword = (pw) => bcrypt.hash(String(pw), 12);
const SENHAS_COMUNS = new Set([
  "12345678", "123456789", "1234567890", "11111111", "password", "password1", "senha123", "senha1234",
  "admin123", "admin1234", "qwerty123", "abc12345", "chopp123", "meuchopp1", "meuchopp123",
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

const STATUS_TEXTO = { disponivel: "Disponível", em_uso: "Em uso", em_transferencia: "Em transferência", esgotado: "Chopp Esgotado" };
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
  "id, unidade_id, numero, ativo, engates(id, barril_id, engatado_em, retirado_em, barris(codigo, estilo, chope_nome, tamanho_l), usuarios!engatado_por(nome))";

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
   Operador: somente os quiosques que um administrador liberou para ele. */
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
      throw new AppError("Não foi possível acessar o banco de dados. Verifique a configuração do Supabase (.env e schema.sql).");
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

    if (!dummyHash) dummyHash = await hashPassword("senha-ficticia-meuchopp");
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
  }, { admin: true });

  /* Detalhes de uma unidade + suas torneiras (tela Unidades) */
  handle("units:details", async ({ id }) => {
    const r = await supabase.from("unidades").select("id, nome, nome_curto, ativo, cnpj, endereco").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    if (!r.data) throw new AppError("Unidade não encontrada.");
    const u = r.data;
    return { ...u, ativo: b2i(u.ativo), cnpjFormatado: formatCnpj(u.cnpj), torneiras: await tapsOfUnit(u.id) };
  }, { admin: true });

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
  }, { admin: true });

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
  }, { admin: true });

  handle("units:toggle", async ({ id }, ctx) => {
    const r = await supabase.from("unidades").select("*").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    const u = r.data;
    if (!u) throw new AppError("Unidade não encontrada.");
    if (u.ativo) {
      const a = await supabase.from("barris").select("id", { count: "exact", head: true }).eq("unidade_id", u.id).neq("status", "esgotado");
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
  }, { admin: true });

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
  }, { admin: true });

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
  }, { admin: true });

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
  }, { admin: true });

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
      barril: { id: b.id, codigo: b.codigo, estilo: b.estilo, chope_nome: b.chope_nome || null, status: b.status },
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
        codigo: t.ocupada ? t.codigo : null,
        chope_nome: t.ocupada ? t.chope_nome : null,
        estilo: t.ocupada ? t.estilo : null,
        tamanho_l: t.ocupada ? t.tamanho_l : null,
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
     Editar e desativar: só administrador. Nada é apagado: barris antigos continuam apontando para o chope. */
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
  const wantsAll = (p, ctx) => !!p.todos && ctx.session.cargo === "admin";

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
  }, { admin: true });

  handle("estilos:toggle", async ({ id }, ctx) => {
    const e = await loadEstilo(id);
    dbError((await supabase.from("estilos").update({ ativo: !e.ativo }).eq("id", e.id)).error);
    await audit(ctx, e.ativo ? "estilo_desativado" : "estilo_reativado", e.nome);
    return true;
  }, { admin: true });

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
  }, { admin: true });

  handle("chopes:toggle", async ({ id }, ctx) => {
    const c = await loadChope(id);
    dbError((await supabase.from("chopes").update({ ativo: !c.ativo }).eq("id", c.id)).error);
    await audit(ctx, c.ativo ? "chope_desativado" : "chope_reativado", c.nome);
    return true;
  }, { admin: true });

  /* ======== Dashboard ======== */
  handle("dashboard:get", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    const stats = await rpc("fn_dashboard_stats", { p_unit: unit });
    return { stats, movimentacoes: await queryMovements({ unitId: unit, limit: 8 }) };
  });

  handle("alerts:list", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    const alerts = [];

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

    const parados = await rpc("fn_alertas_esgotados", { p_unit: unit });
    parados.forEach((codigo) => alerts.push({ texto: `Barril #${codigo} esgotado há mais de 3 dias sem atualização.` }));

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
    if (status) query = query.eq("status", String(status));
    const termo = cleanTerm(q);
    if (termo) query = query.or(`codigo.ilike.*${termo}*,estilo.ilike.*${termo}*,chope_nome.ilike.*${termo}*`);

    const data = ok(await query);
    return data.map(({ unidades, engates, ...b }) => {
      const ativo = (engates || []).find((e) => e.retirado_em === null);
      return {
        ...b,
        criado_em: fmtTs(b.criado_em),
        unidade: unidades ? unidades.nome_curto : null,
        torneira_numero: ativo && ativo.torneiras ? ativo.torneiras.numero : null,
      };
    });
  });

  /* O barril é cadastrado com um chope do catálogo. barris.estilo continua sendo gravada
     (com o estilo do chope) porque o histórico, as transferências e as funções fn_* usam essa coluna. */
  handle("barris:create", async ({ codigo, chopeId, tamanho, unitId }, ctx) => {
    const cod = String(codigo || "").replace("#", "").trim().toUpperCase();
    const tam = Number(tamanho);
    if (!cod || !Number(chopeId) || !(tam > 0)) throw new AppError("Preencha código, chope e tamanho do barril.");
    const unit = await resolveUnit(ctx, unitId);
    await assertUnit(ctx, unit);
    const r = await supabase.from("chopes").select("id, nome, ativo, estilos(nome)").eq("id", Number(chopeId)).maybeSingle();
    dbError(r.error);
    const chope = r.data;
    if (!chope) throw new AppError("Chope não encontrado. Recarregue a página e escolha de novo.");
    if (!chope.ativo) throw new AppError(`O chope "${chope.nome}" está desativado. Escolha outro.`);
    if (!chope.estilos) throw new AppError(`O chope "${chope.nome}" está sem estilo. Peça a um administrador para corrigir.`);

    const ret = await rpc("fn_barril_criar", {
      p_codigo: cod, p_estilo: chope.estilos.nome, p_tamanho: tam, p_unidade: unit, p_usuario: ctx.session.id,
    });
    const id = Number(ret && typeof ret === "object" ? ret.id : ret);
    const upd = id ? await supabase.from("barris").update({ chope_id: chope.id, chope_nome: chope.nome }).eq("id", id).select("id") : {};
    if (!id || upd.error || !upd.data || !upd.data.length) {
      console.error("[barris:create] barril criado sem chope", { id, chope: chope.id, error: upd.error });
      throw new AppError(
        `O barril #${cod} foi cadastrado, mas não foi possível ligá-lo ao chope "${chope.nome}". ` +
        "Ele aparece na lista só com o estilo. Avise o administrador."
      );
    }
    return { id };
  });

  /* Engate (início de uso): disponível → em uso, sempre em uma torneira livre da unidade do barril.
     A função SQL faz todas as verificações e gravações numa única transação. */
  handle("barris:use", async ({ id, torneiraId, unitId }, ctx) => {
    const b = await loadBarril(ctx, id); // barril existe + usuário tem acesso à unidade dele
    if (unitId && Number(unitId) !== b.unidade_id)
      throw new AppError(`O barril #${b.codigo} não pertence à unidade selecionada.`);

    if (!torneiraId) {
      if (b.status !== "disponivel")
        throw new AppError(`O barril #${b.codigo} não pode ser engatado: está "${STATUS_TEXTO[b.status]}". Só barris disponíveis podem ser engatados.`);
      const livres = (await tapsOfUnit(b.unidade_id)).filter((t) => t.ativo && !t.ocupada).length;
      throw new AppError(livres ? "Selecione a torneira em que o barril será engatado." : MSG_SEM_TORNEIRA);
    }
    return rpc("fn_barril_engatar", { p_barril: b.id, p_torneira: Number(torneiraId), p_usuario: ctx.session.id });
  });

  /* Retirada (o barril sai da torneira quando o chopp esgota): em uso → esgotado.
     A torneira vem do engate registrado — nunca é escolhida pelo usuário — e é liberada aqui. */
  handle("barris:empty", async ({ id }, ctx) => {
    const b = await loadBarril(ctx, id);
    return rpc("fn_barril_esgotar", { p_barril: b.id, p_usuario: ctx.session.id });
  });

  handle("barris:refill", async ({ id }, ctx) => {
    const b = await loadBarril(ctx, id);
    return rpc("fn_barril_reabastecer", { p_barril: b.id, p_usuario: ctx.session.id });
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
    const labels = { entrada: "Entrada", transferencia: "Transferência", utilizacao: "Utilização", esgotado: "Chopp Esgotado" };
    // Células que começam com = + - @ viram texto (evita que o Excel execute fórmulas digitadas por usuários)
    const esc = (v) => {
      let t = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return `"${t.replace(/"/g, '""')}"`;
    };
    const header = ["Data/Hora", "Barril", "Chope", "Estilo", "Operação", "Origem", "Destino", "Torneira", "Responsável", "Observação"];
    const lines = rows.map((r) =>
      [r.criado_em, "#" + r.codigo, r.chope_nome || "", r.estilo, labels[r.operacao], r.origem || "Fábrica", r.destino || "",
       r.torneira_numero ? `Torneira ${r.torneira_numero}` : "", r.responsavel, r.observacao]
        .map(esc)
        .join(";")
    );
    const csv = "\uFEFF" + [header.map(esc).join(";"), ...lines].join("\r\n"); // BOM p/ Excel abrir com acentos

    await audit(ctx, "relatorio_exportado", `${rows.length} movimentações`);
    const dia = new Date().toISOString().slice(0, 10);
    return { filename: `relatorio-movimentacoes-${dia}.csv`, csv, total: rows.length };
  });

  handle("audit:list", async () => {
    const rows = ok(
      await supabase.from("auditoria").select("id, acao, detalhe, criado_em, usuarios(nome)").order("id", { ascending: false }).limit(300)
    );
    return rows.map((a) => ({
      id: a.id, acao: a.acao, detalhe: a.detalhe, criado_em: fmtTs(a.criado_em), usuario: a.usuarios ? a.usuarios.nome : "—",
    }));
  }, { admin: true });

  /* ======== Usuários (somente administrador) ======== */
  const cleanUnitIds = async (ids) => {
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean))];
    if (!list.length) throw new AppError("Escolha ao menos uma unidade para o operador.");
    const valid = ok(await supabase.from("unidades").select("id").eq("ativo", true)).map((r) => r.id);
    if (list.some((id) => !valid.includes(id))) throw new AppError("Unidade inválida ou desativada.");
    return list;
  };
  const loadUser = async (id) => {
    const u = await getUserById(Number(id));
    if (!u) throw new AppError("Usuário não encontrado.");
    return u;
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
  }, { admin: true });

  /* Cria o usuário com uma senha temporária aleatória, exibida uma única vez ao administrador */
  handle("users:create", async ({ nome, email, cargo, unidadeIds }, ctx) => {
    const name = String(nome || "").trim();
    if (!name) throw new AppError("Informe o nome.");
    const em = normalizeEmail(email);
    if (!["admin", "operador"].includes(cargo)) throw new AppError("Cargo inválido.");
    const units = cargo === "operador" ? await cleanUnitIds(unidadeIds) : [];
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
  }, { admin: true });

  /* Altera a quais quiosques o operador tem acesso */
  handle("users:setUnits", async ({ id, unidadeIds }, ctx) => {
    const u = await loadUser(id);
    if (u.cargo === "admin") throw new AppError("Administradores têm acesso a todas as unidades.");
    const units = await cleanUnitIds(unidadeIds);
    // Primeiro adiciona os novos, depois remove os que saíram (nunca fica sem acesso no meio do caminho)
    dbError(
      (await supabase.from("usuario_unidades")
        .upsert(units.map((uid) => ({ usuario_id: u.id, unidade_id: uid })), { onConflict: "usuario_id,unidade_id", ignoreDuplicates: true })).error
    );
    dbError(
      (await supabase.from("usuario_unidades").delete().eq("usuario_id", u.id).not("unidade_id", "in", `(${units.join(",")})`)).error
    );
    await audit(ctx, "acesso_alterado", `${u.email || u.usuario}: unidades ${units.join(", ")}`);
    return true;
  }, { admin: true });

  handle("users:resetPassword", async ({ id }, ctx) => {
    const u = await loadUser(id);
    const senha = generateTempPassword();
    dbError(
      (await supabase.from("usuarios")
        .update({ senha_hash: await hashPassword(senha), trocar_senha: true, falhas: 0, bloqueado_ate: null }).eq("id", u.id)).error
    );
    await audit(ctx, "senha_temporaria_gerada", u.email || u.usuario);
    return { email: u.email || u.usuario, senha };
  }, { admin: true });

  handle("users:unlock", async ({ id }, ctx) => {
    const u = await loadUser(id);
    dbError((await supabase.from("usuarios").update({ falhas: 0, bloqueado_ate: null }).eq("id", u.id)).error);
    await audit(ctx, "usuario_desbloqueado", u.email || u.usuario);
    return true;
  }, { admin: true });

  handle("users:toggle", async ({ id }, ctx) => {
    if (Number(id) === ctx.session.id) throw new AppError("Você não pode desativar o seu próprio usuário.");
    const u = await loadUser(id);
    dbError((await supabase.from("usuarios").update({ ativo: !u.ativo }).eq("id", u.id)).error);
    await audit(ctx, u.ativo ? "usuario_desativado" : "usuario_ativado", u.email || u.usuario);
    return true;
  }, { admin: true });
}

module.exports = { registerHandlers, dispatch };