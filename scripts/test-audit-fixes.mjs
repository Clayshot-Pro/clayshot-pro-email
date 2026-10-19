// v3.14: regressions for the findings of the security and bug review.
// Pure helpers run directly; D1-backed code runs on node:sqlite with the real migrations.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { d1, migratedDatabase } from "./test-harness.mjs";

const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

function database() {
  const db = migratedDatabase();
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
  assert.match(source("worker/deviceAuth.ts"), /countAccountLoginAttempt\(env, accountBucket\)[\s\S]{0,200}checkNativePassword[\s\S]{0,200}clearAccountLoginFailures/,
    "the account is counted before the password check and cleared after a success");

  assert.equal(m.clientNetwork(request("::ffff:198.51.100.7")), "198.51.100.7", "an IPv4-mapped address is that IPv4 client");
  {
    // Only failed sign-ins count against an account, and a success clears them.
    const db = database();
    const env = { DB: d1(db) };
    const bucket = m.accountRateLimitBucket("native-login", "alice@example.org");
    // Counted atomically before the password check, so parallel guesses cannot all pass.
    const parallel = await Promise.all(Array.from({ length: m.ACCOUNT_LOGIN_MAX_ATTEMPTS + 10 }, () => m.countAccountLoginAttempt(env, bucket)));
    assert.equal(parallel.filter(Boolean).length, m.ACCOUNT_LOGIN_MAX_ATTEMPTS);
    db.exec("UPDATE auth_rate_limits SET window_started_at = datetime('now', '-901 seconds')");
    assert.equal(await m.countAccountLoginAttempt(env, bucket), true, "the block ends with the window");
    await m.clearAccountLoginFailures(env, bucket);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auth_rate_limits").get().n, 0, "a successful sign-in clears the count");
  }

  // Request bodies: never read past the limit, whatever the headers say.
  const body = (headers, payload = "{}") => new Request("https://mail.example.org/api/x", { method: "POST", headers, body: payload });
  const fits = body({ "Content-Length": "10" });
  assert.equal(m.limitedRequest(fits, 100), fits);
  assert.equal(m.limitedRequest(body({ "Content-Length": "101" }), 100), null);
  assert.equal(m.limitedRequest(body({ "Content-Length": "abc" }), 100), null);
  assert.equal(m.limitedRequest(body({ "Transfer-Encoding": "chunked" }), 100), null);
  const empty = new Request("https://mail.example.org/api/x", { method: "POST" });
  assert.equal(m.limitedRequest(empty, 100), empty);
  const stream = text => new Request("https://mail.example.org/api/x", {
    method: "POST", duplex: "half",
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }),
  });
  assert.equal(await m.limitedRequest(stream("x".repeat(100)), 100).text(), "x".repeat(100), "a body with no length is read up to the limit");
  await assert.rejects(m.limitedRequest(stream("x".repeat(101)), 100).text(), "and no further");

  // Linear-time HTML handling: crafted input finishes quickly (quadratic code took minutes).
  const MB = 1024 * 1024;
  for (const [label, html] of [
    ["unclosed tags", "<script>".repeat(MB / 8)],
    ["unclosed quotes", `<a href="${"x".repeat(MB)}`],
    ["attribute whitespace", `<img${" ".repeat(2 * MB)}`],
    ["blank lines", "\n \n".repeat(MB / 3)],
    ["image tags", "<img src=".repeat(MB / 9)],
    ["spaces after src=", `<img src=${" ".repeat(2 * MB)}x>`],
    ["spaces after href=", `<a href=${" ".repeat(2 * MB)}x>`],
    ["unclosed handler quotes", `<a onx="`.repeat(MB / 8)],
    ["slashes", `<img${"/".repeat(2 * MB)}`],
  ]) {
    const [, sanitize] = timed(() => m.sanitizeEmailHtml(html));
    const [, text] = timed(() => m.htmlToText(html));
    assert.ok(sanitize < 5000 && text < 5000, `${label}: sanitize ${sanitize.toFixed(0)} ms, text ${text.toFixed(0)} ms`);
  }
  assert.equal(m.sanitizeEmailHtml("<p>ok</p><script>x</script><b onclick=\"y\">b</b>"), "<p>ok</p><b >b</b>");
  // Quoting, spacing, length and "/" separators do not get a handler or script URL through.
  const spaces = " ".repeat(40);
  for (const html of [`<a href="javascript:alert('x')">a</a>`, `<a href='javascript:alert("x")'>a</a>`, `<a href=${spaces}javascript:alert(1)>a</a>`,
    `<a href="javascript:${"x".repeat(20_000)}">a</a>`, `<a href="JaVaScRiPt:1">a</a>`, `<a href=" vbscript:1">a</a>`]) {
    assert.doesNotMatch(m.sanitizeEmailHtml(html), /href=\s*["']?\s*(?:javascript|vbscript):/i, html.slice(0, 60));
  }
  for (const html of [`<img src=x onerror${spaces}=alert(1)>`, `<img src=x onerror=${spaces}alert(1)>`, `<img src="x"/onerror=alert(1)>`, `<svg/onload=alert(1)>`]) {
    assert.doesNotMatch(m.sanitizeEmailHtml(html), /onerror|onload/i, html.slice(0, 60));
  }
  for (const html of [`<img ${"a".repeat(9000)} src="https://t.test/p.png">`, `<img src='https://t.test/a"b.png'>`, `<img src=https://t.test/p.png>`,
    `<img src=${spaces}"https://t.test/p.png">`]) {
    assert.doesNotMatch(m.sanitizeEmailHtml(html), /[\s/]src\s*=/i, "remote images are never left loadable");
  }
  assert.match(m.sanitizeEmailHtml(`<img src="cid:logo">`), /src="cid:logo"/, "inline images are kept");
  assert.doesNotMatch(m.sanitizeEmailHtml(`<scr<scr<script>ipt>ipt>alert(1)</script>`), /<script/i, "removed tags cannot reassemble");
  assert.doesNotMatch(m.sanitizeEmailHtml(`<img src="x"onerror=alert(1)>`), /onerror/i, "a handler right after a quoted value is removed");
  assert.doesNotMatch(m.sanitizeEmailHtml(`<img o/onx="1"nerror=alert(1)>`), /\bonerror\b/i, "removing an attribute cannot join a new one");
  for (const link of [`<a href="https://x.test/onboarding=1">x</a>`, `<a href="https://x.test/a/action=2/ping=3">x</a>`]) {
    assert.equal(m.sanitizeEmailHtml(link), link, "a URL path is not mistaken for attributes");
  }
  assert.deepEqual(m.htmlToText("<p>a</p><style>p{}</style><p>b</p>").split(/\s+/), ["a", "b"], "style content is not text");
  {
    const footer = `<a href="https://news.example.org/unsubscribe?u=1">Unsubscribe</a>`;
    const [url, ms] = timed(() => m.messageUnsubscribeUrl(`${"<a href=x>".repeat(45_000)}${footer}`, ""));
    assert.equal(url, "https://news.example.org/unsubscribe?u=1");
    assert.ok(ms < 2000, `unsubscribe scan took ${ms.toFixed(0)} ms`);
    assert.equal(m.messageUnsubscribeUrl(`<a href="https://news.example.org/u">Click to <abbr>un</abbr>subscribe</a>`, ""), null,
      "</abbr> does not end the link label early (the label is not unsubscribe wording)");
    assert.equal(m.messageUnsubscribeUrl(`<a href="https://news.example.org/u"><abbr>x</abbr> Unsubscribe</a>`, ""), "https://news.example.org/u");
  }

  // Outbound addresses, subjects and headers.
  for (const ok of ["a@example.org", "first.last+tag@mail.example.co.uk", "o'brien@example.org"]) assert.match(ok, m.EMAIL_PATTERN, ok);
  for (const bad of ["Name<x@example.org>", "<x@example.org>", "x@example.org.", "\"x\"@example.org", "x@example", "a b@example.org", "x@exa;mple.org"]) {
    assert.doesNotMatch(bad, m.EMAIL_PATTERN, bad);
  }
  assert.deepEqual(m.safeHeaders({ "In-Reply-To": "<a@b>", References: "<a@b> <c@d>", Bcc: "x@y", "X-Evil": "1", "in-reply-to": "<x>\r\nBcc: z" }),
    { "In-Reply-To": "<a@b>", References: "<a@b> <c@d>" });
  assert.match(source("worker/email/send.ts"), /subject = .*replace\(\/\[\\r\\n\]\+\/g/, "subjects lose CR/LF");

  // Outbound Message-IDs: only real RFC ids are kept, and Resend's is read back after sending.
  assert.equal(m.rfcMessageId("abc@mail.example.org"), "<abc@mail.example.org>");
  assert.equal(m.rfcMessageId("<abc@mail.example.org>"), "<abc@mail.example.org>");
  for (const bad of ["56761188-7520-42d8-8898-ff6fc54ce618", "", null, "a b@c", "<x@y>\r\nBcc: z"]) assert.equal(m.rfcMessageId(bad), null, String(bad));
  {
    // One API call per Resend send (its rate limit is low); the Message-ID comes from its webhooks.
    const calls = [];
    const transport = new m.ResendTransport("re_key", async (url, init = {}) => { calls.push(`${init.method ?? "GET"} ${url}`); return Response.json({ id: "re_1" }); });
    const message = { from: { email: "a@example.org", name: "A" }, replyTo: "a@example.org", to: ["b@example.net"], cc: [], bcc: [], subject: "s", text: "t", html: "<p>t</p>", attachments: [] };
    assert.deepEqual(await transport.send(message), { providerMessageId: "re_1", messageIdHeader: null });
    assert.deepEqual(calls, ["POST https://api.resend.com/emails"]);
  }
  assert.match(source("worker/webhooks/resend.ts"), /UPDATE OR IGNORE messages SET message_id = \?3 WHERE id = \?1 AND mailbox_id = \?2 AND message_id IS NULL/);
  assert.match(source("worker/email/send.ts"), /\/\/ The RFC Message-ID, never a provider's own id[^\n]*\n\s*messageIdHeader,/);

  // A reply to sent mail whose Message-ID was never reported joins its conversation and teaches the ID.
  {
    const db = database();
    const env = { DB: d1(db) };
    const recent = new Date().toISOString();
    db.exec(`INSERT INTO threads (id, mailbox_id, latest_message_at) VALUES ('t9', 'native:work', '${recent}')`);
    db.exec(`INSERT INTO messages (id, mailbox_id, thread_id, direction, from_address, to_addresses, subject, preview, received_at, sent_at, delivery_status)
      VALUES ('o1', 'native:work', 't9', 'outbound', 'work@example.org', '["Bob@Example.net"]', 'Plans', '', '${recent}', '${recent}', 'sent')`);
    assert.equal(m.baseSubject("RE: Fwd: Re[2]: Plans"), "plans");
    const learned = await m.resolveThreadId(env, "native:work", "<real@cf.example>", null, "bob@example.net", "Re: Plans");
    assert.deepEqual(learned, { threadId: "t9", learned: { id: "o1", messageId: "<real@cf.example>" } });
    for (const [from, subject] of [["eve@example.net", "Re: Plans"], ["bob@example.net", "Re: Other"]]) {
      assert.notEqual((await m.resolveThreadId(env, "native:work", "<real@cf.example>", null, from, subject)).threadId, "t9", `${from} / ${subject}`);
    }
    db.exec("UPDATE messages SET message_id = '<known@x>' WHERE id = 'o1'");
    assert.equal((await m.resolveThreadId(env, "native:work", "<other@cf.example>", null, "bob@example.net", "Re: Plans")).learned, null,
      "only sent mail whose ID is unknown is matched by subject");
    assert.deepEqual(await m.resolveThreadId(env, "native:work", "<known@x>", null, "x@y.z", "anything"), { threadId: "t9", learned: null });
    db.exec("UPDATE messages SET message_id = NULL WHERE id = 'o1'");
    assert.equal((await m.resolveThreadId(env, "native:work", "<forged@x>", null, "bob@example.net", "Re: Plans", false)).learned, null,
      "junk or unauthenticated mail never teaches an ID");
    assert.match(source("worker/email/receive.ts"), /!isJunk && senderAuthenticated\(authenticationHeaders, fromAddress\)/);
    assert.match(source("worker/email/receive.ts"), /UPDATE OR IGNORE messages SET message_id=\?3/);
  }

  // Drafts: a late save of a sent draft, another mailbox's id, or a malformed reply target is refused.
  {
    const db = database();
    const env = { DB: d1(db) };
    db.exec("INSERT INTO native_mailboxes (id, email_address, display_name) VALUES ('native:other', 'other@example.org', 'Other')");
    const save = (accountId, body) => m.saveDraft(new Request("https://mail.example.org/api/drafts", { method: "POST",
      body: JSON.stringify({ accountId, ...body }) }), env);
    assert.equal((await save("native:work", { id: "draft-0001", subject: "Hello" })).status, 200);
    assert.equal((await save("native:other", { id: "draft-0001", subject: "Takeover" })).status, 409, "another mailbox's draft id");
    assert.equal(db.prepare("SELECT subject FROM drafts WHERE id = 'draft-0001'").get().subject, "Hello");
    db.exec("INSERT INTO outbound_attempts (mailbox_id, client_key, message_id, state) VALUES ('native:work', 'draft-0001', 'm', 'pending')");
    assert.equal((await save("native:work", { id: "draft-0001", subject: "Edited" })).status, 200, "a send left pending never blocks editing");
    db.exec("UPDATE outbound_attempts SET state = 'accepted' WHERE client_key = 'draft-0001'");
    db.exec("DELETE FROM drafts WHERE id = 'draft-0001'");
    assert.equal((await save("native:work", { id: "draft-0001", subject: "late" })).status, 409, "a sent draft is not recreated");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM drafts").get().n, 0);
    assert.equal((await save("native:work", { id: "draft-0002", replyToMessageId: "x".repeat(300) })).status, 400);
    assert.equal((await save("native:work", { id: "draft-0002", forwardMessageId: "a b" })).status, 400);
  }

  // Attachment names cannot hide their extension with bidi controls.
  assert.equal(m.safeFilename("invoice‮fdp.exe", "attachment").includes("‮"), false);
  assert.equal(m.safeFilename("", "attachment"), "attachment");

  // Conversation-wide changes on native mailboxes; bulk actions on exactly the selected messages.
  {
    const db = database();
    const env = { DB: d1(db) };
    db.exec(`INSERT INTO threads (id, mailbox_id, latest_message_at) VALUES ('t1', 'native:work', '2026-10-18T00:00:00Z'), ('t2', 'native:work', '2026-10-18T00:00:00Z')`);
    for (const [id, thread, direction] of [["m1", "t1", "inbound"], ["m2", "t1", "inbound"], ["m3", "t2", "inbound"], ["s1", "t1", "outbound"]]) {
      db.exec(`INSERT INTO messages (id, mailbox_id, thread_id, direction, from_address, to_addresses, subject, preview, received_at, is_read)
        VALUES ('${id}', 'native:work', '${thread}', '${direction}', 'a@example.net', '[]', 's', '', '2026-10-18T00:00:00Z', ${direction === "outbound" ? 1 : 0})`);
    }
    const flags = () => Object.fromEntries(db.prepare("SELECT id, is_archived, is_junk, is_deleted FROM messages ORDER BY id").all()
      .map(row => [row.id, `${row.is_archived}${row.is_junk}${row.is_deleted}`]));
    const provider = m.nativeProvider(env, "native:work", "work@example.org", "Work");
    assert.equal(await provider.patchThread("m1", { isArchived: true }), true);
    assert.deepEqual(flags(), { m1: "100", m2: "100", m3: "000", s1: "000" }, "your own reply stays in Sent");
    assert.equal(await provider.patchThread("m2", { isJunk: true }), true);
    assert.deepEqual(flags(), { m1: "110", m2: "110", m3: "000", s1: "000" });
    assert.equal(await provider.patchThread("missing", { isDeleted: true }), false);
    assert.equal(await provider.patchThread("m1", { isDeleted: true }), true);
    assert.deepEqual(flags(), { m1: "111", m2: "111", m3: "000", s1: "001" }, "deleting a conversation takes all of it");
    db.exec("UPDATE messages SET is_archived = 0, is_junk = 0, is_deleted = 0");
    assert.equal(await provider.patchThread("s1", { isArchived: true }), true, "the opened sent message itself is archived");
    assert.deepEqual(flags(), { m1: "100", m2: "100", m3: "000", s1: "100" });
    assert.equal(await provider.patchThread("m1", { isArchived: false }), true);
    assert.deepEqual(flags(), { m1: "000", m2: "000", m3: "000", s1: "000" }, "unarchiving restores the whole conversation");
    const bulk = (ids, action) => m.bulkMailAction(new Request("https://mail.example.org/api/messages/bulk?accountId=native:work",
      { method: "POST", body: JSON.stringify({ ids, action }) }), env, { waitUntil() {} });
    assert.equal((await bulk(["m1"], "archive")).status, 200);
    assert.deepEqual(flags(), { m1: "100", m2: "000", m3: "000", s1: "000" }, "selection mode acts on the selected message only");
    assert.equal((await bulk(["m1"], "unarchive")).status, 200);
    assert.equal((await bulk(["m1"], "read")).status, 200);
    assert.deepEqual(db.prepare("SELECT id FROM messages WHERE is_read = 1 AND direction = 'inbound'").all().map(row => row.id), ["m1"], "read state stays per message");

    // Opening a conversation reads all of it; newlyReadCount covers only mail the badge counts.
    db.exec("UPDATE messages SET is_read = 0 WHERE direction = 'inbound'; UPDATE messages SET is_archived = 1 WHERE id = 'm2'");
    const response = await m.getMessage(new Request("https://mail.example.org/api/messages/m1?accountId=native:work"), "m1",
      { DB: env.DB, MAIL: { get: async () => null } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).newlyReadCount, 1, "the archived unread message was never in the badge");
    assert.deepEqual(db.prepare("SELECT id FROM messages WHERE is_read = 1 AND direction = 'inbound' ORDER BY id").all().map(row => row.id), ["m1", "m2"]);
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
  assert.match(send, /existing\.state === "accepted"\) \{[\s\S]{0,200}DELETE FROM drafts/, "a retried, already accepted send removes its draft");
  // Drafts are bounded per mailbox.
  assert.match(source("worker/api/drafts.ts"), /MAX_DRAFTS_PER_MAILBOX = 200/);

  console.log("PASS: review fixes (rate limits, body limits, linear HTML, outbound checks, Message-IDs, drafts, conversation actions, unread counts)");
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
    `export { saveDraft } from "${file("api/drafts.ts")}";`,
    `export { rfcMessageId } from "${file("transports/types.ts")}";`,
    `export { ResendTransport } from "${file("transports/resend.ts")}";`,
    `export { baseSubject, resolveThreadId } from "${file("email/receive.ts")}";`,
  ].join("\n"));
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"],
    outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
