// Gmail accounts: the Google sign-in flow and reading Gmail mail. Runs the
// Worker code on node:sqlite with the real migrations; Google is faked behind fetch.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { d1, migratedDatabase } from "./test-harness.mjs";

const ORIGIN = "https://mail.example.org";
const googleEnv = db => ({
  DB: d1(db), GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret",
  PROVIDER_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64url"),
});

async function withFetch(handler, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

async function oauthState(m) {
  // The sign-in state lasts ten minutes, stored in SQLite's own time format so
  // comparisons with CURRENT_TIMESTAMP are exact.
  const db = migratedDatabase();
  const env = googleEnv(db);
  const start = await m.startGoogleOAuth(new Request(`${ORIGIN}/api/accounts/gmail/connect`, { method: "POST" }), env);
  assert.equal(start.status, 200);
  const state = new URL((await start.json()).authorizationUrl).searchParams.get("state");
  const nonce = start.headers.get("Set-Cookie").split(";")[0];
  const stored = db.prepare("SELECT expires_at, (julianday(expires_at) - julianday('now')) * 86400 AS seconds FROM oauth_states").get();
  assert.ok(stored.seconds > 590 && stored.seconds <= 600, `valid for ten minutes (${stored.seconds})`);

  // Eleven minutes later (the stored time moved back, in whatever format it was written)
  // the state is refused without asking Google.
  const written = Date.parse(stored.expires_at.includes("T") ? stored.expires_at : `${stored.expires_at.replace(" ", "T")}Z`);
  const earlier = new Date(written - 660_000).toISOString();
  db.prepare("UPDATE oauth_states SET expires_at = ?").run(stored.expires_at.includes("T") ? earlier : earlier.slice(0, 19).replace("T", " "));
  let tokenCalls = 0;
  const callback = await withFetch(async () => { tokenCalls++; return new Response("{}", { status: 400 }); },
    () => m.googleOAuthCallback(new Request(`${ORIGIN}/api/accounts/gmail/callback?state=${state}&code=abc`, { headers: { Cookie: nonce } }), env));
  assert.equal(new URL(callback.headers.get("Location")).searchParams.get("gmail"), "expired");
  assert.equal(tokenCalls, 0, "an expired state never reaches the token endpoint");
  assert.match(stored.expires_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, "expires_at uses SQLite's datetime format");
  await m.startGoogleOAuth(new Request(`${ORIGIN}/api/accounts/gmail/connect`, { method: "POST" }), env);
  db.exec("UPDATE oauth_states SET expires_at = datetime('now', '-1 second') WHERE rowid = (SELECT MIN(rowid) FROM oauth_states)");
  await m.startGoogleOAuth(new Request(`${ORIGIN}/api/accounts/gmail/connect`, { method: "POST" }), env);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM oauth_states WHERE expires_at <= CURRENT_TIMESTAMP").get().n, 0,
    "expired states are removed on the next connect");
}

async function run(m) {
  await oauthState(m);
  console.log("PASS: Gmail sign-in states expire after ten minutes");
}

const out = mkdtempSync(join(tmpdir(), "ltm-gmail-"));
try {
  const entry = join(out, "entry.ts");
  const file = path => new URL(`../src/${path}`, import.meta.url).pathname;
  writeFileSync(entry, [
    `export { googleOAuthCallback, startGoogleOAuth } from "${file("worker/providers/google.ts")}";`,
  ].join("\n"));
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"],
    outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
