/* ==========================================================
   MeuChopp — regras de negócio (canais IPC)
   Toda operação passa por aqui: valida permissão, grava no
   banco e registra quem fez (movimentação + auditoria).
   ========================================================== */
const { ipcMain, dialog, BrowserWindow } = require("electron");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const { getDb } = require("./db");

let session = null; // usuário logado

const CARGO_LABEL = { admin: "Administrador", operador: "Operador" };

/* ---------- Infraestrutura ---------- */
function handle(channel, fn, { auth = true, admin = false } = {}) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      if (auth && !session) throw new Error("Sessão expirada. Faça login novamente.");
      if (admin && session.cargo !== "admin")
        throw new Error("Apenas administradores podem executar esta ação.");
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      if (err && String(err.code).startsWith("SQLITE_CONSTRAINT_UNIQUE"))
        return { ok: false, error: "Já existe um registro com esse valor." };
      return { ok: false, error: err.message || "Erro inesperado." };
    }
  });
}

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

/* Operador só enxerga/mexe na própria unidade; admin em todas */
function assertUnit(unitId) {
  if (session.cargo !== "admin" && session.unidade_id !== unitId)
    throw new Error("Você não tem permissão para operar nesta unidade.");
}

function resolveUnit(unitId) {
  if (session.cargo !== "admin") return session.unidade_id;
  const id = Number(unitId);
  if (id) return id;
  const first = getDb().prepare("SELECT id FROM unidades ORDER BY id LIMIT 1").get();
  return first ? first.id : null;
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
    usuario: u.usuario,
    cargo: u.cargo,
    cargoLabel: CARGO_LABEL[u.cargo],
    unidade_id: u.unidade_id,
    iniciais: u.nome.trim().charAt(0).toUpperCase(),
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
  handle(
    "auth:login",
    ({ identifier, password }) => {
      const user = db()
        .prepare("SELECT * FROM usuarios WHERE usuario = ? AND ativo = 1")
        .get(String(identifier || "").trim());
      const ok = user && bcrypt.compareSync(String(password || ""), user.senha_hash);
      if (!ok) {
        audit("login_falhou", `Tentativa com usuário "${identifier}"`, user ? user.id : null);
        throw new Error("Usuário ou senha incorretos.");
      }
      session = publicUser(user);
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

  handle("auth:changePassword", ({ atual, nova }) => {
    if (!nova || String(nova).length < 6) throw new Error("A nova senha precisa ter ao menos 6 caracteres.");
    const u = db().prepare("SELECT * FROM usuarios WHERE id = ?").get(session.id);
    if (!bcrypt.compareSync(String(atual || ""), u.senha_hash)) throw new Error("Senha atual incorreta.");
    db().prepare("UPDATE usuarios SET senha_hash = ? WHERE id = ?").run(bcrypt.hashSync(String(nova), 10), u.id);
    audit("senha_alterada", "Alterou a própria senha");
    return true;
  });

  /* ======== Unidades ======== */
  handle("units:list", () => {
    if (session.cargo === "admin") return db().prepare("SELECT * FROM unidades ORDER BY id").all();
    return db().prepare("SELECT * FROM unidades WHERE id = ?").all(session.unidade_id);
  });
  handle("units:all", () => db().prepare("SELECT * FROM unidades ORDER BY id").all());

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
      if (!db().prepare("SELECT 1 FROM unidades WHERE id = ?").get(destino)) throw new Error("Unidade de destino inválida.");
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
  handle("users:list", () =>
    db()
      .prepare(
        `SELECT u.id, u.nome, u.usuario, u.cargo, u.ativo, u.unidade_id, un.nome_curto AS unidade
           FROM usuarios u LEFT JOIN unidades un ON un.id = u.unidade_id ORDER BY u.nome`
      )
      .all(),
    { admin: true }
  );

  handle(
    "users:create",
    ({ nome, usuario, senha, cargo, unidadeId }) => {
      nome = String(nome || "").trim();
      usuario = String(usuario || "").trim();
      if (!nome || !usuario) throw new Error("Informe nome e usuário.");
      if (!senha || String(senha).length < 6) throw new Error("A senha precisa ter ao menos 6 caracteres.");
      if (!["admin", "operador"].includes(cargo)) throw new Error("Cargo inválido.");
      if (cargo === "operador" && !Number(unidadeId)) throw new Error("Escolha a unidade do operador.");
      try {
        db()
          .prepare("INSERT INTO usuarios (nome, usuario, senha_hash, cargo, unidade_id) VALUES (?, ?, ?, ?, ?)")
          .run(nome, usuario, bcrypt.hashSync(String(senha), 10), cargo, cargo === "operador" ? Number(unidadeId) : null);
      } catch (e) {
        if (String(e.code).startsWith("SQLITE_CONSTRAINT")) throw new Error(`O usuário "${usuario}" já existe.`);
        throw e;
      }
      audit("usuario_criado", `${usuario} (${cargo})`);
      return true;
    },
    { admin: true }
  );

  handle(
    "users:toggle",
    ({ id }) => {
      if (Number(id) === session.id) throw new Error("Você não pode desativar o seu próprio usuário.");
      const u = db().prepare("SELECT * FROM usuarios WHERE id = ?").get(Number(id));
      if (!u) throw new Error("Usuário não encontrado.");
      db().prepare("UPDATE usuarios SET ativo = ? WHERE id = ?").run(u.ativo ? 0 : 1, u.id);
      audit(u.ativo ? "usuario_desativado" : "usuario_ativado", u.usuario);
      return true;
    },
    { admin: true }
  );

  handle(
    "users:resetPassword",
    ({ id, senha }) => {
      if (!senha || String(senha).length < 6) throw new Error("A senha precisa ter ao menos 6 caracteres.");
      const u = db().prepare("SELECT * FROM usuarios WHERE id = ?").get(Number(id));
      if (!u) throw new Error("Usuário não encontrado.");
      db().prepare("UPDATE usuarios SET senha_hash = ? WHERE id = ?").run(bcrypt.hashSync(String(senha), 10), u.id);
      audit("senha_redefinida", u.usuario);
      return true;
    },
    { admin: true }
  );
}

module.exports = { registerHandlers };
