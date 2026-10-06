/* ==========================================================
   MeuChopp — banco de dados local (SQLite)
   O arquivo meuchopp.db fica na pasta de dados do usuário.
   ========================================================== */
const initSqlJs = require("sql.js");
const { CompatDatabase } = require("./sqlite-compat");
const bcrypt = require("bcryptjs");
const path = require("path");

let db = null;

async function initDatabase(userDataDir) {
  const wasmDir = path.dirname(require.resolve("sql.js"));
  const SQL = await initSqlJs({ locateFile: (file) => path.join(wasmDir, file) });
  db = new CompatDatabase(SQL, path.join(userDataDir, "meuchopp.db"));

  db.exec(`
    CREATE TABLE IF NOT EXISTS unidades (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nome       TEXT NOT NULL UNIQUE,
      nome_curto TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usuarios (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nome       TEXT NOT NULL,
      usuario    TEXT NOT NULL UNIQUE COLLATE NOCASE,
      senha_hash TEXT NOT NULL,
      cargo      TEXT NOT NULL CHECK (cargo IN ('admin','operador')),
      unidade_id INTEGER REFERENCES unidades(id),
      ativo      INTEGER NOT NULL DEFAULT 1,
      criado_em  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS barris (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo     TEXT NOT NULL UNIQUE,
      estilo     TEXT NOT NULL,
      tamanho_l  INTEGER NOT NULL CHECK (tamanho_l > 0),
      status     TEXT NOT NULL DEFAULT 'disponivel'
                 CHECK (status IN ('disponivel','em_uso','em_transferencia','esgotado')),
      unidade_id INTEGER NOT NULL REFERENCES unidades(id),
      criado_em  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS movimentacoes (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      barril_id          INTEGER NOT NULL REFERENCES barris(id),
      operacao           TEXT NOT NULL
                         CHECK (operacao IN ('entrada','transferencia','utilizacao','esgotado')),
      usuario_id         INTEGER NOT NULL REFERENCES usuarios(id),
      origem_unidade_id  INTEGER REFERENCES unidades(id),
      destino_unidade_id INTEGER REFERENCES unidades(id),
      observacao         TEXT,
      criado_em          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS transferencias (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      barril_id      INTEGER NOT NULL REFERENCES barris(id),
      origem_id      INTEGER NOT NULL REFERENCES unidades(id),
      destino_id     INTEGER NOT NULL REFERENCES unidades(id),
      solicitante_id INTEGER NOT NULL REFERENCES usuarios(id),
      recebedor_id   INTEGER REFERENCES usuarios(id),
      status         TEXT NOT NULL DEFAULT 'pendente'
                     CHECK (status IN ('pendente','confirmada','cancelada')),
      criado_em      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      resolvido_em   TEXT
    );

    CREATE TABLE IF NOT EXISTS auditoria (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER REFERENCES usuarios(id),
      acao       TEXT NOT NULL,
      detalhe    TEXT,
      criado_em  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_mov_barril ON movimentacoes(barril_id);
    CREATE INDEX IF NOT EXISTS idx_mov_data   ON movimentacoes(criado_em);
    CREATE INDEX IF NOT EXISTS idx_barris_un  ON barris(unidade_id, status);
  `);

  seed();
  return db;
}

/* Dados iniciais: só roda quando o banco está vazio */
function seed() {
  const hasUnits = db.prepare("SELECT COUNT(*) AS n FROM unidades").get().n;
  if (!hasUnits) {
    const ins = db.prepare("INSERT INTO unidades (nome, nome_curto) VALUES (?, ?)");
    ins.run("Louvada Estação Cuiabá", "Estação Cuiabá");
    ins.run("Louvada Pantanal", "Pantanal");
  }

  const hasUsers = db.prepare("SELECT COUNT(*) AS n FROM usuarios").get().n;
  if (!hasUsers) {
    db.prepare(
      "INSERT INTO usuarios (nome, usuario, senha_hash, cargo) VALUES (?, ?, ?, 'admin')"
    ).run("Eduardo", "admin", bcrypt.hashSync("admin123", 10));
  }
}

function getDb() {
  if (!db) throw new Error("Banco de dados não inicializado.");
  return db;
}

module.exports = { initDatabase, getDb };
