// Unit tests for small security- and correctness-critical helpers that had
// no direct tests: secret comparison, HTML escaping, credential encryption,
// the Worker's first-pass HTML sanitizer and the client's folder rules.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const out = mkdtempSync(join(tmpdir(), "ltm-unit-"));
try {
  const root = new URL("..", import.meta.url).pathname;
  await build({
    stdin: { contents: `export * from "./src/worker/constantTime.ts";
export * from "./src/worker/email/textHtml.ts";
export * from "./src/worker/providers/crypto.ts";
export { sanitizeEmailHtml } from "./src/worker/email/html.ts";
export { adminMailboxAddressFor } from "./src/worker/mailboxIds.ts";
export { belongsInFolder, hasDraftContent, base64UrlToArrayBuffer, EMPTY_COMPOSE } from "./src/client/appModel.ts";`,
      resolveDir: root, loader: "ts" },
    bundle: true, format: "esm", platform: "neutral", external: ["node:*"], outfile: join(out, "unit.mjs"), logLevel: "error",
  });
  const m = await import(pathToFileURL(join(out, "unit.mjs")).href);

  // Secret comparison: exact match only, never with a missing secret.
  assert.equal(m.constantTimeEqual("abc", "abc"), true);
  assert.equal(m.constantTimeEqual("abc", "abd"), false);
  assert.equal(m.constantTimeEqual("abc", "abcd"), false, "a prefix is not a match");
  assert.equal(m.constantTimeEqual("", ""), true);
  assert.equal(m.secretMatches(undefined, ""), false, "an unset secret never matches");
  assert.equal(m.secretMatches("", ""), false);
  assert.equal(m.secretMatches("s3cret", "s3cret"), true);
  assert.equal(m.secretMatches("s3cret", ["s3cret"]), false, "only strings are compared");
  assert.equal(m.secretMatches("s3cret", "S3CRET"), false);

  // Plain text becomes inert HTML.
  assert.equal(m.escapeHtml(`<a href="x" onclick='y'>&</a>`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(m.textToHtml("line 1\n<b>2</b>"), '<div style="white-space:pre-wrap;font-family:Arial,sans-serif">line 1<br>&lt;b&gt;2&lt;/b&gt;</div>');

  // Credential encryption: round trip, bound to its name, tamper-evident, key-specific.
  const env = { PROVIDER_CREDENTIAL_KEY: Buffer.alloc(32, 9).toString("base64url") };
  const sealed = await m.encryptSecret(env, { token: "t0ken" }, "instance-key:RESEND_API_KEY");
  assert.match(sealed, /^v1\.[\w-]+\.[\w-]+$/);
  assert.ok(!sealed.includes("t0ken"));
  assert.deepEqual(await m.decryptSecret(env, sealed, "instance-key:RESEND_API_KEY"), { token: "t0ken" });
  await assert.rejects(m.decryptSecret(env, sealed, "instance-key:GOOGLE_CLIENT_SECRET"), "a value cannot be moved to another name");
  const [version, iv, data] = sealed.split(".");
  const flipped = `${version}.${iv}.${data.slice(0, -2)}${data.at(-2) === "A" ? "B" : "A"}${data.at(-1)}`;
  await assert.rejects(m.decryptSecret(env, flipped, "instance-key:RESEND_API_KEY"), "tampering is detected");
  await assert.rejects(m.decryptSecret({ PROVIDER_CREDENTIAL_KEY: Buffer.alloc(32, 1).toString("base64url") }, sealed, "instance-key:RESEND_API_KEY"));
  assert.notEqual(await m.encryptSecret(env, "same", "a"), await m.encryptSecret(env, "same", "a"), "a fresh IV every time");
  assert.equal(await m.credentialEncryptionAvailable({ PROVIDER_CREDENTIAL_KEY: "short" }), false);
  assert.equal(await m.credentialEncryptionAvailable({}), false);
  assert.equal(await m.credentialEncryptionAvailable(env), true);

  // The Worker's first sanitizer pass (the browser sanitizer and sandbox follow; see scripts/e2e).
  const clean = m.sanitizeEmailHtml(`<p onclick="x()">hi</p><script>bad()</script><iframe src="https://e.test"></iframe>
    <a href="javascript:bad()">j</a><a href=javascript:bad()>u</a><img src="https://track.test/p.png" srcset="https://t.test/a 1x">
    <form action="https://e.test"><input></form><svg onload=bad()></svg>`);
  assert.doesNotMatch(clean, /<script|<iframe|<form|<input|<svg|onclick|onload|=["']?\s*javascript:|srcset|track\.test/i);
  assert.match(clean, /data-remote-image-blocked="true"/);
  assert.match(clean, /<p\s*>hi<\/p>/);

  assert.equal(m.adminMailboxAddressFor("Example.ORG"), "admin@example.org");

  // Client folder rules.
  const message = (extra = {}) => ({ isDraft: false, isDeleted: false, isJunk: false, isStarred: false, isArchived: false, direction: "inbound", ...extra });
  assert.equal(m.belongsInFolder("inbox", message()), true);
  assert.equal(m.belongsInFolder("inbox", message({ isArchived: true })), false);
  assert.equal(m.belongsInFolder("archive", message({ isArchived: true })), true);
  assert.equal(m.belongsInFolder("inbox", message({ isJunk: true })), false, "junk never shows in the inbox");
  assert.equal(m.belongsInFolder("junk", message({ isJunk: true })), true);
  assert.equal(m.belongsInFolder("junk", message({ isJunk: true, isDeleted: true })), false, "deleted junk is in Trash");
  assert.equal(m.belongsInFolder("trash", message({ isDeleted: true, isJunk: true })), true);
  assert.equal(m.belongsInFolder("starred", message({ isStarred: true, isDeleted: true })), false);
  assert.equal(m.belongsInFolder("sent", message({ direction: "outbound" })), true);
  assert.equal(m.belongsInFolder("drafts", message({ isDraft: true })), true);
  assert.equal(m.belongsInFolder("inbox", message({ isDraft: true })), false);
  assert.equal(m.hasDraftContent(m.EMPTY_COMPOSE), false);
  assert.equal(m.hasDraftContent({ ...m.EMPTY_COMPOSE, subject: "  " }), false, "whitespace is not content");
  assert.equal(m.hasDraftContent({ ...m.EMPTY_COMPOSE, replyToMessageId: "m1" }), true);
  assert.deepEqual([...new Uint8Array(m.base64UrlToArrayBuffer("AQID_w"))], [1, 2, 3, 255]);
  assert.throws(() => m.base64UrlToArrayBuffer("not base64!"), /invalid/);

  console.log("PASS: secret comparison, escaping, credential encryption, first-pass sanitizer and folder rules");
} finally {
  rmSync(out, { recursive: true, force: true });
}
