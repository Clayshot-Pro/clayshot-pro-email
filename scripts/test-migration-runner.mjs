// v3.12: the Worker applies its own migrations through the D1 binding, with
// Wrangler's d1_migrations bookkeeping, so either can run them.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, pendingMigrations, splitStatements } from "../src/worker/migrationRunner.ts";
import { d1 } from "./test-harness.mjs";

const dir = new URL("../migrations/", import.meta.url);
const MIGRATIONS = readdirSync(dir).filter(file => file.endsWith(".sql")).sort()
  .map(name => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));
const schema = db => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'd1_migrations' ORDER BY type, name").all()
  .map(row => `${row.type} ${row.name}: ${String(row.sql).replace(/\s+/g, " ")}`);
const fresh = () => { const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON"); return db; };

// Splitting respects quotes, comments and trigger bodies.
assert.deepEqual(splitStatements("CREATE TABLE a (x TEXT DEFAULT 'a;b'); -- c;d\nINSERT INTO a VALUES (\"q;\") ; /* ; */ SELECT 1"),
  ["CREATE TABLE a (x TEXT DEFAULT 'a;b')", "INSERT INTO a VALUES (\"q;\")", "SELECT 1"]);
assert.equal(splitStatements("CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = 1; DELETE FROM a; END; SELECT 2").length, 2);
assert.equal(splitStatements("SELECT 'it''s; fine'; SELECT 3").length, 2);
// CASE … END inside a trigger body does not close the trigger early.
const caseTrigger = splitStatements("CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = CASE WHEN y THEN 1 ELSE 0 END; DELETE FROM a; END; SELECT 4");
assert.equal(caseTrigger.length, 2);
assert.match(caseTrigger[0], /DELETE FROM a; END$/);
assert.equal(splitStatements("SELECT CASE WHEN 1 THEN 2 END; SELECT 5").length, 2, "CASE outside a trigger is a plain expression");
assert.equal(splitStatements("CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET end1 = case2; DELETE FROM a; END; SELECT 6").length, 2,
  "identifiers like end1 or case2 are not keywords");
for (const migration of MIGRATIONS) assert.ok(splitStatements(migration.sql).length > 0, `${migration.name} has statements`);

// A fresh database ends up exactly as applying the files directly would leave it.
{
  const reference = fresh();
  for (const migration of MIGRATIONS) reference.exec(migration.sql);
  const db = fresh();
  const applied = await applyMigrations(d1(db), MIGRATIONS);
  assert.deepEqual(applied, MIGRATIONS.map(m => m.name));
  assert.deepEqual(schema(db), schema(reference), "same schema as the files applied directly");
  assert.deepEqual(db.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map(r => r.name), MIGRATIONS.map(m => m.name));
  assert.deepEqual(await applyMigrations(d1(db), MIGRATIONS), [], "running again applies nothing");
}

// A database migrated by Wrangler (same history table) is left alone; only new files apply.
{
  const db = fresh();
  db.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const older = MIGRATIONS.slice(0, -2);
  for (const migration of older) { db.exec(migration.sql); db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(migration.name); }
  assert.deepEqual(pendingMigrations(MIGRATIONS, older.map(m => m.name)).map(m => m.name), MIGRATIONS.slice(-2).map(m => m.name));
  assert.deepEqual(await applyMigrations(d1(db), MIGRATIONS), MIGRATIONS.slice(-2).map(m => m.name));
}

// A failing migration is rolled back completely and reported by name.
{
  const db = fresh();
  const broken = [{ name: "0001_ok.sql", sql: "CREATE TABLE ok (id INTEGER);" },
    { name: "0002_broken.sql", sql: "CREATE TABLE half (id INTEGER); INSERT INTO missing VALUES (1);" }];
  await assert.rejects(applyMigrations(d1(db), broken), error => error.name === "MigrationError" && error.migration === "0002_broken.sql");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half'").get().n, 0, "no partial migration");
  assert.deepEqual(db.prepare("SELECT name FROM d1_migrations").all().map(r => r.name), ["0001_ok.sql"]);
}

// The Worker bundles every file in /migrations.
const bundled = readFileSync(new URL("../src/worker/bundledMigrations.ts", import.meta.url), "utf8");
assert.match(bundled, /import\.meta\.glob<string>\("\.\.\/\.\.\/migrations\/\*\.sql", \{ query: "\?raw", import: "default", eager: true \}\)/);
assert.match(readFileSync(new URL("../src/worker/bootstrap.ts", import.meta.url), "utf8"), /migrateDatabase\(env\)\.then\(\(\) => ensureDomains\(env\)\)/);

console.log("migration runner checks passed");
