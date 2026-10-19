// Shared fixtures for the Node regression scripts (not itself a test).
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** D1 allows at most 100 bound parameters per statement; node:sqlite has no such limit. */
export const D1_MAX_BOUND_PARAMETERS = 100;
const checked = args => {
  if (args.length > D1_MAX_BOUND_PARAMETERS) throw new Error(`D1_ERROR: too many SQL variables (${args.length} bound, at most ${D1_MAX_BOUND_PARAMETERS})`);
  return args;
};

/** D1 binding over node:sqlite. `batch` is one transaction and returns each statement's result, as D1 does. */
export function d1(db) {
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...values) => statement(sql, values),
    run: async () => { const r = db.prepare(sql).run(...checked(args)); return { success: true, meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: db.prepare(sql).all(...checked(args)).map(row => ({ ...row })) }),
    first: async () => { const row = db.prepare(sql).get(...checked(args)); return row ? { ...row } : null; },
  });
  return {
    prepare: sql => statement(sql),
    batch: async list => {
      db.exec("BEGIN");
      try {
        const results = list.map(item => ({ meta: { changes: Number(db.prepare(item.sql).run(...checked(item.args)).changes) } }));
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
