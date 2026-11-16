// Inboxes added on a device stay linked to its main inbox: logging out keeps
// them, and logging in again with the main inbox's password brings them back.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { d1, migratedDatabase } from "./test-harness.mjs";

const ORIGIN = "https://mail.example.org";
const PASSWORD = "correct horse battery 1";

async function run(m) {
  const db = migratedDatabase();
  const env = { DB: d1(db) };
  db.exec(`INSERT OR REPLACE INTO domains (domain, status, is_primary) VALUES ('example.org', 'active', 1);
    INSERT INTO native_mailboxes (id, email_address) VALUES ('native:contact', 'contact@example.org'),
      ('native:support', 'support@example.org'), ('native:other', 'other@example.org');`);
  for (const id of ["contact", "support", "other"]) await m.setMailboxPassword(env, `native:${id}`, PASSWORD);

  const deviceCookie = response => (response.headers.getSetCookie().find(c => c.startsWith("__Host-ltm_device=")) ?? "").split(";")[0];
  const login = async (name, cookie = "") => {
    const response = await m.deviceLogin(new Request(`${ORIGIN}/api/device/login`, { method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ email: `${name}@example.org`, password: PASSWORD }) }), env);
    assert.equal(response.status, 200, `${name} signs in`);
    return deviceCookie(response) || cookie;
  };
  const req = (path, cookie, method = "GET") => new Request(`${ORIGIN}${path}`, { method, headers: { Cookie: cookie } });
  const signedIn = async cookie => (await m.deviceAccountIds(req("/", cookie), env)).map(id => id.replace("native:", "")).sort();
  const status = async cookie => (await m.deviceStatus(req("/api/device/status", cookie), env)).json();
  const links = () => db.prepare("SELECT owner_account_id AS o, linked_account_id AS l FROM account_links ORDER BY o, l").all().map(r => `${r.o.replace("native:", "")}>${r.l.replace("native:", "")}`);
  const logout = cookie => m.deviceLogout(new Request(`${ORIGIN}/api/device/logout`, { method: "POST", headers: { Cookie: cookie } }), env);

  // The first inbox is the main inbox; inboxes added later are linked to it.
  let cookie = await login("contact");
  assert.deepEqual(await signedIn(cookie), ["contact"]);
  assert.equal((await status(cookie)).mainAccountId, "native:contact");
  cookie = await login("support", cookie);
  cookie = await login("other", cookie);
  assert.deepEqual(await signedIn(cookie), ["contact", "other", "support"]);
  assert.deepEqual(links(), ["contact>other", "contact>support"]);
  const info = await status(cookie);
  assert.deepEqual([info.mainAccountId, info.linkedAccountIds.sort()], ["native:contact", ["native:other", "native:support"]]);

  // Logging out keeps the links but ends the session.
  await logout(cookie);
  assert.deepEqual(await signedIn(cookie), [], "logged out");
  assert.deepEqual(links(), ["contact>other", "contact>support"], "the links survive a log out");

  // A linked inbox's password alone gives only that inbox.
  const supportOnly = await login("support");
  assert.deepEqual(await signedIn(supportOnly), ["support"], "a linked inbox does not restore the set");
  await logout(supportOnly);

  // The main inbox's password brings every linked inbox back.
  cookie = await login("contact");
  assert.deepEqual(await signedIn(cookie), ["contact", "other", "support"], "logging in with the main inbox restores the set");

  // Sign out of one inbox: gone now, back at the next sign-in (still linked).
  assert.equal((await m.deviceRemoveAccount(req("/", cookie, "DELETE"), env, "native:support")).status, 200);
  assert.deepEqual(await signedIn(cookie), ["contact", "other"]);
  assert.ok(links().includes("contact>support"), "signing out keeps the link");
  await logout(cookie);
  cookie = await login("contact");
  assert.deepEqual(await signedIn(cookie), ["contact", "other", "support"], "a signed-out linked inbox returns");

  // Unlink: gone for good. The main inbox cannot be unlinked.
  assert.equal((await m.deviceUnlinkAccount(req("/", cookie, "DELETE"), env, "native:other")).status, 200);
  assert.deepEqual(await signedIn(cookie), ["contact", "support"]);
  assert.deepEqual(links(), ["contact>support"]);
  assert.equal((await m.deviceUnlinkAccount(req("/", cookie, "DELETE"), env, "native:contact")).status, 400, "the main inbox is not unlinked");
  await logout(cookie);
  assert.deepEqual(await signedIn(await login("contact")), ["contact", "support"], "an unlinked inbox does not return");

  // Inboxes that are no longer usable are not restored.
  db.prepare("UPDATE native_mailboxes SET status='disabled' WHERE id='native:support'").run();
  cookie = await login("contact");
  assert.deepEqual(await signedIn(cookie), ["contact"], "a disabled mailbox is not restored");
  await logout(cookie);
  db.prepare("UPDATE native_mailboxes SET status='active' WHERE id='native:support'").run();

  // A password reset of a linked inbox ends its links: the main inbox's password no longer opens it.
  await m.setMailboxPassword(env, "native:support", "another correct horse 2");
  assert.deepEqual(links(), [], "resetting a linked inbox's password unlinks it");
  // The main inbox's own password change keeps what the person linked; an administrator's reset does not.
  cookie = await login("contact");
  cookie = await login("other", cookie);
  assert.deepEqual(links(), ["contact>other"]);
  await m.setMailboxPassword(env, "native:contact", "yet another horse 3", { keepOwnedLinks: true });
  assert.deepEqual(links(), ["contact>other"], "changing the main inbox's own password keeps its links");
  await m.setMailboxPassword(env, "native:contact", PASSWORD);
  assert.deepEqual(links(), [], "an administrator's reset of the main inbox ends its links");

  // A device whose session predates linking: its earliest inbox becomes the main inbox, and an inbox added next is linked to it.
  db.exec("DELETE FROM device_sessions; DELETE FROM account_links;");
  const token = "legacy-token-".padEnd(40, "x");
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
  await m.setMailboxPassword(env, "native:support", PASSWORD); // (a password set signs the mailbox out everywhere)
  db.prepare("INSERT INTO device_sessions (id, token_hash, expires_at) VALUES ('old', ?, datetime('now', '+30 days'))").run(hash);
  db.exec("INSERT INTO device_session_accounts (session_id, account_id, provider, added_at) VALUES ('old', 'native:support', 'native', '2020-01-01 00:00:00')");
  const legacyCookie = `__Host-ltm_device=${token}`;
  await login("other", legacyCookie);
  assert.deepEqual(links(), ["support>other"], "the earliest inbox of an older session is its main inbox");
  assert.equal((await status(`__Host-ltm_device=${token}`)).mainAccountId, "native:support");

  console.log("PASS: linked inboxes survive log out and return with the main inbox's password; unlink, resets and disabled mailboxes end the links");
}

// The migration links today's single-device sets, but never pools an inbox shared by several devices.
function migrationBackfill() {
  const dir = new URL("../migrations/", import.meta.url);
  const names = readdirSync(dir).filter(file => file.endsWith(".sql")).sort();
  const db = new DatabaseSync(":memory:");
  for (const name of names.filter(file => file < "0028")) db.exec(readFileSync(new URL(name, dir), "utf8"));
  db.exec(`INSERT INTO device_sessions (id, token_hash, expires_at) VALUES ('solo','h1',datetime('now','+30 days')),('a','h2',datetime('now','+30 days')),('b','h3',datetime('now','+30 days'));
    INSERT INTO device_session_accounts (session_id, account_id, provider, added_at) VALUES
      ('solo','native:me','native','2026-01-01 00:00:00'),('solo','native:mine','native','2026-01-02 00:00:00'),
      ('a','native:shared','native','2026-01-01 00:00:00'),('a','native:alice','native','2026-01-02 00:00:00'),
      ('b','native:shared','native','2026-01-01 00:00:00'),('b','native:bob','native','2026-01-02 00:00:00');`);
  db.exec(readFileSync(new URL("0028_linked_inboxes.sql", dir), "utf8"));
  assert.deepEqual(db.prepare("SELECT id, main_account_id AS m FROM device_sessions ORDER BY id").all().map(r => `${r.id}:${r.m}`),
    ["a:native:shared", "b:native:shared", "solo:native:me"], "the earliest inbox of each session is its main inbox");
  assert.deepEqual(db.prepare("SELECT owner_account_id AS o, linked_account_id AS l FROM account_links").all().map(r => `${r.o}>${r.l}`),
    ["native:me>native:mine"], "a single device's set is linked; an inbox that is main on several devices pools nothing");
}

const out = mkdtempSync(join(tmpdir(), "ltm-linked-"));
try {
  migrationBackfill();
  const entry = join(out, "entry.ts");
  const file = path => new URL(`../src/${path}`, import.meta.url).pathname;
  writeFileSync(entry, `export { deviceAccountIds, deviceLogin, deviceLogout, deviceRemoveAccount, deviceStatus, deviceUnlinkAccount, setMailboxPassword } from "${file("worker/deviceAuth.ts")}";`);
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"],
    outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
