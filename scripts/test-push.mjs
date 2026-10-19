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

  console.log("PASS: push alerts reach live sign-ins with high urgency; phones stay registered and signed in while used");
}

const out = mkdtempSync(join(tmpdir(), "ltm-push-"));
try {
  const entry = join(out, "entry.ts");
  const file = path => new URL(`../src/${path}`, import.meta.url).pathname;
  writeFileSync(entry, [
    `export { sendNewMailPush } from "${file("worker/push.ts")}";`,
    `export { deviceStatus, tokenHash } from "${file("worker/deviceAuth.ts")}";`,
    `export { needsHomeScreenInstall } from "${file("client/appModel.ts")}";`,
  ].join("\n"));
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"],
    outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
