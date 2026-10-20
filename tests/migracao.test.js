/* ==========================================================
   MeuChopp — teste da migração v2 → v3
   Monta um banco no formato ANTIGO (como o que já está em uso), com dados,
   liga o servidor novo em cima dele e confere que nada foi perdido.
   ========================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { tempDir, startServer, client, openDbFile, rows } = require("./helpers");

// Estrutura do banco na versão 2 (antes das torneiras)
const V2_SCHEMA = `
  CREATE TABLE unidades (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL UNIQUE, nome_curto TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, usuario TEXT NOT NULL UNIQUE COLLATE NOCASE, senha_hash TEXT NOT NULL,
    cargo TEXT NOT NULL CHECK (cargo IN ('admin','operador')), unidade_id INTEGER REFERENCES unidades(id), ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')), email TEXT, falhas INTEGER NOT NULL DEFAULT 0, bloqueado_ate INTEGER,
    trocar_senha INTEGER NOT NULL DEFAULT 0, ultimo_login TEXT);
  CREATE UNIQUE INDEX idx_usuarios_email ON usuarios(email COLLATE NOCASE);
  CREATE TABLE usuario_unidades (usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, unidade_id INTEGER NOT NULL REFERENCES unidades(id), PRIMARY KEY (usuario_id, unidade_id));
  CREATE TABLE barris (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL UNIQUE, estilo TEXT NOT NULL, tamanho_l INTEGER NOT NULL CHECK (tamanho_l > 0),
    status TEXT NOT NULL DEFAULT 'disponivel' CHECK (status IN ('disponivel','em_uso','em_transferencia','esgotado')),
    unidade_id INTEGER NOT NULL REFERENCES unidades(id), criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')));
  CREATE TABLE movimentacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, barril_id INTEGER NOT NULL REFERENCES barris(id),
    operacao TEXT NOT NULL CHECK (operacao IN ('entrada','transferencia','utilizacao','esgotado')), usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    origem_unidade_id INTEGER REFERENCES unidades(id), destino_unidade_id INTEGER REFERENCES unidades(id), observacao TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')));
  CREATE TABLE transferencias (id INTEGER PRIMARY KEY AUTOINCREMENT, barril_id INTEGER NOT NULL REFERENCES barris(id), origem_id INTEGER NOT NULL REFERENCES unidades(id),
    destino_id INTEGER NOT NULL REFERENCES unidades(id), solicitante_id INTEGER NOT NULL REFERENCES usuarios(id), recebedor_id INTEGER REFERENCES usuarios(id),
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','confirmada','cancelada')),
    criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')), resolvido_em TEXT);
  CREATE TABLE auditoria (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER REFERENCES usuarios(id), acao TEXT NOT NULL, detalhe TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')));
  PRAGMA user_version = 2;`;

let dataDir, srv, admin, antes, logoAposMigrar;
const TABELAS = ["unidades", "usuarios", "usuario_unidades", "barris", "movimentacoes", "transferencias", "auditoria"];

before(async () => {
  dataDir = tempDir("meuchopp-migracao-");
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec(V2_SCHEMA);
  const hash = bcrypt.hashSync("SenhaAntiga123", 4);
  db.exec(`
    INSERT INTO unidades (nome, nome_curto) VALUES ('Louvada Estação Cuiabá','Estação Cuiabá'), ('Louvada Pantanal','Pantanal');
    INSERT INTO usuarios (nome, usuario, email, senha_hash, cargo) VALUES ('Raphael','raphael@meuchopp.com','raphael@meuchopp.com','${hash}','admin');
    INSERT INTO usuarios (nome, usuario, email, senha_hash, cargo) VALUES ('Ana','ana@meuchopp.com','ana@meuchopp.com','${hash}','operador');
    INSERT INTO usuario_unidades VALUES (2, 1);
    INSERT INTO barris (codigo, estilo, tamanho_l, status, unidade_id) VALUES
      ('0101','Pilsen',30,'disponivel',1), ('0102','IPA',50,'em_uso',1), ('0103','Weiss',30,'esgotado',1), ('0104','Pilsen',30,'em_transferencia',1);
    INSERT INTO movimentacoes (barril_id, operacao, usuario_id, origem_unidade_id, destino_unidade_id, observacao, criado_em) VALUES
      (1,'entrada',1,NULL,1,'Cadastro do barril','2026-10-10 10:00:00'),
      (2,'entrada',1,NULL,1,'Cadastro do barril','2026-10-10 10:01:00'),
      (2,'utilizacao',2,1,NULL,NULL,'2026-10-11 18:00:00'),
      (3,'esgotado',2,1,NULL,NULL,'2026-10-12 23:00:00'),
      (4,'transferencia',1,1,2,NULL,'2026-10-13 09:00:00');
    INSERT INTO transferencias (barril_id, origem_id, destino_id, solicitante_id) VALUES (4, 1, 2, 1);
    INSERT INTO auditoria (usuario_id, acao, detalhe) VALUES (1,'configuracao_inicial','x'), (1,'login','y');`);
  fs.writeFileSync(path.join(dataDir, "meuchopp.db"), Buffer.from(db.export()));
  antes = Object.fromEntries(TABELAS.map((t) => [t, rows(db, `SELECT * FROM ${t} ORDER BY rowid`)]));

  srv = await startServer(dataDir);
  // fotografia do banco logo depois da migração, antes de qualquer login
  // (o login muda de propósito o "último acesso" e grava uma linha na auditoria)
  logoAposMigrar = await openDbFile(path.join(dataDir, "meuchopp.db"));
  admin = client(srv.base);
  await admin.ok("auth:login", { identifier: "raphael@meuchopp.com", password: "SenhaAntiga123" });
});
after(async () => { if (srv) await srv.stop(); });

test("a migração não apaga nem altera nenhum registro existente", async () => {
  const depois = logoAposMigrar;
  assert.equal(rows(depois, "PRAGMA user_version")[0].user_version, 3);
  for (const t of TABELAS) {
    const atual = rows(depois, `SELECT * FROM ${t} ORDER BY rowid`);
    assert.equal(atual.length, antes[t].length, `quantidade de registros em ${t}`);
    // cada registro antigo continua com os mesmos valores (colunas novas ficam vazias)
    antes[t].forEach((velho, i) => {
      for (const [k, v] of Object.entries(velho)) assert.deepEqual(atual[i][k], v, `${t}.${k} do registro ${i + 1}`);
    });
  }
  const units = rows(depois, "SELECT id, nome, cnpj, endereco FROM unidades ORDER BY id");
  assert.deepEqual(units, [
    { id: 1, nome: "Louvada Estação Cuiabá", cnpj: null, endereco: null },
    { id: 2, nome: "Louvada Pantanal", cnpj: null, endereco: null },
  ]);
});

test("guarda uma cópia do banco antigo antes de migrar", () => {
  const backups = fs.readdirSync(path.join(dataDir, "backups")).filter((f) => f.startsWith("meuchopp-antes-da-v3-"));
  assert.equal(backups.length, 1);
});

test("religar o servidor não repete a migração nem duplica unidades", async () => {
  await srv.stop();
  srv = await startServer(dataDir);
  admin = client(srv.base);
  await admin.ok("auth:login", { identifier: "raphael@meuchopp.com", password: "SenhaAntiga123" });
  assert.equal((await admin.ok("units:adminList")).length, 2);
  assert.equal(fs.readdirSync(path.join(dataDir, "backups")).filter((f) => f.startsWith("meuchopp-antes-da-v3-")).length, 1);
});

test("barril que já estava em uso (sem torneira registrada) é retirado com segurança", async () => {
  await admin.ok("taps:create", { unitId: 1, quantidade: 2 });
  const b = (await admin.ok("barris:list", { unitId: 1 })).find((x) => x.codigo === "0102");
  assert.equal(b.status, "em_uso");
  assert.equal(b.torneira_numero, null);
  const r = await admin.ok("barris:empty", { id: b.id });
  assert.equal(r.torneira, null, "não inventa uma torneira");
  const taps = (await admin.ok("units:details", { id: 1 })).torneiras;
  assert.ok(taps.every((t) => !t.ocupada), "nenhuma torneira foi liberada ou ocupada indevidamente");
  const h = (await admin.ok("history:list", { unitId: 1, q: "0102" }))[0];
  assert.equal(h.operacao, "esgotado");
  assert.match(h.observacao, /sem torneira registrada/);
});

test("operações antigas continuam funcionando depois da migração", async () => {
  // transferência pendente criada na versão antiga pode ser confirmada
  const t = (await admin.ok("transfer:list", { unitId: 2 }))[0];
  await admin.ok("transfer:confirm", { id: t.id });
  assert.equal((await admin.ok("barris:list", { unitId: 2 }))[0].status, "disponivel");
  // operador antigo continua com acesso só à unidade dele e engata com torneira
  const ana = client(srv.base);
  await ana.ok("auth:login", { identifier: "ana@meuchopp.com", password: "SenhaAntiga123" });
  assert.deepEqual((await ana.ok("units:list")).map((u) => u.id), [1]);
  const b = (await ana.ok("barris:list", { unitId: 1 })).find((x) => x.codigo === "0101");
  const { torneiras } = await ana.ok("taps:forBarril", { barrilId: b.id });
  assert.equal((await ana.ok("barris:use", { id: b.id, torneiraId: torneiras[0].id })).torneira, 1);
  // o histórico antigo continua acessível, junto com o novo
  const hist = await admin.ok("history:list", { unitId: 1 });
  assert.ok(hist.some((m) => m.criado_em === "2026-10-11 18:00:00" && m.responsavel === "Ana"));
});
