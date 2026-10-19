// v3.08: admin@<main domain> is the administrator's mailbox and starting
// inbox; the former primary mailbox is ordinary. Runs the real setup,
// bootstrap and mailbox code against the migrations on node:sqlite.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { d1, migratedDatabase } from "./test-harness.mjs";

function database() {
  const db = migratedDatabase({ foreignKeys: true });
  return db;
}
const mailboxes = db => db.prepare("SELECT id, email_address FROM native_mailboxes ORDER BY id").all().map(row => `${row.id}=${row.email_address}`);
const json = body => new Request("https://mail.example.org/x", { method: "PATCH", body: JSON.stringify(body) });

async function run(m) {
  // Fresh install: setup takes the mail domain, creates admin@ and drops the
  // 0010 placeholder mailbox (it holds nothing).
  {
    const db = database();
    const env = { DB: d1(db), MAIL: { head: async () => null } };
    assert.deepEqual(mailboxes(db), ["native:primary=contact@liamthemo.com"], "0010 seeds a placeholder");
    assert.match(await m.initializeInstance(env, "not a domain"), /mail domain/);
    assert.equal(await m.initializeInstance(env, " Example.ORG "), null);
    assert.deepEqual(mailboxes(db), ["native:admin=admin@example.org"], "only admin@ exists after setup");
    assert.equal(await m.primaryDomain(env, true), "example.org");
    assert.match(await m.initializeInstance(env, "other.org"), /already set up/);
    // The sign-in form lists active domains, the main domain first.
    db.exec(`INSERT INTO domains (domain, status) VALUES ('zeta.org', 'active'), ('beta.org', 'pending'), ('alpha.org', 'active'), ('off.org', 'disabled')`);
    assert.deepEqual(await m.signInDomains(env), ["example.org", "alpha.org", "zeta.org"]);
    assert.equal((await m.resolveProvider(env, null))?.accountId, "native:admin", "the default account is admin@");
  }

  // Upgrade from v2: the old mailbox keeps its mail and address; its domain
  // becomes the main domain and admin@ is added next to it.
  {
    const db = database();
    db.exec("UPDATE native_mailboxes SET email_address = 'contact@example.com' WHERE id = 'native:primary'");
    db.exec("INSERT INTO auth_credentials (id, public_key, counter) VALUES ('cred', x'00', 0)");
    const env = { DB: d1(db), MAIL: { head: async () => null } };
    await m.ensureDomains(env);
    await m.ensureDomains(env);
    assert.deepEqual(mailboxes(db), ["native:admin=admin@example.com", "native:primary=contact@example.com"]);
    assert.equal(await m.primaryDomain(env, true), "example.com");
    assert.deepEqual((await m.allNativeMailboxes(env)).map(box => box.id), ["native:admin", "native:primary"], "admin@ is listed first");

    // admin@ receives mail, takes postmaster/abuse by default, and is protected.
    assert.equal((await m.mailboxForRecipient(env, "admin@example.com"))?.id, "native:admin");
    assert.equal((await m.mailboxForRecipient(env, "postmaster@example.com"))?.id, "native:admin");
    assert.equal(await m.postmasterMailboxId(env, "example.com"), "native:admin");
    assert.equal((await m.updateNativeMailbox(json({ status: "disabled" }), env, "native:admin")).status, 403);
    assert.equal((await m.scheduleNativeMailboxDeletion(env, "native:admin")).status, 403);
    await assert.rejects(m.setMailboxPassword(env, "native:admin", "longenough"), /administrator sign-in/);
    const created = await m.createNativeMailbox(new Request("https://mail.example.org/api/mailboxes", { method: "POST",
      body: JSON.stringify({ address: "admin@example.com" }) }), env);
    assert.equal(created.status, 400, "nobody can create another admin@ mailbox");

    // The former primary mailbox is ordinary now: it can be disabled.
    assert.equal((await m.updateNativeMailbox(json({ status: "disabled" }), env, "native:primary")).status, 200);
  }

  // A v3.0x install (domain already set, real mailbox at native:primary).
  {
    const db = database();
    db.exec("UPDATE native_mailboxes SET email_address = 'hello@example.net' WHERE id = 'native:primary'");
    db.exec("INSERT INTO domains (domain, status, is_primary) VALUES ('example.net', 'active', 1)");
    const env = { DB: d1(db), MAIL: { head: async () => null } };
    await m.ensureDomains(env);
    assert.deepEqual(mailboxes(db), ["native:admin=admin@example.net", "native:primary=hello@example.net"]);
  }

  // Purging an attachment-heavy mailbox deletes its stored files in R2-sized requests (at most 1,000 keys each).
  {
    const db = migratedDatabase();
    db.exec(`INSERT INTO native_mailboxes (id, email_address, display_name, deleted_at, purge_after)
      VALUES ('native:gone', 'gone@example.org', 'Gone', datetime('now', '-31 days'), datetime('now', '-1 day'))`);
    db.exec("INSERT INTO threads (id, mailbox_id, latest_message_at) VALUES ('t1', 'native:gone', '2026-10-01T00:00:00Z')");
    const message = db.prepare(`INSERT INTO messages (id, mailbox_id, thread_id, direction, from_address, to_addresses, subject, preview, received_at, body_text, raw_r2_key)
      VALUES (?, 'native:gone', 't1', 'inbound', 'a@example.net', '[]', 'Files', '', '2026-10-01T00:00:00Z', '', ?)`);
    const attachment = db.prepare("INSERT INTO attachments (id, message_id, filename, r2_key) VALUES (?, ?, 'file.bin', ?)");
    for (let i = 0; i < 50; i++) {
      message.run(`m${i}`, `raw/m${i}`);
      for (let j = 0; j < 30; j++) attachment.run(`a${i}-${j}`, `m${i}`, `att/m${i}/${j}`);
    }
    const deletes = [];
    const env = { DB: d1(db), MAIL: { delete: async keys => {
      const list = [keys].flat();
      if (list.length > 1000) throw new Error(`R2 delete accepts at most 1000 keys (${list.length})`);
      deletes.push(list.length);
    } } };
    const first = await m.purgeNativeMailbox(env, "native:gone");
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { complete: false, remaining: true, removed: 50 });
    assert.equal(deletes.reduce((a, b) => a + b, 0), 1550, "every raw message and attachment is deleted");
    assert.ok(deletes.every(count => count <= 1000));
    assert.deepEqual(await (await m.purgeNativeMailbox(env, "native:gone")).json(), { complete: true });
  }

  console.log("PASS: admin@ is created at setup and on upgrade, protected, and the former primary mailbox is ordinary");
}

const out = mkdtempSync(join(tmpdir(), "ltm-admin-mailbox-"));
try {
  const entry = join(out, "entry.ts");
  const src = new URL("../src/worker/", import.meta.url).pathname;
  writeFileSync(entry, `export { ensureDomains, initializeInstance, postmasterMailboxId, primaryDomain, signInDomains } from "${src}domains.ts";
export { allNativeMailboxes, mailboxForRecipient, purgeNativeMailbox, scheduleNativeMailboxDeletion, updateNativeMailbox, createNativeMailbox } from "${src}mailboxes.ts";
export { setMailboxPassword } from "${src}deviceAuth.ts";
export { resolveProvider } from "${src}providers/registry.ts";`);
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*"], outfile: join(out, "bundle.mjs"),
    logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
