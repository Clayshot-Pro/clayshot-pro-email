// Apply every D1 migration to an in-memory SQLite database (node:sqlite) and
// check the v3 schema, including upgrades of a database holding v2 data.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const dir = new URL("../migrations/", import.meta.url);
const migrations = readdirSync(dir).filter(name => name.endsWith(".sql")).sort();
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");

for (const name of migrations) {
  if (name === "0016_domains.sql") {
    // A v2 install: primary plus a second mailbox, with mail.
    db.exec(`INSERT INTO native_mailboxes (id, email_address, display_name) VALUES ('native:work', 'Work@Example.com', 'Work')`);
    db.exec(`UPDATE native_mailboxes SET email_address = 'hello@example.com' WHERE id = 'native:primary'`);
  }
  db.exec(readFileSync(new URL(name, dir), "utf8"));
}

const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);

// v3.01 domains
assert.ok(columns("domains").includes("outbound_transport"));
assert.ok(columns("native_mailboxes").includes("domain"));
assert.deepEqual(db.prepare("SELECT id, domain FROM native_mailboxes ORDER BY id").all().map(row => ({ ...row })), [
  { id: "native:primary", domain: "example.com" },
  { id: "native:work", domain: "example.com" },
], "existing mailboxes are backfilled with their lower-case domain");
db.exec("INSERT INTO domains (domain, status, is_primary) VALUES ('example.com', 'active', 1)");
assert.throws(() => db.exec("INSERT INTO domains (domain, is_primary) VALUES ('example.org', 1)"), /UNIQUE/, "only one primary domain");
assert.throws(() => db.exec("INSERT INTO domains (domain, status) VALUES ('example.net', 'bogus')"), /CHECK/);
assert.throws(() => db.exec("INSERT INTO domains (domain, outbound_transport) VALUES ('example.net', 'smtp')"), /CHECK/);
assert.throws(() => db.exec("INSERT INTO domains (domain) VALUES ('EXAMPLE.COM')"), /UNIQUE/, "domains are case-insensitive");
db.exec("INSERT INTO domains (domain, postmaster_mailbox_id) VALUES ('example.org', 'native:work')");
db.exec("DELETE FROM native_mailboxes WHERE id = 'native:work'");
assert.equal(db.prepare("SELECT postmaster_mailbox_id AS id FROM domains WHERE domain = 'example.org'").get().id, null,
  "deleting a postmaster mailbox clears the reference");

const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
const expect = (migration, names) => {
  if (!migrations.includes(migration)) return;
  for (const name of names) assert.ok(tables.has(name), `${migration} creates ${name}`);
};
expect("0017_outbound_transports.sql", ["suppressed_recipients", "webhook_receipts"]);
expect("0018_customization.sql", ["instance_settings", "account_preferences"]);
if (migrations.includes("0017_outbound_transports.sql")) {
  assert.ok(columns("outbound_attempts").includes("transport"));
  assert.ok(columns("outbound_attempts").includes("last_event"));
  assert.ok(columns("messages").includes("delivery_event_at"));
}
if (migrations.includes("0019_instance_in_d1.sql")) {
  assert.ok(columns("domains").includes("theme"));
  assert.ok(columns("native_mailboxes").includes("sender_name"));
  // A fresh install has the 0010 placeholder primary but no owner passkey:
  // the one-time LTM carry-over must not apply to it.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM instance_settings").get().n, 0);
  assert.equal(db.prepare("SELECT sender_name FROM native_mailboxes WHERE id = 'native:primary'").get().sender_name, null);
  // On an established install it carries the old Worker-var identity into D1.
  const upgraded = new DatabaseSync(":memory:");
  for (const name of migrations) {
    if (name === "0019_instance_in_d1.sql") {
      upgraded.exec("INSERT INTO auth_credentials (id, public_key, counter) VALUES ('cred', x'00', 0)");
      upgraded.exec("UPDATE native_mailboxes SET email_address = 'contact@liamthemo.com' WHERE id = 'native:primary'");
    }
    upgraded.exec(readFileSync(new URL(name, dir), "utf8"));
  }
  assert.equal(upgraded.prepare("SELECT sender_name FROM native_mailboxes WHERE id = 'native:primary'").get().sender_name, "Liam");
  assert.match(upgraded.prepare("SELECT settings FROM instance_settings WHERE id = 1").get().settings, /"brandName":"LTM Mails"/);
}
if (migrations.includes("0018_customization.sql")) {
  assert.ok(columns("native_mailboxes").includes("accent_color"));
  assert.throws(() => db.exec("INSERT INTO instance_settings (id, settings) VALUES (2, '{}')"), /CHECK/, "singleton row");
}

console.log(`PASS: ${migrations.length} migrations apply cleanly with v3 schema checks`);
