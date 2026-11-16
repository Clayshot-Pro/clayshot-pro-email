// Signing out of one account keeps the others signed in: the administrator
// session ends on its own, one mailbox is removed on its own, and "log out of
// all" still ends everything on the device.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { d1, migratedDatabase } from "./test-harness.mjs";

const ORIGIN = "https://mail.example.org";
const sha256 = async text => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("hex");

async function run(m) {
  const db = migratedDatabase();
  const env = { DB: d1(db) };
  db.exec(`INSERT OR REPLACE INTO domains (domain, status, is_primary) VALUES ('example.org', 'active', 1);
    INSERT INTO native_mailboxes (id, email_address) VALUES ('native:contact', 'contact@example.org'), ('native:support', 'support@example.org');`);

  const setup = async () => {
    db.exec("DELETE FROM device_sessions; DELETE FROM auth_sessions;");
    const device = "d".repeat(40), owner = "o".repeat(43);
    db.prepare("INSERT INTO device_sessions (id, token_hash, expires_at) VALUES ('dev', ?, datetime('now', '+30 days'))").run(await sha256(device));
    db.exec("INSERT INTO device_session_accounts (session_id, account_id, provider) VALUES ('dev', 'native:contact', 'native'), ('dev', 'native:support', 'native')");
    db.prepare("INSERT INTO auth_sessions (session_id, token_hash, expires_at, last_seen_at) VALUES ('adm', ?, datetime('now', '+12 hours'), datetime('now'))").run(await sha256(owner));
    return `__Host-ltm_device=${device}; __Host-ltm_session=${owner}`;
  };
  const post = (path, cookie, body) => new Request(`${ORIGIN}${path}`, { method: "POST", headers: { Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const status = async cookie => (await m.deviceStatus(new Request(`${ORIGIN}/api/device/status`, { headers: { Cookie: cookie } }), env)).json();
  const cookies = response => response.headers.getSetCookie().join("\n");

  // Admin sign-out leaves the mailboxes signed in on the device.
  let cookie = await setup();
  assert.deepEqual(await status(cookie), { authenticated: true, isAdmin: true, accountCount: 2 + db.prepare("SELECT COUNT(*) AS n FROM native_mailboxes WHERE status='active' AND deleted_at IS NULL").get().n });
  const adminOut = await m.deviceLogout(post("/api/device/logout", cookie, { only: "admin" }), env);
  assert.equal(adminOut.status, 200);
  assert.match(cookies(adminOut), /__Host-ltm_session=;.*Max-Age=0/, "the admin cookie is cleared");
  assert.doesNotMatch(cookies(adminOut), /__Host-ltm_device/, "the device cookie is kept");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get().n, 0, "the admin session is gone");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM device_session_accounts").get().n, 2, "both mailboxes stay signed in");
  assert.deepEqual(await status(cookie), { authenticated: true, isAdmin: false, accountCount: 2 }, "the device is still signed in");

  // One mailbox signed out; the other and the admin session stay.
  cookie = await setup();
  const removed = await m.deviceRemoveAccount(post("/api/device/accounts/native%3Acontact", cookie), env, "native:contact");
  assert.equal(removed.status, 200);
  assert.deepEqual(db.prepare("SELECT account_id FROM device_session_accounts").all().map(row => row.account_id), ["native:support"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get().n, 1, "the admin session stays");
  assert.equal((await status(cookie)).authenticated, true);

  // Log out of all: everything on this device ends.
  cookie = await setup();
  const all = await m.deviceLogout(post("/api/device/logout", cookie), env);
  assert.match(cookies(all), /__Host-ltm_device=;/);
  assert.match(cookies(all), /__Host-ltm_session=;/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM device_sessions").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get().n, 0);
  assert.deepEqual(await status(cookie), { authenticated: false, isAdmin: false, accountCount: 0 });

  // Signing out of admin with only a mailbox cookie is harmless.
  const mailboxOnly = "__Host-ltm_device=" + "e".repeat(40);
  assert.equal((await m.deviceLogout(post("/api/device/logout", mailboxOnly, { only: "admin" }), env)).status, 200);
  console.log("PASS: signing out of the admin session or one mailbox keeps the other accounts signed in; log out of all ends everything");
}

const out = mkdtempSync(join(tmpdir(), "ltm-signout-"));
try {
  const entry = join(out, "entry.ts");
  const file = path => new URL(`../src/${path}`, import.meta.url).pathname;
  writeFileSync(entry, `export { deviceLogout, deviceRemoveAccount, deviceStatus } from "${file("worker/deviceAuth.ts")}";`);
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"],
    outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
