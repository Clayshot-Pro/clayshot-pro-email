// Push notifications: who receives a new-mail alert, how it is sent, and why
// a phone keeps receiving them (re-registration on start, renewing sign-ins,
// subscription rotation). Runs the Worker code on node:sqlite with the real
// migrations; push services are faked behind fetch.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const b64url = bytes => Buffer.from(bytes).toString("base64url");
const sha256Hex = async value => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");

function d1(db) {
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...values) => statement(sql, values),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(row => ({ ...row })) }),
    first: async () => { const row = db.prepare(sql).get(...args); return row ? { ...row } : null; },
  });
  return { prepare: sql => statement(sql), batch: async list => Promise.all(list.map(item => item.run())) };
}

function database() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter(file => file.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, dir), "utf8"));
  db.exec("INSERT OR IGNORE INTO domains (domain, status, is_primary) VALUES ('example.org', 'active', 1)");
  db.exec("UPDATE domains SET status = 'active' WHERE domain = 'example.org'");
  db.exec("INSERT INTO native_mailboxes (id, email_address, display_name, domain) VALUES ('native:friend', 'friend@example.org', 'Friend', 'example.org')");
  return db;
}

async function keys() {
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const client = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    VAPID_PUBLIC_KEY: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey))),
    VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey("jwk", vapid.privateKey)).d,
    p256dh: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", client.publicKey))),
    auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
  };
}

async function run(m) {
  const k = await keys();
  const db = database();
  const env = { DB: d1(db), VAPID_PUBLIC_KEY: k.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: k.VAPID_PRIVATE_KEY };
  const session = (id, expires) => {
    db.prepare("INSERT INTO device_sessions (id, token_hash, expires_at) VALUES (?, ?, datetime('now', ?))").run(id, `hash-${id}`, expires);
    db.prepare("INSERT INTO device_session_accounts (session_id, account_id, provider) VALUES (?, 'native:friend', 'native')").run(id);
  };
  const subscription = (endpoint, sessionId) => db.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_session_id)
    VALUES (?, ?, ?, ?, ?)`).run(crypto.randomUUID(), endpoint, k.p256dh, k.auth, sessionId);
  session("live", "+20 days");
  session("ended", "-1 day");
  subscription("https://fcm.googleapis.com/fcm/send/live-phone", "live");
  subscription("https://web.push.apple.com/ended-phone", "ended");
  subscription("https://web.push.apple.com/gone-phone", "live");
  subscription("https://web.push.apple.com/misconfigured-phone", "live");

  const sent = [];
  const warnings = [];
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)) });
    if (String(url).includes("gone-phone")) return new Response("", { status: 410 });
    if (String(url).includes("misconfigured-phone")) return new Response('{"reason":"BadJwtToken"}', { status: 403 });
    return new Response("", { status: 201 });
  };
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await m.sendNewMailPush(env, { id: "m1", subject: "Hi", fromAddress: "a@example.net", toAddress: "friend@example.org", preview: "hello" });
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
  const hosts = sent.map(item => new URL(item.url).pathname).sort();
  assert.deepEqual(hosts, ["/fcm/send/live-phone", "/gone-phone", "/misconfigured-phone"], "only phones with a live sign-in for the mailbox are alerted");
  const live = sent.find(item => item.url.includes("live-phone"));
  assert.equal(live.headers.urgency, "high", "high urgency, so Android delivers while the phone is idle");
  assert.equal(live.headers.ttl, "86400", "a phone offline for a while still receives the alert");
  assert.match(live.headers.authorization, /^vapid t=.+, k=/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%gone-phone'").get().n, 0, "a subscription the service dropped (410) is removed");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%misconfigured-phone'").get().n, 1, "a 403 is a configuration problem, not a dead phone");
  assert.ok(warnings.some(line => line.includes("web.push.apple.com 403 {\"reason\":\"BadJwtToken\"}")), "the service's reason is logged");
  assert.ok(!warnings.some(line => line.includes("misconfigured-phone")), "the endpoint itself is never logged");

  // Alerts read like a mail app: sender as the title, then subject and preview;
  // administrator alerts also name the receiving mailbox.
  const mail = { id: "m2", subject: "Lunch on Friday?", fromAddress: "sam@example.net", fromName: "Sam Lee", toAddress: "friend@example.org", preview: "Are you free around noon" };
  assert.deepEqual(m.notificationCopy(mail), { title: "Sam Lee", body: "Lunch on Friday?\nAre you free around noon" });
  assert.deepEqual(m.notificationCopy({ ...mail, fromName: null, preview: "" }), { title: "sam@example.net", body: "Lunch on Friday?" });
  assert.deepEqual(m.notificationCopy({ ...mail, subject: "" }), { title: "Sam Lee", body: "(no subject)\nAre you free around noon" },
    "every alert, administrator ones included, is sender / subject / body");

  // The administrator's phone gets every mailbox's mail for 30 days after enabling
  // alerts as admin, even after the short admin session has ended.
  {
    const adminToken = "a".repeat(43);
    const adminHash = await sha256Hex(adminToken);
    db.prepare("INSERT INTO auth_sessions (session_id, token_hash, expires_at, last_seen_at) VALUES ('admin-1', ?, datetime('now', '+12 hours'), datetime('now'))").run(adminHash);
    const enable = await m.subscribePush(new Request("https://mail.example.org/api/push/subscribe", {
      method: "POST", headers: { Cookie: `__Host-ltm_session=${adminToken}` },
      body: JSON.stringify({ endpoint: "https://web.push.apple.com/admin-phone", keys: { p256dh: k.p256dh, auth: k.auth } }),
    }), env);
    assert.equal(enable.status, 201);
    const until = db.prepare("SELECT julianday(all_mail_until) - julianday('now') AS d FROM push_subscriptions WHERE endpoint LIKE '%admin-phone'").get().d;
    assert.ok(until > 29.9 && until < 30.1, `all-mail alerts for 30 days (${until})`);
    db.prepare("DELETE FROM auth_sessions WHERE session_id = 'admin-1'").run();

    const deliver = async () => {
      const calls = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = async url => { calls.push(String(url)); return new Response("", { status: 201 }); };
      try { await m.sendNewMailPush(env, mail); } finally { globalThis.fetch = realFetch; }
      return calls;
    };
    assert.ok((await deliver()).some(url => url.includes("admin-phone")), "the admin phone gets the friend's mail after the admin session ended");

    // Registering again without the admin session keeps it; with it, renews it.
    await m.subscribePush(new Request("https://mail.example.org/api/push/subscribe", {
      method: "POST", body: JSON.stringify({ endpoint: "https://web.push.apple.com/admin-phone", keys: { p256dh: k.p256dh, auth: k.auth } }),
    }), env).catch(() => null);
    assert.ok(db.prepare("SELECT all_mail_until FROM push_subscriptions WHERE endpoint LIKE '%admin-phone'").get().all_mail_until);

    // Signing out as admin, signing out other sessions, or a password change stops it.
    db.prepare("INSERT INTO auth_sessions (session_id, token_hash, expires_at, last_seen_at) VALUES ('admin-2', ?, datetime('now', '+12 hours'), datetime('now'))").run(adminHash);
    await m.logout(new Request("https://mail.example.org/api/auth/logout", { method: "POST", headers: { Cookie: `__Host-ltm_session=${adminToken}` } }), env);
    assert.equal(db.prepare("SELECT all_mail_until FROM push_subscriptions WHERE endpoint LIKE '%admin-phone'").get().all_mail_until, null);
    assert.ok(!(await deliver()).some(url => url.includes("admin-phone")), "after admin sign-out the phone only gets its own mailboxes");

    db.prepare("UPDATE push_subscriptions SET all_mail_until = datetime('now', '+10 days'), owner_session_hash = 'other-hash' WHERE endpoint LIKE '%admin-phone'").run();
    const keepToken = "k".repeat(43);
    db.prepare("INSERT INTO auth_sessions (session_id, token_hash, expires_at, last_seen_at) VALUES ('keep', ?, datetime('now', '+12 hours'), datetime('now'))").run(await sha256Hex(keepToken));
    await m.resetSessions(new Request("https://mail.example.org/api/auth/sessions/reset", { method: "POST", headers: { Cookie: `__Host-ltm_session=${keepToken}` } }), env);
    assert.equal(db.prepare("SELECT all_mail_until FROM push_subscriptions WHERE endpoint LIKE '%admin-phone'").get().all_mail_until, null,
      "signing out other sessions stops other phones' all-mail alerts");
    db.prepare("UPDATE push_subscriptions SET all_mail_until = datetime('now', '+10 days') WHERE endpoint LIKE '%admin-phone'").run();
    await m.revokeAllMailAlerts(env, "all").run();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE all_mail_until IS NOT NULL").get().n, 0);
    assert.match(readFileSync(new URL("../src/worker/adminAuth.ts", import.meta.url), "utf8"), /DELETE FROM auth_sessions"\),\s+revokeAllMailAlerts\(env, "all"\)/,
      "a password change stops all-mail alerts with the sessions");
  }

  // Signing in again re-binds the phone's existing subscription to the new session.
  assert.match(source("src/client/App.tsx"), /if \(subscription && Notification\.permission === "granted"\) \{\s+await fetch\("\/api\/push\/subscribe"/,
    "the app re-registers an existing subscription on every start");
  assert.match(source("public/sw.js"), /addEventListener\("pushsubscriptionchange"[\s\S]{0,700}\/api\/push\/subscribe/,
    "a subscription the browser replaces is registered again");

  // A device stays signed in while used: an older session is renewed with the same token.
  {
    const token = "t".repeat(40);
    db.prepare("INSERT INTO device_sessions (id, token_hash, expires_at) VALUES ('old', ?, datetime('now', '+5 days'))").run(await m.tokenHash(token));
    db.prepare("INSERT INTO device_session_accounts (session_id, account_id, provider) VALUES ('old', 'native:friend', 'native')").run();
    const status = await m.deviceStatus(new Request("https://mail.example.org/api/device/status", { headers: { Cookie: `__Host-ltm_device=${token}` } }), env);
    assert.equal((await status.json()).authenticated, true);
    assert.match(status.headers.get("set-cookie") ?? "", new RegExp(`__Host-ltm_device=${token};.*Max-Age=2592000`), "the cookie is renewed with the same token");
    const days = db.prepare("SELECT julianday(expires_at) - julianday('now') AS d FROM device_sessions WHERE id = 'old'").get().d;
    assert.ok(days > 29.9 && days < 30.1, `renewed for 30 days (${days})`);
    const again = await m.deviceStatus(new Request("https://mail.example.org/api/device/status", { headers: { Cookie: `__Host-ltm_device=${token}` } }), env);
    assert.equal(again.headers.get("set-cookie"), null, "a recently renewed session is not rewritten on every start");
    db.prepare("UPDATE device_sessions SET expires_at = datetime('now', '-1 minute') WHERE id = 'old'").run();
    const ended = await m.deviceStatus(new Request("https://mail.example.org/api/device/status", { headers: { Cookie: `__Host-ltm_device=${token}` } }), env);
    assert.equal((await ended.json()).authenticated, false, "an ended session is never revived");
    assert.equal(ended.headers.get("set-cookie"), null);
  }

  // iPhone and iPad need the app on the Home Screen for web push.
  const nav = (userAgent, maxTouchPoints = 0, standalone) => ({ userAgent, maxTouchPoints, standalone });
  assert.equal(m.needsHomeScreenInstall(nav("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), false), true);
  assert.equal(m.needsHomeScreenInstall(nav("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5, true), false), false, "installed");
  assert.equal(m.needsHomeScreenInstall(nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5), false), true, "iPad reports itself as a Mac");
  assert.equal(m.needsHomeScreenInstall(nav("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), true), false, "display-mode standalone");
  assert.equal(m.needsHomeScreenInstall(nav("Mozilla/5.0 (Linux; Android 15; Pixel 9)"), false), false);
  assert.equal(m.needsHomeScreenInstall(nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), false), false, "a desktop Mac");

  console.log("PASS: push alerts (sender, subject, preview) reach live sign-ins and the admin phone for all mail; phones stay registered and signed in while used");
}

const out = mkdtempSync(join(tmpdir(), "ltm-push-"));
try {
  const entry = join(out, "entry.ts");
  const file = path => new URL(`../src/${path}`, import.meta.url).pathname;
  writeFileSync(entry, [
    `export { notificationCopy, revokeAllMailAlerts, sendNewMailPush, subscribePush } from "${file("worker/push.ts")}";`,
    `export { logout, resetSessions } from "${file("worker/auth.ts")}";`,
    `export { deviceStatus, tokenHash } from "${file("worker/deviceAuth.ts")}";`,
    `export { needsHomeScreenInstall } from "${file("client/appModel.ts")}";`,
  ].join("\n"));
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"],
    outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
