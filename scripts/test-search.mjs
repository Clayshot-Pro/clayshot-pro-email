// Mail search: the whole term matches as literal text (instr), so quotes,
// %, _ and \ are plain characters, a long search keeps its full meaning, and
// D1's 50-byte LIKE pattern limit never applies. Runs the Worker's native
// provider on node:sqlite against the real migrations.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { d1, migratedDatabase } from "./test-harness.mjs";

const long = "weekly internship roundup for north american students";
const subjects = [`${long} part one`, `${long} part two`, "50% off today", "under_score", "quote ' OR 1=1 --", "back\\slash"];

async function run(m) {
  const db = migratedDatabase();
  db.exec("INSERT INTO native_mailboxes (id, email_address, display_name) VALUES ('native:work', 'work@example.org', 'Work')");
  db.exec("INSERT INTO native_mailboxes (id, email_address, display_name) VALUES ('native:other', 'other@example.org', 'Other')");
  const insert = db.prepare(`INSERT INTO messages (id, mailbox_id, thread_id, direction, from_address, to_addresses, subject, preview, received_at)
    VALUES (?, ?, ?, 'inbound', 'sender@example.net', '[]', ?, '', '2026-10-23T00:00:00Z')`);
  const thread = db.prepare("INSERT INTO threads (id, mailbox_id, latest_message_at) VALUES (?, ?, '2026-10-23T00:00:00Z')");
  subjects.forEach((subject, i) => { thread.run(`t${i}`, "native:work"); insert.run(`m${i}`, "native:work", `t${i}`, subject); });
  thread.run("tx", "native:other"); insert.run("mx", "native:other", "tx", `${long} part one`);

  const mailboxes = db.prepare("SELECT COUNT(*) AS n FROM native_mailboxes").get().n;
  const provider = m.nativeProvider({ DB: d1(db) }, "native:work", "work@example.org", "Work");
  const search = async term => (await provider.listMessages({ folder: "inbox", search: term, limit: 50 })).map(message => message.subject).sort();

  assert.ok(`${long} part one`.length > 50, "the term is longer than D1's LIKE limit");
  assert.deepEqual(await search(`${long} part one`), [`${long} part one`], "a long search keeps its full meaning");
  assert.deepEqual(await search(long.toUpperCase()), [`${long} part one`, `${long} part two`], "case-insensitive, and only this mailbox");
  assert.deepEqual(await search("%"), ["50% off today"], "% is literal");
  assert.deepEqual(await search("_"), ["under_score"], "_ is literal");
  assert.deepEqual(await search("\\"), ["back\\slash"], "\\ is literal");
  assert.deepEqual(await search("' OR 1=1 --"), ["quote ' OR 1=1 --"], "an injection string is only text");
  assert.deepEqual(await search("') UNION SELECT * FROM native_mailbox_credentials --"), [], "and matches nothing it does not contain");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM native_mailboxes").get().n, mailboxes, "tables are intact");

  const mail = readFileSync(new URL("../src/worker/api/mail.ts", import.meta.url), "utf8");
  assert.match(mail, /instr\(LOWER\(subject\), \?\) > 0 OR instr\(LOWER\(body_text\), \?\) > 0/, "draft search uses the same literal match");
  for (const file of ["providers/native.ts", "api/mail.ts", "blockedSenders.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(`../src/worker/${file}`, import.meta.url), "utf8"), /\bLIKE\s+(\?|')/, `${file}: no LIKE patterns (D1 caps them at 50 bytes)`);
  }
  console.log("PASS: mail search is literal, bound, complete for long terms and limited to its mailbox");
}

const out = mkdtempSync(join(tmpdir(), "ltm-search-"));
try {
  const entry = join(out, "entry.ts");
  writeFileSync(entry, `export * from "${new URL("../src/worker/providers/native.ts", import.meta.url).pathname}";`);
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"],
    outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
