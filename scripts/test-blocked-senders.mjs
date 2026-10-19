// v3.09: per-mailbox blocked senders. Pattern rules, the API against the real
// migrations on node:sqlite, and the inbound/authorization wiring.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { blockPattern, senderPatterns } from "../src/worker/blockedSenderRules.ts";
import { protectedAccountPath } from "../src/worker/accountAccess.ts";
import { d1, migratedDatabase } from "./test-harness.mjs";

// Patterns: one address, or a domain (with or without @) that covers subdomains.
assert.equal(blockPattern(" Spam@Example.COM "), "spam@example.com");
assert.equal(blockPattern("<spam@example.com>"), "spam@example.com");
assert.equal(blockPattern("example.com"), "@example.com");
assert.equal(blockPattern("@Example.com"), "@example.com");
for (const bad of ["", "nope", "a@b", "@", "x@@y.com", "@com", 42, null, "a b@example.com", "x".repeat(300) + "@example.com"]) {
  assert.equal(blockPattern(bad), null, String(bad));
}
assert.deepEqual(senderPatterns("News@Mail.Example.co.uk"),
  ["news@mail.example.co.uk", "@mail.example.co.uk", "@example.co.uk", "@co.uk"], "never a bare top-level domain");
assert.deepEqual(senderPatterns("not-an-address"), []);

// Authorization: the route is per account, like the mail API.
assert.equal(protectedAccountPath("/api/blocked-senders"), true);
const receive = readFileSync(new URL("../src/worker/email/receive.ts", import.meta.url), "utf8");
assert.match(receive, /const isJunk = await isBlockedSender\(env, mailbox\.id, \[sender\?\.address, message\.from\]\)/,
  "blocked senders (header From or envelope) are delivered to Junk");
assert.match(readFileSync(new URL("../src/worker/mailboxes.ts", import.meta.url), "utf8"), /DELETE FROM blocked_senders WHERE mailbox_id=\?1/,
  "purging a mailbox removes its block list");

function database() {
  const db = migratedDatabase();
  db.exec("INSERT INTO native_mailboxes (id, email_address, display_name) VALUES ('native:work', 'work@example.org', 'Work')");
  let n = 0;
  const message = (mailbox, from) => {
    n += 1;
    db.exec(`INSERT INTO threads (id, mailbox_id, latest_message_at) VALUES ('t${n}', '${mailbox}', '2026-10-18T00:00:00Z')`);
    db.exec(`INSERT INTO messages (id, mailbox_id, thread_id, direction, from_address, to_addresses, subject, preview, received_at)
      VALUES ('m${n}', '${mailbox}', 't${n}', 'inbound', '${from}', '[]', 's', '', '2026-10-18T00:00:00Z')`);
  };
  message("native:work", "Spammer@Junkmail.com");
  message("native:work", "promo@news.junkmail.com");
  message("native:work", "friend@example.net");
  message("native:primary", "spammer@junkmail.com");
  return db;
}
const junk = (db, mailbox) => db.prepare("SELECT from_address FROM messages WHERE mailbox_id = ? AND is_junk = 1 ORDER BY id").all(mailbox).map(r => r.from_address);

async function run(m) {
  const db = database();
  const env = { DB: d1(db) };
  const url = (accountId, extra = "") => new URL(`https://mail.example.org/api/blocked-senders?accountId=${encodeURIComponent(accountId)}${extra}`);
  const post = body => new Request("https://mail.example.org/api/blocked-senders", { method: "POST", body: JSON.stringify(body) });

  assert.equal((await m.listBlockedSenders(env, url("gmail:x"))).status, 400, "Gmail accounts use Gmail's own block");
  assert.equal((await m.listBlockedSenders(env, url("native:missing"))).status, 404);
  assert.equal((await m.addBlockedSender(post({ sender: "nonsense" }), env, url("native:work"))).status, 400);

  // Blocking one address moves that sender's existing mail in this mailbox only.
  let response = await m.addBlockedSender(post({ sender: "spammer@junkmail.com" }), env, url("native:work"));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).moved, 1);
  assert.deepEqual(junk(db, "native:work"), ["Spammer@Junkmail.com"]);
  assert.deepEqual(junk(db, "native:primary"), [], "other mailboxes are unaffected");
  assert.equal(await m.isBlockedSender(env, "native:work", ["SPAMMER@junkmail.com"]), true);
  assert.equal(await m.isBlockedSender(env, "native:primary", ["spammer@junkmail.com"]), false);
  assert.equal(await m.isBlockedSender(env, "native:work", [null, "bounce@other.com", "spammer@junkmail.com"]), true, "envelope sender counts too");

  // Blocking a domain covers subdomains; moveExisting:false leaves mail where it is.
  response = await m.addBlockedSender(post({ sender: "junkmail.com", moveExisting: false }), env, url("native:work"));
  assert.equal((await response.json()).moved, 0);
  assert.equal(await m.isBlockedSender(env, "native:work", ["anyone@deep.news.junkmail.com"]), true);
  assert.equal(await m.isBlockedSender(env, "native:work", ["x@notjunkmail.com"]), false, "only the domain and its subdomains");
  response = await m.addBlockedSender(post({ sender: "@junkmail.com" }), env, url("native:work"));
  assert.equal((await response.json()).moved, 1, "re-blocking the domain moves the subdomain sender");
  assert.deepEqual(junk(db, "native:work"), ["Spammer@Junkmail.com", "promo@news.junkmail.com"]);

  const listed = await (await m.listBlockedSenders(env, url("native:work"))).json();
  assert.deepEqual(listed.blocked.map(b => b.pattern).sort(), ["@junkmail.com", "spammer@junkmail.com"]);

  // Unblocking stops future matches; mail already in Junk stays there.
  response = await m.removeBlockedSender(env, url("native:work", "&pattern=" + encodeURIComponent("@junkmail.com")));
  assert.equal(response.status, 200);
  assert.equal(await m.isBlockedSender(env, "native:work", ["promo@news.junkmail.com"]), false);
  assert.equal(junk(db, "native:work").length, 2);

  console.log("PASS: blocked senders are per mailbox, cover domains and subdomains, and route mail to Junk");
}

const out = mkdtempSync(join(tmpdir(), "ltm-blocked-"));
try {
  const entry = join(out, "entry.ts");
  writeFileSync(entry, `export * from "${new URL("../src/worker/blockedSenders.ts", import.meta.url).pathname}";`);
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*"],
    outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
