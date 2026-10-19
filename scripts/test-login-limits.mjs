// Mailbox sign-in: the per-account limit counts guesses per mailbox, however
// the address is typed ("work" or "work@example.org"), so spreading guesses
// over address forms and IPs never buys extra attempts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { d1, migratedDatabase } from "./test-harness.mjs";

async function run(m) {
  const db = migratedDatabase();
  db.exec("INSERT OR REPLACE INTO domains (domain,status,is_primary) VALUES ('example.org','active',1)");
  db.exec("INSERT INTO native_mailboxes (id, email_address, display_name, domain) VALUES ('native:work', 'work@example.org', 'Work', 'example.org')");
  const env = { DB: d1(db) };
  await m.setMailboxPassword(env, "native:work", "correct-horse");

  let ip = 0;
  const attempt = async (email, password) => (await m.deviceLogin(new Request("https://mail.example.org/api/device/login", {
    method: "POST",
    // A new address per guess: only the per-account limit applies.
    headers: { "CF-Connecting-IP": `198.51.100.${++ip}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }), env)).status;

  const statuses = [];
  for (let i = 0; i < 40; i++) statuses.push(await attempt(i % 2 ? "work" : " Work@Example.org", `wrong-${i}`));
  assert.equal(statuses.filter(status => status === 401).length, m.ACCOUNT_LOGIN_MAX_ATTEMPTS, "one allowance per mailbox");
  assert.ok(statuses.slice(m.ACCOUNT_LOGIN_MAX_ATTEMPTS).every(status => status === 429));
  assert.equal(await attempt("work", "correct-horse"), 429, "the right password waits for the window too");

  db.exec("DELETE FROM auth_rate_limits");
  assert.equal(await attempt("work", "correct-horse"), 200, "a bare local part signs in to the primary domain mailbox");
}

const out = mkdtempSync(join(tmpdir(), "ltm-login-limits-"));
try {
  const entry = join(out, "entry.ts");
  const src = new URL("../src/worker/", import.meta.url).pathname;
  writeFileSync(entry, `export { deviceLogin, setMailboxPassword } from "${src}deviceAuth.ts";
export { ACCOUNT_LOGIN_MAX_ATTEMPTS } from "${src}security.ts";`);
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"],
    outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
  console.log("PASS: one sign-in allowance per mailbox, whatever the address form");
} finally {
  rmSync(out, { recursive: true, force: true });
}
