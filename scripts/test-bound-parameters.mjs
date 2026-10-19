// D1 binds at most 100 parameters per statement. Queries over a list of ids or
// patterns split it, so a large instance or a crafted address cannot break them.
// Runs the Worker code on node:sqlite (whose D1 stub enforces the limit).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { d1, migratedDatabase } from "./test-harness.mjs";

async function run(m) {
  assert.deepEqual(m.chunked([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(m.chunked([], 2), []);

  // Account colours with more mailboxes than one statement can bind.
  {
    const db = migratedDatabase();
    const insert = db.prepare("INSERT INTO native_mailboxes (id, email_address, display_name, accent_color) VALUES (?, ?, ?, '#336699')");
    const ids = Array.from({ length: 150 }, (_, i) => `native:box${i}`);
    ids.forEach((id, i) => insert.run(id, `box${i}@example.org`, `Box ${i}`));
    const colors = await m.accountColors({ DB: d1(db) }, ids);
    assert.equal(colors.size, 150, "every mailbox keeps its colour");
    assert.equal(colors.get("native:box149"), "#336699");
  }

  // A sender domain with very many labels is still checked against the block list.
  {
    const db = migratedDatabase();
    db.exec("INSERT INTO native_mailboxes (id, email_address, display_name) VALUES ('native:work', 'work@example.org', 'Work')");
    db.exec("INSERT INTO blocked_senders (mailbox_id, pattern) VALUES ('native:work', '@junkmail.com')");
    const sender = `spam@${Array.from({ length: 150 }, () => "x").join(".")}.junkmail.com`;
    assert.equal(await m.isBlockedSender({ DB: d1(db) }, "native:work", [sender]), true, "the block applies however long the domain");
    assert.equal(await m.isBlockedSender({ DB: d1(db) }, "native:work", [sender.replace("junkmail", "fine")]), false);
  }

  console.log("PASS: id and pattern lists stay within D1's 100 bound parameters");
}

const out = mkdtempSync(join(tmpdir(), "ltm-bound-"));
try {
  const entry = join(out, "entry.ts");
  const file = path => new URL(`../src/worker/${path}`, import.meta.url).pathname;
  writeFileSync(entry, [
    `export { chunked } from "${file("sql.ts")}";`,
    `export { accountColors } from "${file("branding.ts")}";`,
    `export { isBlockedSender } from "${file("blockedSenders.ts")}";`,
  ].join("\n"));
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"],
    outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
