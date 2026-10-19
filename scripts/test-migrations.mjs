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
  if (name === "0023_setup_grants.sql") {
    // Keys stored before v3.12 must survive the table rebuild.
    db.exec("INSERT INTO instance_keys (name, value, hint) VALUES ('RESEND_API_KEY', 'v1.enc.data', '…abcd')");
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
  // No instance-specific data is seeded by migrations.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM instance_settings").get().n, 0);
  assert.equal(db.prepare("SELECT sender_name FROM native_mailboxes WHERE id = 'native:primary'").get().sender_name, null);
  assert.doesNotMatch(readFileSync(new URL("0019_instance_in_d1.sql", dir), "utf8"), /liamthemo|LTM Mails/i);
}
if (migrations.includes("0018_customization.sql")) {
  assert.ok(columns("native_mailboxes").includes("accent_color"));
  assert.throws(() => db.exec("INSERT INTO instance_settings (id, settings) VALUES (2, '{}')"), /CHECK/, "singleton row");
}

if (migrations.includes("0020_instance_keys.sql")) {
  assert.deepEqual(columns("instance_keys"), ["name", "value", "hint", "updated_at"]);
  db.exec("INSERT INTO instance_keys (name, value) VALUES ('VAPID', 'v1.x.y')");
  assert.throws(() => db.exec("INSERT INTO instance_keys (name, value) VALUES ('PROVIDER_CREDENTIAL_KEY', 'x')"), /CHECK/,
    "the encryption key itself can never be stored in D1");
}

if (migrations.includes("0021_blocked_senders.sql")) {
  assert.deepEqual(columns("blocked_senders"), ["mailbox_id", "pattern", "created_at"]);
  db.exec("INSERT INTO blocked_senders (mailbox_id, pattern) VALUES ('native:primary', '@example.com')");
  assert.throws(() => db.exec("INSERT INTO blocked_senders (mailbox_id, pattern) VALUES ('native:primary', '@example.com')"), /UNIQUE|PRIMARY/,
    "a pattern is stored once per mailbox");
}

if (migrations.includes("0022_photos_and_junk_filter.sql")) {
  assert.ok(columns("native_mailboxes").includes("photo_version"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM native_mailboxes WHERE spam_filter_enabled = 0").get().n, 0, "the junk filter is on for existing mailboxes");
}

if (migrations.includes("0023_setup_grants.sql")) {
  assert.deepEqual(columns("setup_grants"), ["token_hash", "expires_at"]);
  assert.deepEqual({ ...db.prepare("SELECT name, value, hint FROM instance_keys WHERE name = 'RESEND_API_KEY'").get() },
    { name: "RESEND_API_KEY", value: "v1.enc.data", hint: "…abcd" }, "existing keys survive the rebuild");
  db.exec("INSERT INTO instance_keys (name, value) VALUES ('CLOUDFLARE', 'v1.x.y')");
  assert.throws(() => db.exec("INSERT INTO instance_keys (name, value) VALUES ('PROVIDER_CREDENTIAL_KEY', 'x')"), /CHECK/,
    "the encryption key itself still can never be stored in D1");
}

console.log(`PASS: ${migrations.length} migrations apply cleanly with v3 schema checks`);
