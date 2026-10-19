// v3.14: regressions for the findings of the security and bug review.
// Pure helpers run directly; D1-backed code runs on node:sqlite with the real migrations.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

function d1(db) {
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...values) => statement(sql, values),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(row => ({ ...row })) }),
    first: async () => { const row = db.prepare(sql).get(...args); return row ? { ...row } : null; },
  });
  return {
    prepare: sql => statement(sql),
    batch: async list => {
      db.exec("BEGIN");
      try {
        const results = list.map(item => ({ meta: { changes: Number(db.prepare(item.sql).run(...item.args).changes) } }));
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
function database() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter(file => file.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, dir), "utf8"));
  db.exec("INSERT INTO native_mailboxes (id, email_address, display_name) VALUES ('native:work', 'work@example.org', 'Work')");
  return db;
}
const timed = fn => { const started = performance.now(); const value = fn(); return [value, performance.now() - started]; };

async function run(m) {
  // Rate limits: IPv6 clients are grouped by /64, and the window is honoured.
  const request = ip => new Request("https://mail.example.org/", { headers: { "CF-Connecting-IP": ip } });
  assert.equal(m.clientNetwork(request("203.0.113.9")), "203.0.113.9");
  assert.equal(m.clientNetwork(request("2001:db8:aa:bb:1:2:3:4")), "2001:db8:aa:bb::/64");
  assert.equal(m.clientNetwork(request("2001:DB8:aa:bb::1")), "2001:db8:aa:bb::/64", "every address of one /64 shares a bucket");
  assert.equal(m.clientNetwork(request("2001:db8::1")), "2001:db8:0:0::/64");
  assert.equal(m.authRateLimitBucket(request("2001:db8:aa:bb::1"), "login"), m.authRateLimitBucket(request("2001:db8:aa:bb:ffff::9"), "login"));
  assert.equal(m.accountRateLimitBucket("native-login", " Alice@Example.org "), "native-login:account:alice@example.org");
  {
    const db = database();
    const env = { DB: d1(db) };
    for (let i = 0; i < 3; i++) assert.equal(await m.checkAuthRateLimit(env, "b", 900, 3), true);
    assert.equal(await m.checkAuthRateLimit(env, "b", 900, 3), false, "the fourth attempt in the window is refused");
    db.exec("UPDATE auth_rate_limits SET window_started_at = datetime('now', '-120 seconds')");
    assert.equal(await m.checkAuthRateLimit(env, "b", 900, 3), false, "a 15-minute window is still open after 2 minutes");
    db.exec("UPDATE auth_rate_limits SET window_started_at = datetime('now', '-901 seconds')");
    assert.equal(await m.checkAuthRateLimit(env, "b", 900, 3), true, "a new window starts after it ends");
  }
  assert.match(source("worker/deviceAuth.ts"), /accountRateLimitBucket\("native-login", email\)/, "mailbox sign-in is limited per account too");

  // Request bodies: streamed bodies without a length are refused.
  const body = (headers, payload = "{}") => new Request("https://mail.example.org/api/x", { method: "POST", headers, body: payload });
  assert.equal(m.requestTooLarge(body({ "Content-Length": "10" }), 100), false);
  assert.equal(m.requestTooLarge(body({ "Content-Length": "101" }), 100), true);
  assert.equal(m.requestTooLarge(body({ "Content-Length": "abc" }), 100), true);
  assert.equal(m.requestTooLarge(body({ "Transfer-Encoding": "chunked" }), 100), true);
  assert.equal(m.requestTooLarge(new Request("https://mail.example.org/api/x", { method: "POST" }), 100), false);

  // Linear-time HTML handling: crafted input finishes quickly (quadratic code took minutes).
  const MB = 1024 * 1024;
  for (const [label, html] of [
    ["unclosed tags", "<script>".repeat(MB / 8)],
    ["unclosed quotes", `<a href="${"x".repeat(MB)}`],
    ["attribute whitespace", `<img${" ".repeat(2 * MB)}`],
    ["blank lines", "\n \n".repeat(MB / 3)],
    ["image tags", "<img src=".repeat(MB / 9)],
  ]) {
    const [, sanitize] = timed(() => m.sanitizeEmailHtml(html));
    const [, text] = timed(() => m.htmlToText(html));
    assert.ok(sanitize < 5000 && text < 5000, `${label}: sanitize ${sanitize.toFixed(0)} ms, text ${text.toFixed(0)} ms`);
  }
  assert.equal(m.sanitizeEmailHtml("<p>ok</p><script>x</script><b onclick=\"y\">b</b>"), "<p>ok</p><b>b</b>");
  assert.deepEqual(m.htmlToText("<p>a</p><style>p{}</style><p>b</p>").split(/\s+/), ["a", "b"], "style content is not text");
  {
    const footer = `<a href="https://news.example.org/unsubscribe?u=1">Unsubscribe</a>`;
    const [url, ms] = timed(() => m.messageUnsubscribeUrl(`${"<a href=x>".repeat(45_000)}${footer}`, ""));
    assert.equal(url, "https://news.example.org/unsubscribe?u=1");
    assert.ok(ms < 2000, `unsubscribe scan took ${ms.toFixed(0)} ms`);
  }

  // Outbound addresses, subjects and headers.
  for (const ok of ["a@example.org", "first.last+tag@mail.example.co.uk"]) assert.match(ok, m.EMAIL_PATTERN, ok);
  for (const bad of ["Name<x@example.org>", "<x@example.org>", "x@example.org.", "\"x\"@example.org", "x@example", "a b@example.org", "x@exa;mple.org"]) {
    assert.doesNotMatch(bad, m.EMAIL_PATTERN, bad);
  }
  assert.deepEqual(m.safeHeaders({ "In-Reply-To": "<a@b>", References: "<a@b> <c@d>", Bcc: "x@y", "X-Evil": "1", "in-reply-to": "<x>\r\nBcc: z" }),
    { "In-Reply-To": "<a@b>", References: "<a@b> <c@d>" });
  assert.match(source("worker/email/send.ts"), /subject = .*replace\(\/\[\\r\\n\]\+\/g/, "subjects lose CR/LF");

  // Attachment names cannot hide their extension with bidi controls.
  assert.equal(m.safeFilename("invoice‮fdp.exe", "attachment").includes("‮"), false);
  assert.equal(m.safeFilename("", "attachment"), "attachment");

  // Conversation-wide changes on native mailboxes, and bulk moves of collapsed rows.
  {
    const db = database();
    const env = { DB: d1(db) };
    db.exec(`INSERT INTO threads (id, mailbox_id, latest_message_at) VALUES ('t1', 'native:work', '2026-10-18T00:00:00Z'), ('t2', 'native:work', '2026-10-18T00:00:00Z')`);
    for (const [id, thread] of [["m1", "t1"], ["m2", "t1"], ["m3", "t2"]]) {
      db.exec(`INSERT INTO messages (id, mailbox_id, thread_id, direction, from_address, to_addresses, subject, preview, received_at)
        VALUES ('${id}', 'native:work', '${thread}', 'inbound', 'a@example.net', '[]', 's', '', '2026-10-18T00:00:00Z')`);
    }
    const flags = () => Object.fromEntries(db.prepare("SELECT id, is_archived, is_junk, is_deleted FROM messages ORDER BY id").all()
      .map(row => [row.id, `${row.is_archived}${row.is_junk}${row.is_deleted}`]));
    const provider = m.nativeProvider(env, "native:work", "work@example.org", "Work");
    assert.equal(await provider.patchThread("m1", { isArchived: true }), true);
    assert.deepEqual(flags(), { m1: "100", m2: "100", m3: "000" });
    assert.equal(await provider.patchThread("m2", { isJunk: true }), true);
    assert.deepEqual(flags(), { m1: "110", m2: "110", m3: "000" });
    assert.equal(await provider.patchThread("missing", { isDeleted: true }), false);
    const bulk = (ids, action) => m.bulkMailAction(new Request("https://mail.example.org/api/messages/bulk?accountId=native:work",
      { method: "POST", body: JSON.stringify({ ids, action }) }), env, { waitUntil() {} });
    assert.equal((await bulk(["m1"], "notJunk")).status, 200);
    assert.equal((await bulk(["m1"], "unarchive")).status, 200);
    assert.deepEqual(flags(), { m1: "000", m2: "000", m3: "000" }, "a bulk move covers the collapsed conversation");
    assert.equal((await bulk(["m1"], "read")).status, 200);
    assert.deepEqual(db.prepare("SELECT id FROM messages WHERE is_read = 1").all().map(row => row.id), ["m1"], "read state stays per message");

    // Opening a conversation reads all of it; newlyReadCount covers only mail the badge counts.
    db.exec("UPDATE messages SET is_read = 0; UPDATE messages SET is_archived = 1 WHERE id = 'm2'");
    const response = await m.getMessage(new Request("https://mail.example.org/api/messages/m1?accountId=native:work"), "m1",
      { DB: env.DB, MAIL: { get: async () => null } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).newlyReadCount, 1, "the archived unread message was never in the badge");
    assert.deepEqual(db.prepare("SELECT id FROM messages WHERE is_read = 1 ORDER BY id").all().map(row => row.id), ["m1", "m2"]);
  }

  // Disabling or deleting a mailbox revokes signed-in devices; the first passkey is registered atomically.
  const mailboxes = source("worker/mailboxes.ts");
  assert.match(mailboxes, /DELETE FROM device_session_accounts WHERE account_id=\?1 AND provider='native'/);
  assert.match(mailboxes, /status === "disabled"[\s\S]{0,200}revokeDeviceGrants/);
  assert.match(source("worker/auth.ts"), /WHERE NOT EXISTS \(SELECT 1 FROM auth_credentials\)/);
  // A failed send can be retried with the same key; its reserved bytes are released.
  const send = source("worker/email/send.ts");
  assert.match(send, /state='pending'[\s\S]{0,200}WHERE[\s\S]{0,120}state='failed'/);
  assert.match(send, /status === "sent" \? countedBytes : countedBytes - attachmentBytes/);
  assert.match(send, /threadId: provider\.kind === "gmail" \? replyTarget\?\.thread_id \?\? null : null/, "Gmail replies join their thread");
  // A delivery claim is released when storing fails, so Email Routing's retry is not lost.
  const receive = source("worker/email/receive.ts");
  assert.match(receive, /releaseClaim\(\)/);
  assert.match(receive, /Delivery of this message is already in progress/);
  // Drafts are bounded per mailbox.
  assert.match(source("worker/api/drafts.ts"), /MAX_DRAFTS_PER_MAILBOX = 200/);
  // Contact photos never send the Google token to a redirect target.
  assert.match(source("worker/api/contactAvatar.ts"), /redirect: "manual"/);

  console.log("PASS: review fixes (rate limits, body limits, linear HTML, outbound checks, conversation actions, unread counts)");
}

const out = mkdtempSync(join(tmpdir(), "ltm-audit-"));
try {
  const entry = join(out, "entry.ts");
  const file = path => new URL(`../src/worker/${path}`, import.meta.url).pathname;
  writeFileSync(entry, [
    `export * from "${file("security.ts")}";`,
    `export { sanitizeEmailHtml, htmlToText } from "${file("email/html.ts")}";`,
    `export { messageUnsubscribeUrl } from "${file("email/unsubscribe.ts")}";`,
    `export { safeHeaders } from "${file("transports/cloudflareBinding.ts")}";`,
    `export { EMAIL_PATTERN } from "${file("email/send.ts")}";`,
    `export { safeFilename } from "${file("email/receive.ts")}";`,
    `export { nativeProvider } from "${file("providers/native.ts")}";`,
    `export { bulkMailAction } from "${file("api/mailActions.ts")}";`,
    `export { getMessage } from "${file("api/mail.ts")}";`,
  ].join("\n"));
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"],
    outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
