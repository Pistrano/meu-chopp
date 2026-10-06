/* ==========================================================
   MeuChopp — camada de acesso ao SQLite (sql.js / WebAssembly)
   Não usa módulos nativos: instala em qualquer Windows sem
   precisar de compilador. O banco fica em memória durante o uso
   e é gravado em disco a cada alteração.
   Expõe uma API parecida com a do better-sqlite3:
     db.prepare(sql).get / all / run,  db.exec,  db.transaction
   ========================================================== */
const fs = require("fs");

/* Dá aos erros do sql.js um "code", como o ipc.js espera */
function tagError(err) {
  const msg = String(err && err.message);
  if (/UNIQUE constraint failed/i.test(msg)) err.code = "SQLITE_CONSTRAINT_UNIQUE";
  else if (/constraint failed/i.test(msg)) err.code = "SQLITE_CONSTRAINT";
  return err;
}

/* Aceita (a, b, c) | ([a, b, c]) | ({ nome: valor }) */
function normalizeParams(args) {
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (args.length === 1 && isObj(args[0])) {
    const out = {};
    for (const [k, v] of Object.entries(args[0])) out[/^[:@$]/.test(k) ? k : "@" + k] = v === undefined ? null : v;
    return out;
  }
  const arr = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  return arr.map((v) => (v === undefined ? null : v));
}

class Statement {
  constructor(owner, sql) {
    this.owner = owner;
    this.sql = sql;
  }

  _with(args, fn) {
    const st = this.owner.raw.prepare(this.sql);
    try {
      st.bind(normalizeParams(args));
      return fn(st);
    } catch (err) {
      throw tagError(err);
    } finally {
      st.free();
    }
  }

  all(...args) {
    return this._with(args, (st) => {
      const rows = [];
      while (st.step()) rows.push(st.getAsObject());
      return rows;
    });
  }

  get(...args) {
    return this._with(args, (st) => (st.step() ? st.getAsObject() : undefined));
  }

  run(...args) {
    const info = this._with(args, (st) => {
      st.step();
      const changes = this.owner.raw.getRowsModified();
      const last = this.owner.raw.exec("SELECT last_insert_rowid()")[0].values[0][0];
      return { changes, lastInsertRowid: last };
    });
    this.owner._changed();
    return info;
  }
}

class CompatDatabase {
  constructor(SQL, filePath) {
    this.file = filePath;
    this.depth = 0; // > 0 enquanto dentro de uma transação
    const data = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
    this.raw = data ? new SQL.Database(data) : new SQL.Database();
    this.raw.run("PRAGMA foreign_keys = ON");
  }

  exec(sql) {
    try {
      this.raw.exec(sql);
    } catch (err) {
      throw tagError(err);
    }
    this._changed();
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  transaction(fn) {
    return (...args) => {
      if (this.depth > 0) return fn(...args); // já dentro de uma transação
      this.raw.run("BEGIN");
      this.depth = 1;
      let result;
      try {
        result = fn(...args);
        this.raw.run("COMMIT");
      } catch (err) {
        try { this.raw.run("ROLLBACK"); } catch (_) { /* já desfeito pelo SQLite */ }
        this.depth = 0;
        throw err;
      }
      this.depth = 0;
      this.save();
      return result;
    };
  }

  _changed() {
    if (this.depth === 0) this.save();
  }

  /* Grava o banco no disco (escreve num arquivo temporário e troca, para não corromper) */
  save() {
    const data = Buffer.from(this.raw.export());
    this.raw.run("PRAGMA foreign_keys = ON"); // export() reinicia as pragmas
    const tmp = this.file + ".tmp";
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, this.file);
    } catch (_) {
      fs.writeFileSync(this.file, data);
    }
  }
}

module.exports = { CompatDatabase };
