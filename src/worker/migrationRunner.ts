/**
 * Applies the bundled D1 migrations through the Worker's own DB binding
 * (v3.12), so an install deployed with the Deploy to Cloudflare button needs no
 * Wrangler access to its database. Bookkeeping is Wrangler's own
 * `d1_migrations` table, so `wrangler d1 migrations apply` and this runner see
 * the same history and never apply a file twice.
 *
 * Each migration runs as one D1 batch together with its history row: a batch
 * is a transaction, so a failed migration leaves nothing behind, and two
 * isolates racing on the same file cannot both commit it (`name` is unique).
 */
export type Migration = { name: string; sql: string };

const HISTORY = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

export class MigrationError extends Error {
  readonly migration: string;
  constructor(migration: string, cause: unknown) {
    super(`Database migration ${migration} failed`, { cause });
    this.name = "MigrationError";
    this.migration = migration;
  }
}

/**
 * Split a migration file into statements: semicolons inside quotes, comments
 * and CREATE TRIGGER … END blocks do not end a statement.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  let depth = 0; // BEGIN … END nesting inside a trigger body
  const word = (at: number) => sql.slice(at).match(/^[A-Za-z_]+/)?.[0]?.toUpperCase() ?? "";
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end < 0 ? sql.length : end + 1;
      current += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end < 0 ? sql.length : end + 2;
      current += " ";
      continue;
    }
    if (char === "'" || char === "\"" || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === close) {
          if (close !== "]" && sql[end + 1] === close) { end += 2; continue; }
          break;
        }
        end++;
      }
      current += sql.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char) && !/[A-Za-z0-9_]/.test(sql[index - 1] ?? "")) {
      const token = word(index);
      if (token === "BEGIN" && /\bCREATE\s+(?:TEMP\w*\s+)?TRIGGER\b/i.test(current)) depth++;
      else if (token === "END" && depth > 0) depth--;
      current += sql.slice(index, index + token.length);
      index += token.length;
      continue;
    }
    if (char === ";" && depth === 0) {
      if (current.trim()) statements.push(current.trim());
      current = "";
      index++;
      continue;
    }
    current += char;
    index++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** PRAGMA foreign_keys is a no-op inside a transaction; D1 enforces foreign keys anyway. */
const runnable = (statement: string) => !/^PRAGMA\s+foreign_keys\b/i.test(statement);

/** Names of bundled migrations not yet recorded, in file order. */
export function pendingMigrations(migrations: Migration[], applied: Iterable<string>): Migration[] {
  const done = new Set(applied);
  return [...migrations].sort((a, b) => a.name.localeCompare(b.name)).filter(migration => !done.has(migration.name));
}

/** Apply every pending migration; returns the names applied. */
export async function applyMigrations(db: D1Database, migrations: Migration[]): Promise<string[]> {
  await db.prepare(HISTORY).run();
  const { results } = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const applied: string[] = [];
  for (const migration of pendingMigrations(migrations, results.map(row => row.name))) {
    const statements = splitStatements(migration.sql).filter(runnable).map(statement => db.prepare(statement));
    try {
      await db.batch([...statements, db.prepare("INSERT INTO d1_migrations (name) VALUES (?1)").bind(migration.name)]);
    } catch (error) {
      // Another isolate may have applied it a moment ago.
      const done = await db.prepare("SELECT 1 AS yes FROM d1_migrations WHERE name = ?1").bind(migration.name).first<{ yes: number }>();
      if (done) continue;
      throw new MigrationError(migration.name, error);
    }
    applied.push(migration.name);
  }
  return applied;
}
