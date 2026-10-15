/* ==========================================================
   MeuChopp — regras de negócio (canais IPC)
   Toda operação passa por aqui: valida permissão, grava no
   banco e registra quem fez (movimentação + auditoria).
   ========================================================== */
const { ipcMain, dialog, BrowserWindow } = require("electron");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const crypto = require("crypto");
const { getDb } = require("./db");

let session = null; // usuário logado

const CARGO_LABEL = { admin: "Administrador", operador: "Operador" };

/* ---------- Infraestrutura ---------- */
const IDLE_MS = 15 * 60 * 1000;          // sessão expira após 15 min sem atividade
const MAX_FALHAS = 5;                     // tentativas erradas antes de bloquear
const BLOQUEIO_MS = 15 * 60 * 1000;       // duração do bloqueio
const PERMITIDOS_TROCA = new Set(["auth:me", "auth:logout", "auth:ping", "auth:completeProfile"]);
let lastActivity = 0;

class AppError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.appCode = code;
    this.detail = detail;
  }
}

function handle(channel, fn, { auth = true, admin = false } = {}) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      if (auth) {
        if (session && Date.now() - lastActivity > IDLE_MS) {
          audit("sessao_expirada", "Encerrada por inatividade");
          session = null;
          throw new AppError("Sua sessão expirou por inatividade. Entre novamente.", "SESSION");
        }
        if (!session) throw new AppError("Sessão expirada. Faça login novamente.", "SESSION");
        if (session.trocarSenha && !PERMITIDOS_TROCA.has(channel))
          throw new AppError("Defina sua senha para continuar.", "MUST_CHANGE");
        lastActivity = Date.now();
      }
      if (admin && session.cargo !== "admin") throw new AppError("Apenas administradores podem executar esta ação.");
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      if (err && String(err.code).startsWith("SQLITE_CONSTRAINT_UNIQUE"))
        return { ok: false, error: "Já existe um registro com esse valor." };
      if (err && err.appCode === "FORBIDDEN" && session) {
        try { audit("acesso_negado", `${channel}: ${err.detail || err.message}`); } catch (_) { /* ignora */ }
      }
      return { ok: false, error: err.message || "Erro inesperado.", code: err.appCode };
    }
  });
}

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

const emailTaken = (email, exceptId = 0) =>
  !!getDb().prepare("SELECT 1 FROM usuarios WHERE lower(email) = ? AND id <> ?").get(email, exceptId);

function audit(acao, detalhe, userId = session ? session.id : null) {
  getDb()
    .prepare("INSERT INTO auditoria (usuario_id, acao, detalhe) VALUES (?, ?, ?)")
    .run(userId, acao, detalhe || null);
}

function logMovement({ barrilId, operacao, origem = null, destino = null, obs = null }) {
  getDb()
    .prepare(
      `INSERT INTO movimentacoes (barril_id, operacao, usuario_id, origem_unidade_id, destino_unidade_id, observacao)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(barrilId, operacao, session.id, origem, destino, obs);
}

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
    throw new AppError("Você não tem acesso a este quiosque.", "FORBIDDEN", `quiosque ${id}`);
}

/* Quiosque em uso na tela: o pedido (se permitido) ou o primeiro liberado para o usuário */
function resolveUnit(unitId) {
  const allowed = allowedUnitIds();
  if (!allowed.length)
    throw new AppError("Você ainda não tem acesso a nenhum quiosque. Peça a um administrador para liberar.");
  const id = Number(unitId);
  if (!id) return allowed[0];
  if (!allowed.includes(id)) throw new AppError("Você não tem acesso a este quiosque.", "FORBIDDEN", `quiosque ${id}`);
  return id;
}

function loadBarril(id) {
  const b = getDb().prepare("SELECT * FROM barris WHERE id = ?").get(Number(id));
  if (!b) throw new Error("Barril não encontrado.");
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
    SELECT m.id, m.operacao, m.criado_em, m.observacao,
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
    lastActivity = Date.now();
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
        audit("login_falhou", `Tentativa com "${ident}"`, user ? user.id : null);
        throw new AppError(until > now ? lockMessage(until) : GENERIC);
      }

      db()
        .prepare("UPDATE usuarios SET falhas = 0, bloqueado_ate = NULL, ultimo_login = datetime('now','localtime') WHERE id = ?")
        .run(user.id);
      unknownAttempts.delete(ident);
      startSession(user);
      audit("login", "Entrou no sistema");
      return session;
    },
    { auth: false }
  );

  handle("auth:logout", () => {
    audit("logout", "Saiu do sistema");
    session = null;
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
          `SELECT u.id, u.nome, u.nome_curto, u.ativo,
                  (SELECT COUNT(*) FROM barris b WHERE b.unidade_id = u.id) AS barris,
                  (SELECT COUNT(*) FROM usuario_unidades ua JOIN usuarios us ON us.id = ua.usuario_id
                    WHERE ua.unidade_id = u.id AND us.ativo = 1) AS usuarios
             FROM unidades u ORDER BY u.id`
        )
        .all(),
    { admin: true }
  );

  const cleanUnitNames = ({ nome, nomeCurto }, exceptId = 0) => {
    const full = String(nome || "").trim();
    const short = String(nomeCurto || "").trim() || full;
    if (full.length < 2) throw new AppError("Informe o nome do quiosque.");
    if (full.length > 60 || short.length > 30) throw new AppError("Nome muito longo (máximo 60 e 30 caracteres).");
    if (db().prepare("SELECT 1 FROM unidades WHERE lower(nome) = lower(?) AND id <> ?").get(full, exceptId))
      throw new AppError(`Já existe um quiosque chamado "${full}".`);
    return { full, short };
  };

  handle(
    "units:create",
    (p) => {
      const { full, short } = cleanUnitNames(p);
      db().prepare("INSERT INTO unidades (nome, nome_curto) VALUES (?, ?)").run(full, short);
      audit("quiosque_criado", full);
      return true;
    },
    { admin: true }
  );

  handle(
    "units:update",
    (p) => {
      const id = Number(p.id);
      if (!db().prepare("SELECT 1 FROM unidades WHERE id = ?").get(id)) throw new AppError("Quiosque não encontrado.");
      const { full, short } = cleanUnitNames(p, id);
      db().prepare("UPDATE unidades SET nome = ?, nome_curto = ? WHERE id = ?").run(full, short, id);
      audit("quiosque_editado", full);
      return true;
    },
    { admin: true }
  );

  handle(
    "units:toggle",
    ({ id }) => {
      const u = db().prepare("SELECT * FROM unidades WHERE id = ?").get(Number(id));
      if (!u) throw new AppError("Quiosque não encontrado.");
      if (u.ativo) {
        const emEstoque = db()
          .prepare("SELECT COUNT(*) AS n FROM barris WHERE unidade_id = ? AND status <> 'esgotado'")
          .get(u.id).n;
        const recebendo = db()
          .prepare("SELECT COUNT(*) AS n FROM transferencias WHERE destino_id = ? AND status = 'pendente'")
          .get(u.id).n;
        if (emEstoque || recebendo)
          throw new AppError(
            `Este quiosque ainda tem ${emEstoque} barril(is) em estoque e ${recebendo} transferência(s) a receber. Resolva antes de desativar.`
          );
      }
      db().prepare("UPDATE unidades SET ativo = ? WHERE id = ?").run(u.ativo ? 0 : 1, u.id);
      audit(u.ativo ? "quiosque_desativado" : "quiosque_reativado", u.nome);
      return true;
    },
    { admin: true }
  );

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
        `SELECT b.*, u.nome_curto AS unidade
           FROM barris b JOIN unidades u ON u.id = b.unidade_id
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
    if (!cod || !est || !(tam > 0)) throw new Error("Preencha código, estilo e tamanho do barril.");
    const unit = resolveUnit(unitId);
    assertUnit(unit);

    return db().transaction(() => {
      let info;
      try {
        info = db()
          .prepare("INSERT INTO barris (codigo, estilo, tamanho_l, unidade_id) VALUES (?, ?, ?, ?)")
          .run(cod, est, tam, unit);
      } catch (e) {
        if (String(e.code).startsWith("SQLITE_CONSTRAINT")) throw new Error(`Já existe um barril com o código #${cod}.`);
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
          throw new Error(`O barril #${b.codigo} não está no status esperado para esta ação.`);
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

  changeStatus("barris:use",    { from: "disponivel", to: "em_uso",     operacao: "utilizacao", obs: null, auditName: "barril_em_uso" });
  changeStatus("barris:empty",  { from: "em_uso",     to: "esgotado",   operacao: "esgotado",   obs: null, auditName: "barril_esgotado" });
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
      if (!destino || destino === b.unidade_id) throw new Error("Escolha uma unidade de destino diferente da origem.");
      if (!db().prepare("SELECT 1 FROM unidades WHERE id = ? AND ativo = 1").get(destino)) throw new AppError("Quiosque de destino inválido ou desativado.");
      if (b.status !== "disponivel") throw new Error(`Só é possível transferir barris disponíveis (#${b.codigo} está indisponível).`);

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
      if (!t || t.status !== "pendente") throw new Error("Transferência não está pendente.");
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
      if (!t || t.status !== "pendente") throw new Error("Transferência não está pendente.");
      assertUnit(t.origem_id); // quem enviou é quem cancela
      const b = db().prepare("SELECT * FROM barris WHERE id = ?").get(t.barril_id);

      db().prepare("UPDATE barris SET status = 'disponivel' WHERE id = ?").run(b.id);
      db()
        .prepare("UPDATE transferencias SET status='cancelada', resolvido_em=datetime('now','localtime') WHERE id=?")
        .run(t.id);
      audit("transferencia_cancelada", `Barril #${b.codigo}`);
      return true;
    })()
  );

  /* ======== Histórico e relatórios ======== */
  handle("history:list", ({ unitId, q, operacao }) =>
    queryMovements({ unitId: resolveUnit(unitId), q, operacao, limit: 300 })
  );

  handle("history:export", async ({ unitId, q, operacao }) => {
    const rows = queryMovements({ unitId: resolveUnit(unitId), q, operacao });
    const labels = { entrada: "Entrada", transferencia: "Transferência", utilizacao: "Utilização", esgotado: "Chopp Esgotado" };
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["Data/Hora", "Barril", "Estilo", "Operação", "Origem", "Destino", "Responsável", "Observação"];
    const lines = rows.map((r) =>
      [r.criado_em, "#" + r.codigo, r.estilo, labels[r.operacao], r.origem || "Fábrica", r.destino || "", r.responsavel, r.observacao]
        .map(esc)
        .join(";")
    );
    const csv = "\uFEFF" + [header.map(esc).join(";"), ...lines].join("\r\n"); // BOM p/ Excel abrir com acentos

    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "Salvar relatório",
      defaultPath: "relatorio-movimentacoes.csv",
      filters: [{ name: "Planilha CSV", extensions: ["csv"] }],
    });
    if (canceled || !filePath) return { cancelled: true };
    fs.writeFileSync(filePath, csv, "utf8");
    audit("relatorio_exportado", `${rows.length} movimentações`);
    return { path: filePath, total: rows.length };
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
    if (!list.length) throw new AppError("Escolha ao menos um quiosque para o operador.");
    const valid = db().prepare("SELECT id FROM unidades WHERE ativo = 1").all().map((r) => r.id);
    if (list.some((id) => !valid.includes(id))) throw new AppError("Quiosque inválido ou desativado.");
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
      if (u.cargo === "admin") throw new AppError("Administradores têm acesso a todos os quiosques.");
      const units = cleanUnitIds(unidadeIds);
      db().transaction(() => {
        db().prepare("DELETE FROM usuario_unidades WHERE usuario_id = ?").run(u.id);
        units.forEach((uid) => db().prepare("INSERT INTO usuario_unidades (usuario_id, unidade_id) VALUES (?, ?)").run(u.id, uid));
        audit("acesso_alterado", `${u.email || u.usuario}: quiosques ${units.join(", ")}`);
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

module.exports = { registerHandlers };
