/* ==========================================================
   MeuChopp — regras de negócio (API do servidor)
   Toda operação passa por aqui: valida permissão, grava no
   banco e registra quem fez (movimentação + auditoria).
   Cada aparelho tem a própria sessão (cookie), então vários
   usuários podem usar o sistema ao mesmo tempo.
   ========================================================== */
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { getDb } = require("./db");

const handlers = new Map();   // canal -> { fn, auth, admin }
const sessions = new Map();   // token -> { user, lastActivity }

// Estado da requisição em andamento. As operações são síncronas, então nunca se misturam.
let session = null;           // usuário da requisição atual
let sessionAction = null;     // "start" | "end": pedido do handler (login/logout)
let clientIp = "";

const CARGO_LABEL = { admin: "Administrador", operador: "Operador" };

/* ---------- Infraestrutura ---------- */
const IDLE_MS = 15 * 60 * 1000;          // sessão expira após 15 min sem atividade
const MAX_FALHAS = 5;                     // tentativas erradas antes de bloquear
const BLOQUEIO_MS = 15 * 60 * 1000;       // duração do bloqueio
const PERMITIDOS_TROCA = new Set(["auth:me", "auth:logout", "auth:ping", "auth:completeProfile"]);

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
const ipInfo = () => (clientIp ? ` (IP ${clientIp})` : "");

/* Executa uma operação para o aparelho identificado por `token` (cookie de sessão).
   Retorna { body, setToken?, clearToken? }. É síncrona de propósito. */
function dispatch(channel, payload, token, meta = {}) {
  const entry = handlers.get(channel);
  if (!entry) return { body: { ok: false, error: "Operação desconhecida.", code: "NOT_FOUND" } };
  const { fn, auth, admin } = entry;
  let rec = token ? sessions.get(token) : null;
  session = rec ? rec.user : null;
  sessionAction = null;
  clientIp = meta.ip || "";

  let body;
  try {
    if (channel === "auth:login" && ipBlocked(clientIp))
      throw new AppError("Muitas tentativas deste aparelho. Aguarde alguns minutos.");
    if (auth) {
      if (rec && Date.now() - rec.lastActivity > IDLE_MS) {
        audit("sessao_expirada", "Encerrada por inatividade");
        sessions.delete(token);
        rec = null;
        session = null;
        throw new AppError("Sua sessão expirou por inatividade. Entre novamente.", "SESSION");
      }
      if (!rec) throw new AppError("Sessão expirada. Faça login novamente.", "SESSION");
      if (session.trocarSenha && !PERMITIDOS_TROCA.has(channel))
        throw new AppError("Defina sua senha para continuar.", "MUST_CHANGE");
      rec.lastActivity = Date.now();
    }
    if (admin && session.cargo !== "admin") throw new AppError("Apenas administradores podem executar esta ação.");
    const data = fn(payload || {});
    if (data && typeof data.then === "function") throw new Error("Operação assíncrona não suportada.");
    body = { ok: true, data };
  } catch (err) {
    if (err && String(err.code).startsWith("SQLITE_CONSTRAINT_UNIQUE")) {
      body = { ok: false, error: "Já existe um registro com esse valor." };
    } else {
      if (err && err.appCode === "FORBIDDEN" && session) {
        try { audit("acesso_negado", `${channel}: ${err.detail || err.message}`); } catch (_) { /* ignora */ }
      }
      if (err instanceof AppError) {
        body = { ok: false, error: err.message, code: err.appCode };   // erro de regra: mensagem para o usuário
      } else {
        console.error(`[erro] ${channel}:`, err);                       // falha técnica: detalhe só no servidor
        body = { ok: false, error: "Erro inesperado. Tente novamente." };
      }
    }
  }

  const out = { body };
  if (sessionAction === "end") {
    if (token) sessions.delete(token);
    out.clearToken = true;
  } else if (sessionAction === "start" && body.ok) {
    if (token) sessions.delete(token); // novo token a cada login (evita fixação de sessão)
    const novo = crypto.randomBytes(32).toString("hex");
    sessions.set(novo, { user: session, lastActivity: Date.now() });
    out.setToken = novo;
  }
  if (channel === "auth:login") {
    if (body.ok) ipFails.delete(clientIp);
    else ipFail(clientIp);
  }
  session = null;
  sessionAction = null;
  return out;
}

/* Limpa sessões esquecidas */
setInterval(() => {
  const limite = Date.now() - IDLE_MS;
  for (const [t, r] of sessions) if (r.lastActivity < limite) sessions.delete(t);
}, 5 * 60 * 1000).unref();

/* ---------- Segurança de senhas e e-mails ---------- */
const hashPassword = (pw) => bcrypt.hashSync(String(pw), 12);
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
   Aceita o CNPJ numérico e o alfanumérico (emitido pela Receita desde 31/07/2026):
   12 caracteres de A-Z/0-9 + 2 dígitos verificadores. Cada caractere vale (código ASCII − 48),
   então os números continuam valendo o próprio algarismo. Guardado sem pontuação. */
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

const emailTaken = (email, exceptId = 0) =>
  !!getDb().prepare("SELECT 1 FROM usuarios WHERE lower(email) = ? AND id <> ?").get(email, exceptId);

function audit(acao, detalhe, userId = session ? session.id : null) {
  getDb()
    .prepare("INSERT INTO auditoria (usuario_id, acao, detalhe) VALUES (?, ?, ?)")
    .run(userId, acao, detalhe || null);
}

function logMovement({ barrilId, operacao, origem = null, destino = null, obs = null, torneira = null }) {
  getDb()
    .prepare(
      `INSERT INTO movimentacoes (barril_id, operacao, usuario_id, origem_unidade_id, destino_unidade_id, observacao,
                                  torneira_id, torneira_numero)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(barrilId, operacao, session.id, origem, destino, obs, torneira ? torneira.id : null, torneira ? torneira.numero : null);
}

/* ---------- Torneiras ----------
   A situação (livre/ocupada) nunca é gravada na torneira: ela é derivada do engate ativo
   (engates.retirado_em IS NULL). Assim não existe um "estado" que possa ficar inconsistente. */
const TAPS_SQL = `
  SELECT t.id, t.unidade_id, t.numero, t.ativo,
         e.id AS engate_id, e.engatado_em, ue.nome AS engatado_por,
         b.id AS barril_id, b.codigo, b.estilo,
         (SELECT COUNT(*) FROM engates x WHERE x.torneira_id = t.id) AS usos
    FROM torneiras t
LEFT JOIN engates e  ON e.torneira_id = t.id AND e.retirado_em IS NULL
LEFT JOIN barris b   ON b.id = e.barril_id
LEFT JOIN usuarios ue ON ue.id = e.engatado_por
   WHERE t.unidade_id = ?`;
const tapRow = (t) => ({ ...t, ocupada: !!t.engate_id });
const activeEngateOfBarrel = (barrilId) =>
  getDb().prepare("SELECT * FROM engates WHERE barril_id = ? AND retirado_em IS NULL").get(barrilId);
const activeEngateOfTap = (torneiraId) =>
  getDb()
    .prepare("SELECT e.*, b.codigo FROM engates e JOIN barris b ON b.id = e.barril_id WHERE e.torneira_id = ? AND e.retirado_em IS NULL")
    .get(torneiraId);

/* ---------- Acesso por quiosque ----------
   Administrador: todos os quiosques ativos.
   Operador: somente os quiosques que um administrador liberou para ele. */
function allowedUnitIds() {
  if (session.cargo === "admin")
    return getDb().prepare("SELECT id FROM unidades WHERE ativo = 1 ORDER BY id").all().map((r) => r.id);
  return getDb()
    .prepare(
      `SELECT u.id FROM usuario_unidades ua JOIN unidades u ON u.id = ua.unidade_id
        WHERE ua.usuario_id = ? AND u.ativo = 1 ORDER BY u.id`
    )
    .all(session.id)
    .map((r) => r.id);
}

function assertUnit(unitId) {
  const id = Number(unitId);
  if (!allowedUnitIds().includes(id))
    throw new AppError("Você não tem acesso a esta unidade.", "FORBIDDEN", `unidade ${id}`);
}

/* Quiosque em uso na tela: o pedido (se permitido) ou o primeiro liberado para o usuário */
function resolveUnit(unitId) {
  const allowed = allowedUnitIds();
  if (!allowed.length)
    throw new AppError("Você ainda não tem acesso a nenhuma unidade. Peça a um administrador para liberar.");
  const id = Number(unitId);
  if (!id) return allowed[0];
  if (!allowed.includes(id)) throw new AppError("Você não tem acesso a esta unidade.", "FORBIDDEN", `unidade ${id}`);
  return id;
}

function loadBarril(id) {
  const b = getDb().prepare("SELECT * FROM barris WHERE id = ?").get(Number(id));
  if (!b) throw new AppError("Barril não encontrado.");
  assertUnit(b.unidade_id);
  return b;
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
function queryMovements({ unitId, q, operacao, limit }) {
  const params = { unit: unitId, q: q ? `%${String(q).replace("#", "").trim()}%` : null, op: operacao || null };
  let sql = `
    SELECT m.id, m.operacao, m.criado_em, m.observacao, m.torneira_numero,
           b.codigo, b.estilo,
           u.nome AS responsavel,
           uo.nome AS origem, ud.nome AS destino
      FROM movimentacoes m
      JOIN barris b   ON b.id = m.barril_id
      JOIN usuarios u ON u.id = m.usuario_id
 LEFT JOIN unidades uo ON uo.id = m.origem_unidade_id
 LEFT JOIN unidades ud ON ud.id = m.destino_unidade_id
     WHERE (m.origem_unidade_id = @unit OR m.destino_unidade_id = @unit)
       AND (@q  IS NULL OR b.codigo LIKE @q)
       AND (@op IS NULL OR m.operacao = @op)
  ORDER BY m.id DESC`;
  if (limit) sql += ` LIMIT ${Math.min(Number(limit) || 100, 1000)}`;
  return getDb().prepare(sql).all(params);
}

function registerHandlers() {
  const db = getDb;

  /* ======== Autenticação ======== */
  const GENERIC = "E-mail ou senha incorretos.";
  const unknownAttempts = new Map(); // tentativas com e-mails que não existem (também limitadas)
  let dummyHash = null;              // evita revelar, pelo tempo de resposta, se o e-mail existe

  const lockMessage = (until) => {
    const min = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    return `Muitas tentativas. Tente novamente em ${min} minuto${min > 1 ? "s" : ""}.`;
  };

  const startSession = (user) => {
    session = publicUser(user);
    sessionAction = "start";
    return session;
  };

  handle("auth:needsSetup", () => db().prepare("SELECT COUNT(*) AS n FROM usuarios").get().n === 0, { auth: false });

  handle(
    "auth:setup",
    ({ nome, email, senha }) => {
      if (db().prepare("SELECT COUNT(*) AS n FROM usuarios").get().n > 0)
        throw new AppError("O sistema já foi configurado. Entre com o seu e-mail e senha.");
      const name = String(nome || "").trim();
      if (!name) throw new AppError("Informe o seu nome.");
      const em = normalizeEmail(email);
      checkPassword(senha, em);
      const info = db()
        .prepare("INSERT INTO usuarios (nome, usuario, email, senha_hash, cargo) VALUES (?, ?, ?, ?, 'admin')")
        .run(name, em, em, hashPassword(senha));
      const user = db().prepare("SELECT * FROM usuarios WHERE id = ?").get(info.lastInsertRowid);
      startSession(user);
      audit("configuracao_inicial", `Administrador ${em} criado`);
      return session;
    },
    { auth: false }
  );

  handle(
    "auth:login",
    ({ identifier, password }) => {
      const ident = String(identifier || "").trim().toLowerCase();
      const pass = String(password || "");
      if (!ident || !pass) throw new AppError(GENERIC);

      const user = db()
        .prepare("SELECT * FROM usuarios WHERE lower(email) = @i OR lower(usuario) = @i")
        .get({ i: ident });
      const now = Date.now();
      const unknown = unknownAttempts.get(ident);
      const lockedUntil = user ? user.bloqueado_ate || 0 : unknown ? unknown.until : 0;
      if (lockedUntil > now) {
        audit("login_bloqueado", `Tentativa durante bloqueio (${ident})`, user ? user.id : null);
        throw new AppError(lockMessage(lockedUntil));
      }

      if (!dummyHash) dummyHash = hashPassword("senha-ficticia-meuchopp");
      const match = bcrypt.compareSync(pass, user && user.ativo ? user.senha_hash : dummyHash);

      if (!(user && user.ativo && match)) {
        let until = 0;
        if (user) {
          const falhas = (user.falhas || 0) + 1;
          if (falhas >= MAX_FALHAS) {
            until = now + BLOQUEIO_MS;
            db().prepare("UPDATE usuarios SET falhas = 0, bloqueado_ate = ? WHERE id = ?").run(until, user.id);
          } else {
            db().prepare("UPDATE usuarios SET falhas = ? WHERE id = ?").run(falhas, user.id);
          }
        } else {
          if (unknownAttempts.size > 1000) unknownAttempts.clear();
          const rec = unknown || { count: 0, until: 0 };
          rec.count += 1;
          if (rec.count >= MAX_FALHAS) { rec.until = now + BLOQUEIO_MS; rec.count = 0; }
          unknownAttempts.set(ident, rec);
          until = rec.until;
        }
        audit("login_falhou", `Tentativa com "${ident}"${ipInfo()}`, user ? user.id : null);
        throw new AppError(until > now ? lockMessage(until) : GENERIC);
      }

      db()
        .prepare("UPDATE usuarios SET falhas = 0, bloqueado_ate = NULL, ultimo_login = datetime('now','localtime') WHERE id = ?")
        .run(user.id);
      unknownAttempts.delete(ident);
      startSession(user);
      audit("login", "Entrou no sistema" + ipInfo());
      return session;
    },
    { auth: false }
  );

  handle("auth:logout", () => {
    audit("logout", "Saiu do sistema");
    sessionAction = "end";
    return true;
  });

  handle("auth:me", () => session);
  handle("auth:ping", () => true); // mantém a sessão viva enquanto o usuário está ativo

  /* Primeiro acesso / senha temporária: define e-mail (se faltar) e uma senha nova */
  handle("auth:completeProfile", ({ email, nova }) => {
    const u = db().prepare("SELECT * FROM usuarios WHERE id = ?").get(session.id);
    const em = normalizeEmail(email || u.email);
    checkPassword(nova, em);
    if (bcrypt.compareSync(String(nova), u.senha_hash))
      throw new AppError("A nova senha precisa ser diferente da senha temporária.");
    if (emailTaken(em, u.id)) throw new AppError("Este e-mail já está sendo usado por outro usuário.");
    db()
      .prepare("UPDATE usuarios SET email = ?, usuario = ?, senha_hash = ?, trocar_senha = 0 WHERE id = ?")
      .run(em, em, hashPassword(nova), u.id);
    startSession(db().prepare("SELECT * FROM usuarios WHERE id = ?").get(u.id));
    audit("primeiro_acesso", "Definiu e-mail e nova senha");
    return session;
  });

  handle("auth:changePassword", ({ atual, nova }) => {
    const u = db().prepare("SELECT * FROM usuarios WHERE id = ?").get(session.id);
    if (!bcrypt.compareSync(String(atual || ""), u.senha_hash)) throw new AppError("Senha atual incorreta.");
    checkPassword(nova, u.email);
    if (String(nova) === String(atual)) throw new AppError("A nova senha precisa ser diferente da atual.");
    db().prepare("UPDATE usuarios SET senha_hash = ? WHERE id = ?").run(hashPassword(nova), u.id);
    audit("senha_alterada", "Alterou a própria senha");
    return true;
  });

  /* ======== Quiosques ======== */
  // Quiosques que o usuário pode acessar (alimenta o seletor do cabeçalho)
  handle("units:list", () => {
    const ids = allowedUnitIds();
    return db().prepare("SELECT id, nome, nome_curto FROM unidades ORDER BY id").all().filter((u) => ids.includes(u.id));
  });
  // Destinos possíveis de uma transferência: só nomes dos quiosques ativos (nenhum dado deles)
  handle("units:all", () => db().prepare("SELECT id, nome, nome_curto FROM unidades WHERE ativo = 1 ORDER BY id").all());

  handle(
    "units:adminList",
    () =>
      db()
        .prepare(
          `SELECT u.id, u.nome, u.nome_curto, u.ativo, u.cnpj, u.endereco,
                  (SELECT COUNT(*) FROM barris b WHERE b.unidade_id = u.id) AS barris,
                  (SELECT COUNT(*) FROM usuario_unidades ua JOIN usuarios us ON us.id = ua.usuario_id
                    WHERE ua.unidade_id = u.id AND us.ativo = 1) AS usuarios,
                  (SELECT COUNT(*) FROM torneiras t WHERE t.unidade_id = u.id AND t.ativo = 1) AS torneiras,
                  (SELECT COUNT(*) FROM engates e WHERE e.unidade_id = u.id AND e.retirado_em IS NULL) AS torneirasOcupadas
             FROM unidades u ORDER BY u.id`
        )
        .all()
        .map((u) => ({ ...u, cnpjFormatado: formatCnpj(u.cnpj) })),
    { admin: true }
  );

  /* Detalhes de uma unidade + suas torneiras (tela Unidades) */
  handle(
    "units:details",
    ({ id }) => {
      const u = db().prepare("SELECT id, nome, nome_curto, ativo, cnpj, endereco FROM unidades WHERE id = ?").get(Number(id));
      if (!u) throw new AppError("Unidade não encontrada.");
      const torneiras = db().prepare(TAPS_SQL + " ORDER BY t.ativo DESC, t.numero").all(u.id).map(tapRow);
      return { ...u, cnpjFormatado: formatCnpj(u.cnpj), torneiras };
    },
    { admin: true }
  );

  /* Nome, CNPJ e endereço são obrigatórios ao cadastrar e ao editar.
     (As unidades que já existiam ficam sem CNPJ/endereço até alguém preenchê-los em "Editar".) */
  const cleanUnitData = ({ nome, nomeCurto, cnpj, endereco }, exceptId = 0) => {
    const full = String(nome || "").trim();
    const short = String(nomeCurto || "").trim() || full;
    if (full.length < 2) throw new AppError("Informe o nome da unidade.");
    if (full.length > 60 || short.length > 30) throw new AppError("Nome muito longo (máximo 60 e 30 caracteres).");
    if (db().prepare("SELECT 1 FROM unidades WHERE lower(nome) = lower(?) AND id <> ?").get(full, exceptId))
      throw new AppError(`Já existe uma unidade chamada "${full}".`);
    const doc = normalizeCnpj(cnpj);
    const outra = db().prepare("SELECT nome FROM unidades WHERE cnpj = ? AND id <> ?").get(doc, exceptId);
    if (outra) throw new AppError(`Este CNPJ já está cadastrado na unidade "${outra.nome}".`);
    const end = String(endereco || "").trim().replace(/\s+/g, " ");
    if (end.length < 8) throw new AppError("Informe a localização completa da unidade (rua, número, bairro, cidade, estado e CEP).");
    if (end.length > 300) throw new AppError("Localização muito longa (máximo 300 caracteres).");
    return { full, short, doc, end };
  };

  handle(
    "units:create",
    (p) => {
      const { full, short, doc, end } = cleanUnitData(p);
      const info = db()
        .prepare("INSERT INTO unidades (nome, nome_curto, cnpj, endereco) VALUES (?, ?, ?, ?)")
        .run(full, short, doc, end);
      audit("unidade_criada", `${full} (CNPJ ${formatCnpj(doc)})`);
      return { id: info.lastInsertRowid };
    },
    { admin: true }
  );

  handle(
    "units:update",
    (p) => {
      const id = Number(p.id);
      if (!db().prepare("SELECT 1 FROM unidades WHERE id = ?").get(id)) throw new AppError("Unidade não encontrada.");
      const { full, short, doc, end } = cleanUnitData(p, id);
      db().prepare("UPDATE unidades SET nome = ?, nome_curto = ?, cnpj = ?, endereco = ? WHERE id = ?").run(full, short, doc, end, id);
      audit("unidade_editada", `${full} (CNPJ ${formatCnpj(doc)})`);
      return true;
    },
    { admin: true }
  );

  handle(
    "units:toggle",
    ({ id }) => {
      const u = db().prepare("SELECT * FROM unidades WHERE id = ?").get(Number(id));
      if (!u) throw new AppError("Unidade não encontrada.");
      if (u.ativo) {
        const emEstoque = db()
          .prepare("SELECT COUNT(*) AS n FROM barris WHERE unidade_id = ? AND status <> 'esgotado'")
          .get(u.id).n;
        const recebendo = db()
          .prepare("SELECT COUNT(*) AS n FROM transferencias WHERE destino_id = ? AND status = 'pendente'")
          .get(u.id).n;
        if (emEstoque || recebendo)
          throw new AppError(
            `Esta unidade ainda tem ${emEstoque} barril(is) em estoque e ${recebendo} transferência(s) a receber. Resolva antes de desativar.`
          );
      }
      db().prepare("UPDATE unidades SET ativo = ? WHERE id = ?").run(u.ativo ? 0 : 1, u.id);
      audit(u.ativo ? "unidade_desativada" : "unidade_reativada", u.nome);
      return true;
    },
    { admin: true }
  );

  /* ======== Torneiras ======== */
  const loadTap = (id) => {
    const t = db().prepare("SELECT * FROM torneiras WHERE id = ?").get(Number(id));
    if (!t) throw new AppError("Torneira não encontrada.");
    return t;
  };
  const cleanTapNumber = (n) => {
    const num = Number(n);
    if (!Number.isInteger(num) || num < 1 || num > 999) throw new AppError("O número da torneira deve ser um número inteiro entre 1 e 999.");
    return num;
  };
  const tapNumberTaken = (unitId, numero, exceptId = 0) =>
    !!db().prepare("SELECT 1 FROM torneiras WHERE unidade_id = ? AND numero = ? AND ativo = 1 AND id <> ?").get(unitId, numero, exceptId);

  // Cadastra uma ou mais torneiras com os próximos números livres da unidade
  handle(
    "taps:create",
    ({ unitId, quantidade = 1 }) =>
      db().transaction(() => {
        const u = db().prepare("SELECT * FROM unidades WHERE id = ?").get(Number(unitId));
        if (!u) throw new AppError("Unidade não encontrada.");
        if (!u.ativo) throw new AppError("Esta unidade está desativada. Reative-a antes de cadastrar torneiras.");
        const qtd = Number(quantidade);
        if (!Number.isInteger(qtd) || qtd < 1 || qtd > 50) throw new AppError("Informe uma quantidade de 1 a 50 torneiras.");
        let next = db().prepare("SELECT COALESCE(MAX(numero), 0) AS n FROM torneiras WHERE unidade_id = ? AND ativo = 1").get(u.id).n;
        const criadas = [];
        for (let i = 0; i < qtd; i++) {
          next += 1;
          if (next > 999) throw new AppError("Limite de numeração atingido (999).");
          db().prepare("INSERT INTO torneiras (unidade_id, numero) VALUES (?, ?)").run(u.id, next);
          criadas.push(next);
        }
        audit("torneira_cadastrada", `${u.nome}: Torneira ${criadas.join(", ")}`);
        return { numeros: criadas };
      })(),
    { admin: true }
  );

  // Altera o número visível. O histórico guarda o número usado em cada operação, então não muda.
  handle(
    "taps:update",
    ({ id, numero }) => {
      const t = loadTap(id);
      const num = cleanTapNumber(numero);
      if (num === t.numero) return true;
      if (t.ativo && tapNumberTaken(t.unidade_id, num, t.id))
        throw new AppError(`Já existe uma Torneira ${num} ativa nesta unidade.`);
      db().prepare("UPDATE torneiras SET numero = ? WHERE id = ?").run(num, t.id);
      const un = db().prepare("SELECT nome FROM unidades WHERE id = ?").get(t.unidade_id).nome;
      audit("torneira_renumerada", `${un}: Torneira ${t.numero} → Torneira ${num}`);
      return true;
    },
    { admin: true }
  );

  // Desativa/reativa. Torneiras nunca são apagadas: o histórico de engates continua apontando para elas.
  handle(
    "taps:toggle",
    ({ id }) => {
      const t = loadTap(id);
      const un = db().prepare("SELECT nome, ativo FROM unidades WHERE id = ?").get(t.unidade_id);
      if (t.ativo) {
        const e = activeEngateOfTap(t.id);
        if (e) throw new AppError(`A Torneira ${t.numero} está ocupada pelo barril #${e.codigo}. Retire o barril antes de desativá-la.`);
      } else {
        if (!un.ativo) throw new AppError("Esta unidade está desativada. Reative-a antes de reativar a torneira.");
        if (tapNumberTaken(t.unidade_id, t.numero, t.id))
          throw new AppError(`Já existe uma Torneira ${t.numero} ativa nesta unidade. Altere o número desta torneira antes de reativá-la.`);
      }
      db().prepare("UPDATE torneiras SET ativo = ? WHERE id = ?").run(t.ativo ? 0 : 1, t.id);
      audit(t.ativo ? "torneira_desativada" : "torneira_reativada", `${un.nome}: Torneira ${t.numero}`);
      return true;
    },
    { admin: true }
  );

  // Torneiras da unidade do barril, para o funcionário escolher no engate (respeita o acesso à unidade)
  handle("taps:forBarril", ({ barrilId }) => {
    const b = loadBarril(barrilId);
    const u = db().prepare("SELECT id, nome FROM unidades WHERE id = ?").get(b.unidade_id);
    const torneiras = db()
      .prepare(TAPS_SQL + " AND t.ativo = 1 ORDER BY t.numero")
      .all(u.id)
      .map((t) => ({ id: t.id, numero: t.numero, ocupada: !!t.engate_id, barril: t.codigo || null, estilo: t.estilo || null }));
    return { barril: { id: b.id, codigo: b.codigo, estilo: b.estilo, status: b.status }, unidade: u, torneiras };
  });

  /* ======== Dashboard ======== */
  handle("dashboard:get", ({ unitId }) => {
    const unit = resolveUnit(unitId);
    const stats = db()
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(status = 'disponivel'), 0)       AS disponiveis,
                COALESCE(SUM(status = 'em_uso'), 0)           AS emUso,
                COALESCE(SUM(status = 'em_transferencia'), 0) AS emTransferencia,
                COALESCE(SUM(status = 'esgotado'), 0)         AS choppEsgotado
           FROM barris WHERE unidade_id = ?`
      )
      .get(unit);
    return { stats, movimentacoes: queryMovements({ unitId: unit, limit: 8 }) };
  });

  handle("alerts:list", ({ unitId }) => {
    const unit = resolveUnit(unitId);
    const alerts = [];

    db()
      .prepare(
        `SELECT t.id, b.codigo, uo.nome AS origem, ud.nome AS destino, t.origem_id, t.destino_id
           FROM transferencias t
           JOIN barris b ON b.id = t.barril_id
           JOIN unidades uo ON uo.id = t.origem_id
           JOIN unidades ud ON ud.id = t.destino_id
          WHERE t.status = 'pendente' AND (t.origem_id = ? OR t.destino_id = ?)`
      )
      .all(unit, unit)
      .forEach((t) =>
        alerts.push({
          texto:
            t.destino_id === unit
              ? `Barril #${t.codigo} vindo de ${t.origem} aguardando seu recebimento.`
              : `Barril #${t.codigo} aguardando confirmação de ${t.destino}.`,
        })
      );

    db()
      .prepare(
        `SELECT b.codigo FROM barris b
          WHERE b.unidade_id = ? AND b.status = 'esgotado'
            AND (SELECT MAX(criado_em) FROM movimentacoes WHERE barril_id = b.id)
                < datetime('now','localtime','-3 days')`
      )
      .all(unit)
      .forEach((b) => alerts.push({ texto: `Barril #${b.codigo} esgotado há mais de 3 dias sem atualização.` }));

    return alerts;
  });

  /* ======== Barris ======== */
  handle("barris:list", ({ unitId, status, q }) => {
    const unit = resolveUnit(unitId);
    return db()
      .prepare(
        `SELECT b.*, u.nome_curto AS unidade, t.numero AS torneira_numero
           FROM barris b JOIN unidades u ON u.id = b.unidade_id
      LEFT JOIN engates e   ON e.barril_id = b.id AND e.retirado_em IS NULL
      LEFT JOIN torneiras t ON t.id = e.torneira_id
          WHERE b.unidade_id = @unit
            AND (@status IS NULL OR b.status = @status)
            AND (@q IS NULL OR b.codigo LIKE @q OR b.estilo LIKE @q)
       ORDER BY b.codigo`
      )
      .all({ unit, status: status || null, q: q ? `%${String(q).replace("#", "").trim()}%` : null });
  });

  handle("barris:create", ({ codigo, estilo, tamanho, unitId }) => {
    const cod = String(codigo || "").replace("#", "").trim().toUpperCase();
    const est = String(estilo || "").trim();
    const tam = Number(tamanho);
    if (!cod || !est || !(tam > 0)) throw new AppError("Preencha código, estilo e tamanho do barril.");
    const unit = resolveUnit(unitId);
    assertUnit(unit);

    return db().transaction(() => {
      let info;
      try {
        info = db()
          .prepare("INSERT INTO barris (codigo, estilo, tamanho_l, unidade_id) VALUES (?, ?, ?, ?)")
          .run(cod, est, tam, unit);
      } catch (e) {
        if (String(e.code).startsWith("SQLITE_CONSTRAINT")) throw new AppError(`Já existe um barril com o código #${cod}.`);
        throw e;
      }
      logMovement({ barrilId: info.lastInsertRowid, operacao: "entrada", destino: unit, obs: "Cadastro do barril" });
      audit("barril_cadastrado", `Barril #${cod} (${est}, ${tam} L)`);
      return { id: info.lastInsertRowid };
    })();
  });

  const changeStatus = (channel, { from, to, operacao, obs, auditName }) =>
    handle(channel, ({ id }) =>
      db().transaction(() => {
        const b = loadBarril(id);
        if (b.status !== from)
          throw new AppError(`O barril #${b.codigo} não está no status esperado para esta ação.`);
        db().prepare("UPDATE barris SET status = ? WHERE id = ?").run(to, b.id);
        logMovement({
          barrilId: b.id,
          operacao,
          origem: operacao === "entrada" ? null : b.unidade_id,
          destino: operacao === "entrada" ? b.unidade_id : null,
          obs,
        });
        audit(auditName, `Barril #${b.codigo}`);
        return true;
      })()
    );

  /* Engate (início de uso): disponível → em uso, sempre em uma torneira livre da unidade do barril.
     Tudo dentro de uma transação: se qualquer verificação falhar, nada é gravado. */
  handle("barris:use", ({ id, torneiraId, unitId }) =>
    db().transaction(() => {
      const b = loadBarril(id); // barril existe + usuário tem acesso à unidade dele
      if (unitId && Number(unitId) !== b.unidade_id)
        throw new AppError(`O barril #${b.codigo} não pertence à unidade selecionada.`);
      if (b.status !== "disponivel")
        throw new AppError(`O barril #${b.codigo} não pode ser engatado: está "${STATUS_TEXTO[b.status]}". Só barris disponíveis podem ser engatados.`);
      if (activeEngateOfBarrel(b.id)) throw new AppError(`O barril #${b.codigo} já está engatado em uma torneira.`);

      if (!torneiraId) {
        const livres = db()
          .prepare(
            `SELECT COUNT(*) AS n FROM torneiras t WHERE t.unidade_id = ? AND t.ativo = 1
               AND NOT EXISTS (SELECT 1 FROM engates e WHERE e.torneira_id = t.id AND e.retirado_em IS NULL)`
          )
          .get(b.unidade_id).n;
        throw new AppError(livres ? "Selecione a torneira em que o barril será engatado." : MSG_SEM_TORNEIRA);
      }
      const t = db().prepare("SELECT * FROM torneiras WHERE id = ?").get(Number(torneiraId));
      if (!t || t.unidade_id !== b.unidade_id) throw new AppError("Torneira inválida: ela não pertence à unidade deste barril.");
      if (!t.ativo) throw new AppError(`A Torneira ${t.numero} está desativada.`);
      const ocupante = activeEngateOfTap(t.id);
      if (ocupante) throw new AppError(`A Torneira ${t.numero} está ocupada pelo barril #${ocupante.codigo}. Escolha outra torneira.`);

      try {
        db()
          .prepare("INSERT INTO engates (barril_id, torneira_id, unidade_id, torneira_numero, engatado_por) VALUES (?, ?, ?, ?, ?)")
          .run(b.id, t.id, b.unidade_id, t.numero, session.id);
      } catch (e) {
        // Índices únicos do banco: última barreira contra dois engates simultâneos
        if (String(e.code).startsWith("SQLITE_CONSTRAINT")) throw new AppError("A torneira ou o barril acabou de ser usado em outro engate. Atualize a tela e tente de novo.");
        throw e;
      }
      db().prepare("UPDATE barris SET status = 'em_uso' WHERE id = ?").run(b.id);
      const un = db().prepare("SELECT nome FROM unidades WHERE id = ?").get(b.unidade_id).nome;
      logMovement({ barrilId: b.id, operacao: "utilizacao", origem: b.unidade_id, obs: `Engatado na Torneira ${t.numero}`, torneira: t });
      audit("barril_em_uso", `Barril #${b.codigo} engatado na Torneira ${t.numero} (${un})`);
      return { codigo: b.codigo, estilo: b.estilo, unidade: un, torneira: t.numero };
    })()
  );

  /* Retirada (regra atual: o barril sai da torneira quando o chopp esgota): em uso → esgotado.
     A torneira vem do engate registrado — nunca é escolhida pelo usuário — e é liberada aqui. */
  handle("barris:empty", ({ id }) =>
    db().transaction(() => {
      const b = loadBarril(id);
      if (b.status !== "em_uso")
        throw new AppError(`O barril #${b.codigo} não está em uso (status atual: "${STATUS_TEXTO[b.status]}").`);
      const un = db().prepare("SELECT nome FROM unidades WHERE id = ?").get(b.unidade_id).nome;
      const e = activeEngateOfBarrel(b.id);
      let torneira = null;
      if (e) {
        const t = db().prepare("SELECT * FROM torneiras WHERE id = ?").get(e.torneira_id);
        // Proteção: só libera a torneira se ela for mesmo da unidade do barril
        if (!t || t.unidade_id !== b.unidade_id || e.unidade_id !== b.unidade_id)
          throw new AppError("Registro de engate inconsistente para este barril. Nada foi alterado; avise o administrador.");
        const fechou = db()
          .prepare("UPDATE engates SET retirado_por = ?, retirado_em = datetime('now','localtime') WHERE id = ? AND retirado_em IS NULL")
          .run(session.id, e.id).changes;
        if (fechou !== 1) throw new AppError("Não foi possível encerrar o engate deste barril. Atualize a tela e tente de novo.");
        torneira = { id: t.id, numero: t.numero };
      }
      db().prepare("UPDATE barris SET status = 'esgotado' WHERE id = ?").run(b.id);
      logMovement({
        barrilId: b.id,
        operacao: "esgotado",
        origem: b.unidade_id,
        torneira,
        obs: torneira
          ? `Retirado da Torneira ${torneira.numero} (torneira liberada)`
          : "Retirado sem torneira registrada (engate feito antes do controle de torneiras)",
      });
      audit("barril_esgotado", `Barril #${b.codigo}${torneira ? ` retirado da Torneira ${torneira.numero}` : " (sem torneira registrada)"} (${un})`);
      return { codigo: b.codigo, unidade: un, torneira: torneira ? torneira.numero : null };
    })()
  );
  changeStatus("barris:refill", { from: "esgotado",   to: "disponivel", operacao: "entrada",    obs: "Barril reabastecido", auditName: "barril_reabastecido" });

  /* ======== Transferências ======== */
  handle("transfer:list", ({ unitId }) => {
    const unit = resolveUnit(unitId);
    return db()
      .prepare(
        `SELECT t.*, b.codigo, b.estilo, uo.nome_curto AS origem, ud.nome_curto AS destino,
                us.nome AS solicitante, ur.nome AS recebedor
           FROM transferencias t
           JOIN barris b ON b.id = t.barril_id
           JOIN unidades uo ON uo.id = t.origem_id
           JOIN unidades ud ON ud.id = t.destino_id
           JOIN usuarios us ON us.id = t.solicitante_id
      LEFT JOIN usuarios ur ON ur.id = t.recebedor_id
          WHERE t.origem_id = ? OR t.destino_id = ?
       ORDER BY t.id DESC LIMIT 100`
      )
      .all(unit, unit);
  });

  handle("transfer:create", ({ barrilId, destinoId }) =>
    db().transaction(() => {
      const b = loadBarril(barrilId);
      const destino = Number(destinoId);
      if (!destino || destino === b.unidade_id) throw new AppError("Escolha uma unidade de destino diferente da origem.");
      if (!db().prepare("SELECT 1 FROM unidades WHERE id = ? AND ativo = 1").get(destino)) throw new AppError("Unidade de destino inválida ou desativada.");
      if (b.status !== "disponivel") throw new AppError(`Só é possível transferir barris disponíveis (#${b.codigo} está indisponível).`);

      db().prepare("UPDATE barris SET status = 'em_transferencia' WHERE id = ?").run(b.id);
      db()
        .prepare("INSERT INTO transferencias (barril_id, origem_id, destino_id, solicitante_id) VALUES (?, ?, ?, ?)")
        .run(b.id, b.unidade_id, destino, session.id);
      logMovement({ barrilId: b.id, operacao: "transferencia", origem: b.unidade_id, destino });
      audit("transferencia_iniciada", `Barril #${b.codigo}`);
      return true;
    })()
  );

  handle("transfer:confirm", ({ id }) =>
    db().transaction(() => {
      const t = db().prepare("SELECT * FROM transferencias WHERE id = ?").get(Number(id));
      if (!t || t.status !== "pendente") throw new AppError("Transferência não está pendente.");
      assertUnit(t.destino_id); // quem recebe é quem confirma
      const b = db().prepare("SELECT * FROM barris WHERE id = ?").get(t.barril_id);

      db().prepare("UPDATE barris SET unidade_id = ?, status = 'disponivel' WHERE id = ?").run(t.destino_id, b.id);
      db()
        .prepare("UPDATE transferencias SET status='confirmada', recebedor_id=?, resolvido_em=datetime('now','localtime') WHERE id=?")
        .run(session.id, t.id);
      logMovement({ barrilId: b.id, operacao: "entrada", origem: t.origem_id, destino: t.destino_id, obs: "Recebimento de transferência" });
      audit("transferencia_confirmada", `Barril #${b.codigo}`);
      return true;
    })()
  );

  handle("transfer:cancel", ({ id }) =>
    db().transaction(() => {
      const t = db().prepare("SELECT * FROM transferencias WHERE id = ?").get(Number(id));
      if (!t || t.status !== "pendente") throw new AppError("Transferência não está pendente.");
      assertUnit(t.origem_id); // quem enviou é quem cancela
      const b = db().prepare("SELECT * FROM barris WHERE id = ?").get(t.barril_id);

      db().prepare("UPDATE barris SET status = 'disponivel' WHERE id = ?").run(b.id);
      db()
        .prepare("UPDATE transferencias SET status='cancelada', resolvido_em=datetime('now','localtime') WHERE id=?")
        .run(t.id);
      // Registra o cancelamento no histórico: sem isso, o histórico mostraria o barril
      // "transferido" para o destino, embora ele continue na origem.
      const destinoNome = db().prepare("SELECT nome FROM unidades WHERE id = ?").get(t.destino_id).nome;
      logMovement({
        barrilId: b.id,
        operacao: "transferencia",
        origem: t.origem_id,
        obs: `Transferência para ${destinoNome} cancelada. O barril continua na origem.`,
      });
      audit("transferencia_cancelada", `Barril #${b.codigo}`);
      return true;
    })()
  );

  /* ======== Histórico e relatórios ======== */
  handle("history:list", ({ unitId, q, operacao }) =>
    queryMovements({ unitId: resolveUnit(unitId), q, operacao, limit: 300 })
  );

  handle("history:export", ({ unitId, q, operacao }) => {
    const rows = queryMovements({ unitId: resolveUnit(unitId), q, operacao });
    const labels = { entrada: "Entrada", transferencia: "Transferência", utilizacao: "Utilização", esgotado: "Chopp Esgotado" };
    // Células que começam com = + - @ viram texto (evita que o Excel execute fórmulas digitadas por usuários)
    const esc = (v) => {
      let t = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return `"${t.replace(/"/g, '""')}"`;
    };
    const header = ["Data/Hora", "Barril", "Estilo", "Operação", "Origem", "Destino", "Torneira", "Responsável", "Observação"];
    const lines = rows.map((r) =>
      [r.criado_em, "#" + r.codigo, r.estilo, labels[r.operacao], r.origem || "Fábrica", r.destino || "",
       r.torneira_numero ? `Torneira ${r.torneira_numero}` : "", r.responsavel, r.observacao]
        .map(esc)
        .join(";")
    );
    const csv = "\uFEFF" + [header.map(esc).join(";"), ...lines].join("\r\n"); // BOM p/ Excel abrir com acentos

    audit("relatorio_exportado", `${rows.length} movimentações`);
    const dia = new Date().toISOString().slice(0, 10);
    return { filename: `relatorio-movimentacoes-${dia}.csv`, csv, total: rows.length };
  });

  handle("audit:list", () =>
    db()
      .prepare(
        `SELECT a.id, a.acao, a.detalhe, a.criado_em, COALESCE(u.nome, '—') AS usuario
           FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
       ORDER BY a.id DESC LIMIT 300`
      )
      .all(),
    { admin: true }
  );

  /* ======== Usuários (somente administrador) ======== */
  const cleanUnitIds = (ids) => {
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean))];
    if (!list.length) throw new AppError("Escolha ao menos uma unidade para o operador.");
    const valid = db().prepare("SELECT id FROM unidades WHERE ativo = 1").all().map((r) => r.id);
    if (list.some((id) => !valid.includes(id))) throw new AppError("Unidade inválida ou desativada.");
    return list;
  };

  handle(
    "users:list",
    () => {
      const access = db()
        .prepare("SELECT ua.usuario_id, u.id, u.nome_curto FROM usuario_unidades ua JOIN unidades u ON u.id = ua.unidade_id ORDER BY u.id")
        .all();
      return db()
        .prepare(
          `SELECT id, nome, email, usuario, cargo, ativo, trocar_senha, bloqueado_ate, ultimo_login
             FROM usuarios ORDER BY nome`
        )
        .all()
        .map((u) => ({
          ...u,
          bloqueado: (u.bloqueado_ate || 0) > Date.now(),
          unidadeIds: access.filter((a) => a.usuario_id === u.id).map((a) => a.id),
          unidades: access.filter((a) => a.usuario_id === u.id).map((a) => a.nome_curto),
        }));
    },
    { admin: true }
  );

  /* Cria o usuário com uma senha temporária aleatória, exibida uma única vez ao administrador */
  handle(
    "users:create",
    ({ nome, email, cargo, unidadeIds }) => {
      const name = String(nome || "").trim();
      if (!name) throw new AppError("Informe o nome.");
      const em = normalizeEmail(email);
      if (!["admin", "operador"].includes(cargo)) throw new AppError("Cargo inválido.");
      const units = cargo === "operador" ? cleanUnitIds(unidadeIds) : [];
      if (emailTaken(em)) throw new AppError(`O e-mail ${em} já está cadastrado.`);

      const senha = generateTempPassword();
      return db().transaction(() => {
        const info = db()
          .prepare("INSERT INTO usuarios (nome, usuario, email, senha_hash, cargo, trocar_senha) VALUES (?, ?, ?, ?, ?, 1)")
          .run(name, em, em, hashPassword(senha), cargo);
        units.forEach((uid) =>
          db().prepare("INSERT INTO usuario_unidades (usuario_id, unidade_id) VALUES (?, ?)").run(info.lastInsertRowid, uid)
        );
        audit("usuario_criado", `${em} (${cargo})`);
        return { email: em, senha };
      })();
    },
    { admin: true }
  );

  /* Altera a quais quiosques o operador tem acesso */
  handle(
    "users:setUnits",
    ({ id, unidadeIds }) => {
      const u = db().prepare("SELECT * FROM usuarios WHERE id = ?").get(Number(id));
      if (!u) throw new AppError("Usuário não encontrado.");
      if (u.cargo === "admin") throw new AppError("Administradores têm acesso a todas as unidades.");
      const units = cleanUnitIds(unidadeIds);
      db().transaction(() => {
        db().prepare("DELETE FROM usuario_unidades WHERE usuario_id = ?").run(u.id);
        units.forEach((uid) => db().prepare("INSERT INTO usuario_unidades (usuario_id, unidade_id) VALUES (?, ?)").run(u.id, uid));
        audit("acesso_alterado", `${u.email || u.usuario}: unidades ${units.join(", ")}`);
      })();
      return true;
    },
    { admin: true }
  );

  handle(
    "users:resetPassword",
    ({ id }) => {
      const u = db().prepare("SELECT * FROM usuarios WHERE id = ?").get(Number(id));
      if (!u) throw new AppError("Usuário não encontrado.");
      const senha = generateTempPassword();
      db()
        .prepare("UPDATE usuarios SET senha_hash = ?, trocar_senha = 1, falhas = 0, bloqueado_ate = NULL WHERE id = ?")
        .run(hashPassword(senha), u.id);
      audit("senha_temporaria_gerada", u.email || u.usuario);
      return { email: u.email || u.usuario, senha };
    },
    { admin: true }
  );

  handle(
    "users:unlock",
    ({ id }) => {
      const u = db().prepare("SELECT * FROM usuarios WHERE id = ?").get(Number(id));
      if (!u) throw new AppError("Usuário não encontrado.");
      db().prepare("UPDATE usuarios SET falhas = 0, bloqueado_ate = NULL WHERE id = ?").run(u.id);
      audit("usuario_desbloqueado", u.email || u.usuario);
      return true;
    },
    { admin: true }
  );

  handle(
    "users:toggle",
    ({ id }) => {
      if (Number(id) === session.id) throw new AppError("Você não pode desativar o seu próprio usuário.");
      const u = db().prepare("SELECT * FROM usuarios WHERE id = ?").get(Number(id));
      if (!u) throw new AppError("Usuário não encontrado.");
      db().prepare("UPDATE usuarios SET ativo = ? WHERE id = ?").run(u.ativo ? 0 : 1, u.id);
      audit(u.ativo ? "usuario_desativado" : "usuario_ativado", u.email || u.usuario);
      return true;
    },
    { admin: true }
  );
}

module.exports = { registerHandlers, dispatch };
