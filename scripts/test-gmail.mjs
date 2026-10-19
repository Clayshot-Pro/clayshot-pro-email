// Gmail accounts: the Google sign-in flow and reading Gmail mail. Runs the
// Worker code on node:sqlite with the real migrations; Google is faked behind fetch.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function attachments(m) {
  const db = migratedDatabase();
  const env = googleEnv(db);
  db.exec("INSERT INTO connected_accounts (id, provider, provider_account_id, email_address, status) VALUES ('gmail:me', 'gmail', 'me@gmail.com', 'me@gmail.com', 'active')");
  const credential = await m.encryptSecret(env, { refreshToken: "refresh", accessToken: "access",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: "https://www.googleapis.com/auth/gmail.modify" }, "credential:gmail:me");
  db.prepare("INSERT INTO provider_credentials (account_id, encrypted_blob) VALUES ('gmail:me', ?)").run(credential);

  // Gmail hands out a fresh attachment id each time the message is read, so the
  // part is found again by its partId.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const files = { "1": { filename: "photo.png", mimeType: "image/png", data: png }, "2": { filename: "page.html", mimeType: "text/html", data: Buffer.from("<script>x</script>") } };
  let reads = 0;
  const gmail = async url => {
    const path = new URL(String(url)).pathname;
    const attachment = path.match(/\/messages\/m1\/attachments\/att-\d+-(\d)$/);
    if (attachment) return Response.json({ data: files[attachment[1]].data.toString("base64url"), size: files[attachment[1]].data.length });
    if (path.endsWith("/messages/m1")) {
      reads++;
      return Response.json({ id: "m1", threadId: "t1", labelIds: ["INBOX"], internalDate: String(Date.now()), payload: {
        mimeType: "multipart/mixed", headers: [{ name: "From", value: "a@example.net" }, { name: "Subject", value: "Files" }],
        parts: [{ partId: "0", mimeType: "text/plain", body: { data: Buffer.from("hi").toString("base64url"), size: 2 } },
          ...Object.entries(files).map(([partId, file]) => ({ partId, mimeType: file.mimeType, filename: file.filename,
            body: { attachmentId: `att-${reads}-${partId}`, size: file.data.length } }))],
      } });
    }
    return new Response("{}", { status: 404 });
  };
  const detail = await withFetch(gmail, () => m.gmailFullMessage(env, "gmail:me", "m1"));
  assert.deepEqual(detail.attachments.map(file => [file.filename, file.partId]), [["photo.png", "1"], ["page.html", "2"]], "attachments name their part");
  const photo = detail.attachments[0];
  const url = (route, query) => new Request(`${ORIGIN}/api/${route}/${encodeURIComponent(photo.id)}?${new URLSearchParams({ accountId: "gmail:me", ...query })}`);

  const preview = await withFetch(gmail, () => m.previewAttachment(url("attachment-previews", { messageId: "m1", partId: "1" }), photo.id, env));
  assert.equal(preview.status, 200, "a Gmail image previews");
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.match(preview.headers.get("content-disposition"), /^inline; filename\*=UTF-8''photo\.png$/);
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.match(preview.headers.get("content-security-policy"), /^default-src 'none'/);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  const unsafe = await withFetch(gmail, () => m.previewAttachment(url("attachment-previews", { messageId: "m1", partId: "2" }), detail.attachments[1].id, env));
  assert.equal(unsafe.status, 415, "only images and PDFs preview inline");
  const download = await withFetch(gmail, () => m.downloadAttachment(url("attachments", { messageId: "m1", partId: "1" }), photo.id, env));
  assert.equal(download.status, 200, "a Gmail attachment downloads");
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  const stale = await withFetch(gmail, () => m.downloadAttachment(url("attachments", { messageId: "m1" }), photo.id, env));
  assert.equal(stale.status, 404, "without its partId an attachment id from an earlier read is not trusted");
  for (const route of ["attachment-previews", "attachments"]) {
    const missing = await withFetch(gmail, () => (route === "attachments" ? m.downloadAttachment : m.previewAttachment)(url(route, {}), photo.id, env));
    assert.equal(missing.status, 400, `${route} needs the Gmail message id`);
  }

  // The reader and the preview build their links with the message and part.
  const client = readFileSync(new URL("../src/client/mailUtils.ts", import.meta.url), "utf8");
  assert.match(client, /new URLSearchParams\(\{ accountId, messageId \}\)/);
  assert.match(client, /query\.set\("partId", attachment\.partId\)/);
  for (const component of ["AttachmentPreview", "MessageReader"]) {
    const text = readFileSync(new URL(`../src/client/components/${component}.tsx`, import.meta.url), "utf8");
    assert.match(text, /attachmentUrls\(/, `${component} uses attachmentUrls`);
    assert.doesNotMatch(text, /\/api\/attachment/, `${component} builds no attachment links by hand`);
  }
}

async function run(m) {
  await oauthState(m);
  await attachments(m);
  console.log("PASS: Gmail sign-in states expire after ten minutes; Gmail attachments preview and download");
}

const out = mkdtempSync(join(tmpdir(), "ltm-gmail-"));
try {
  const entry = join(out, "entry.ts");
  const file = path => new URL(`../src/${path}`, import.meta.url).pathname;
  writeFileSync(entry, [
    `export { googleOAuthCallback, startGoogleOAuth } from "${file("worker/providers/google.ts")}";`,
    `export { encryptSecret } from "${file("worker/providers/crypto.ts")}";`,
    `export { gmailFullMessage } from "${file("worker/providers/gmailProvider.ts")}";`,
    `export { previewAttachment } from "${file("worker/api/attachments.ts")}";`,
    `export { downloadAttachment } from "${file("worker/api/mail.ts")}";`,
  ].join("\n"));
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"],
    outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
