/* ==========================================================
   MeuChopp — banco de dados local (SQLite)
   O arquivo meuchopp.db fica na pasta de dados do usuário.
   ========================================================== */
const initSqlJs = require("sql.js");
const { CompatDatabase } = require("./sqlite-compat");
const path = require("path");
const fs = require("fs");

let db = null;
const SCHEMA_VERSION = 3;

async function initDatabase(userDataDir) {
  const wasmDir = path.dirname(require.resolve("sql.js"));
  const SQL = await initSqlJs({ locateFile: (file) => path.join(wasmDir, file) });
  const dbFile = path.join(userDataDir, "meuchopp.db");
  const existed = fs.existsSync(dbFile);
  db = new CompatDatabase(SQL, dbFile);

  // Antes de atualizar a estrutura de um banco antigo, guarda uma cópia intacta dele
  const versionBefore = db.prepare("PRAGMA user_version").get().user_version;
  if (existed && versionBefore < SCHEMA_VERSION) {
    const dir = path.join(userDataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    fs.copyFileSync(dbFile, path.join(dir, `meuchopp-antes-da-v${SCHEMA_VERSION}-${stamp}.db`));
  }

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

    CREATE TABLE IF NOT EXISTS usuario_unidades (
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      unidade_id INTEGER NOT NULL REFERENCES unidades(id),
      PRIMARY KEY (usuario_id, unidade_id)
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

  migrate();
  seed();
  return db;
}

/* Atualiza bancos criados em versões anteriores (adiciona colunas de segurança) */
function migrate() {
  const cols = db.prepare("PRAGMA table_info(usuarios)").all().map((c) => c.name);
  const add = (name, ddl) => {
    if (cols.includes(name)) return false;
    db.exec(`ALTER TABLE usuarios ADD COLUMN ${name} ${ddl}`);
    return true;
  };
  const emailAdded = add("email", "TEXT");
  add("falhas", "INTEGER NOT NULL DEFAULT 0");
  add("bloqueado_ate", "INTEGER");
  add("trocar_senha", "INTEGER NOT NULL DEFAULT 0");
  add("ultimo_login", "TEXT");
  // Usuários antigos (sem e-mail) precisam completar o cadastro e trocar a senha no próximo login
  if (emailAdded) db.exec("UPDATE usuarios SET trocar_senha = 1 WHERE email IS NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email COLLATE NOCASE)");

  // Quiosques podem ser desativados
  const unitCols = db.prepare("PRAGMA table_info(unidades)").all().map((c) => c.name);
  if (!unitCols.includes("ativo")) db.exec("ALTER TABLE unidades ADD COLUMN ativo INTEGER NOT NULL DEFAULT 1");

  // v2: acesso por quiosque. Operadores antigos (1 unidade fixa) passam para a nova tabela de acessos.
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version < 2) {
    db.exec(`INSERT OR IGNORE INTO usuario_unidades (usuario_id, unidade_id)
             SELECT id, unidade_id FROM usuarios WHERE cargo = 'operador' AND unidade_id IS NOT NULL`);
    db.exec("PRAGMA user_version = 2");
  }

  // v3: dados cadastrais das unidades, torneiras e engates (barril ↔ torneira).
  // Só ACRESCENTA colunas e tabelas: nenhum registro existente é apagado ou alterado.
  // As colunas novas das unidades ficam vazias (NULL) até o administrador preenchê-las.
  migrateV3();
}

function migrateV3() {
  const colsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  const unitCols = colsOf("unidades");
  if (!unitCols.includes("cnpj")) db.exec("ALTER TABLE unidades ADD COLUMN cnpj TEXT");          // só dígitos
  if (!unitCols.includes("endereco")) db.exec("ALTER TABLE unidades ADD COLUMN endereco TEXT");
  // Um mesmo CNPJ não pode estar em duas unidades (unidades ainda sem CNPJ ficam de fora)
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_unidades_cnpj ON unidades(cnpj) WHERE cnpj IS NOT NULL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS torneiras (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      unidade_id INTEGER NOT NULL REFERENCES unidades(id),
      numero     INTEGER NOT NULL CHECK (numero > 0),
      ativo      INTEGER NOT NULL DEFAULT 1,
      criado_em  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    -- Duas torneiras ATIVAS da mesma unidade não podem ter o mesmo número
    CREATE UNIQUE INDEX IF NOT EXISTS idx_torneiras_numero ON torneiras(unidade_id, numero) WHERE ativo = 1;

    -- Cada período de uso de um barril em uma torneira (engate → retirada).
    -- A torneira está ocupada enquanto existir um engate dela sem retirado_em.
    CREATE TABLE IF NOT EXISTS engates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      barril_id       INTEGER NOT NULL REFERENCES barris(id),
      torneira_id     INTEGER NOT NULL REFERENCES torneiras(id),
      unidade_id      INTEGER NOT NULL REFERENCES unidades(id),
      torneira_numero INTEGER NOT NULL,           -- número da torneira no momento do engate (histórico)
      engatado_por    INTEGER NOT NULL REFERENCES usuarios(id),
      engatado_em     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      retirado_por    INTEGER REFERENCES usuarios(id),
      retirado_em     TEXT,
      CHECK ((retirado_em IS NULL) = (retirado_por IS NULL))
    );
    -- Garantias no próprio banco: uma torneira com no máximo um barril engatado,
    -- e um barril com no máximo um engate ativo.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_engate_torneira_ativa ON engates(torneira_id) WHERE retirado_em IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_engate_barril_ativo   ON engates(barril_id)   WHERE retirado_em IS NULL;
    CREATE INDEX IF NOT EXISTS idx_engates_barril ON engates(barril_id);
  `);

  // O histórico de movimentações passa a guardar a torneira (referência + número usado na hora)
  const movCols = colsOf("movimentacoes");
  if (!movCols.includes("torneira_id")) db.exec("ALTER TABLE movimentacoes ADD COLUMN torneira_id INTEGER REFERENCES torneiras(id)");
  if (!movCols.includes("torneira_numero")) db.exec("ALTER TABLE movimentacoes ADD COLUMN torneira_numero INTEGER");

  if (db.prepare("PRAGMA user_version").get().user_version < 3) db.exec("PRAGMA user_version = 3");
}

/* Dados iniciais: só roda quando o banco está vazio */
function seed() {
  const hasUnits = db.prepare("SELECT COUNT(*) AS n FROM unidades").get().n;
  if (!hasUnits) {
    const ins = db.prepare("INSERT INTO unidades (nome, nome_curto) VALUES (?, ?)");
    ins.run("Louvada Estação Cuiabá", "Estação Cuiabá");
    ins.run("Louvada Pantanal", "Pantanal");
  }
  // Nenhum usuário padrão: o primeiro administrador é criado na tela de configuração inicial.
}

function getDb() {
  if (!db) throw new Error("Banco de dados não inicializado.");
  return db;
}

module.exports = { initDatabase, getDb, SCHEMA_VERSION };
