// Shared fixtures for the Node regression scripts (not itself a test).
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** D1 binding over node:sqlite. `batch` is one transaction and returns each statement's result, as D1 does. */
export function d1(db) {
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...values) => statement(sql, values),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(row => ({ ...row })) }),
    first: async () => { const row = db.prepare(sql).get(...args); return row ? { ...row } : null; },
  });
  return {
    prepare: sql => statement(sql),
    batch: async list => {
      db.exec("BEGIN");
      try {
        const results = list.map(item => ({ meta: { changes: Number(db.prepare(item.sql).run(...item.args).changes) } }));
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** In-memory database with every migration applied. */
export function migratedDatabase({ foreignKeys = false } = {}) {
  const db = new DatabaseSync(":memory:");
  if (foreignKeys) db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter(file => file.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, dir), "utf8"));
  return db;
}
