// Cloudflare Email Sending API transport (all Cloudflare sending goes through it).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CloudflareApiTransport, cloudflareApiPayload, mapCloudflareApiError, MAX_API_MESSAGE_BYTES } from "../src/worker/transports/cloudflareApi.ts";
import { SAFE_DELIVERY_CODES } from "../src/worker/transports/types.ts";

const accountId = "a".repeat(32);
const secret = "test-secret-private";
const message = {
  from: { email: "new@example.com", name: "New Mailbox" }, replyTo: "new@example.com",
  to: ["recipient@example.org"], cc: [], bcc: ["hidden@example.org"], subject: "Hello",
  text: "Text & <markup>", html: "<div>Text &amp; &lt;markup&gt;</div>",
  headers: { "In-Reply-To": "<msg@example.org>", "X-Injected": "1", References: "<a>\r\nBcc: evil@example.net" },
  attachments: [{ filename: "a.txt", type: "text/plain", content: new TextEncoder().encode("one").buffer }],
};

let captured = null;
const ok = new CloudflareApiTransport(accountId, secret, async (url, init) => {
  captured = { url, init };
  return Response.json({ success: true, result: { delivered: ["recipient@example.org"], queued: [], permanent_bounces: [] } });
});
assert.deepEqual(await ok.send(message), { providerMessageId: null });
assert.equal(captured.url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`);
assert.equal(captured.init.headers.Authorization, `Bearer ${secret}`);
const payload = JSON.parse(captured.init.body);
assert.deepEqual(payload.from, { address: "new@example.com", name: "New Mailbox" });
assert.equal(payload.reply_to, "new@example.com");
assert.deepEqual(payload.bcc, ["hidden@example.org"]);
assert.equal(payload.cc, undefined, "empty cc is omitted");
assert.equal(payload.attachments[0].content, "b25l");
assert.deepEqual(payload.headers, { "In-Reply-To": "<msg@example.org>" }, "only clean threading headers pass");

const failing = code => new CloudflareApiTransport(accountId, secret, async () =>
  Response.json({ success: false, errors: [{ code }] }, { status: 403 }));
await assert.rejects(failing(10105).send(message), error => error.code === "E_EMAIL_SERVICE_NOT_ENTITLED");
await assert.rejects(failing(10101).send(message), error => error.code === "E_EMAIL_API_AUTH_FAILED");
await assert.rejects(failing(99999).send(message), error => error.code === "E_DELIVERY_FAILED");
await assert.rejects(new CloudflareApiTransport(accountId, "", async () => Response.json({})).send(message),
  error => error.code === "E_EMAIL_API_NOT_CONFIGURED");
await assert.rejects(new CloudflareApiTransport("not-an-account", secret, async () => Response.json({})).send(message),
  error => error.code === "E_EMAIL_API_NOT_CONFIGURED");
const bounced = new CloudflareApiTransport(accountId, secret, async () =>
  Response.json({ success: true, result: { delivered: [], queued: [], permanent_bounces: ["recipient@example.org"] } }));
await assert.rejects(bounced.send(message), error => error.code === "E_DELIVERY_FAILED", "a 200 with only bounces is a failure");
const offline = new CloudflareApiTransport(accountId, secret, async () => { throw new TypeError("network"); });
await assert.rejects(offline.send(message), error => error.code === "E_EMAIL_DELIVERY_UNKNOWN" && error.uncertain === true);
const huge = { ...message, attachments: [{ filename: "big.bin", type: "application/octet-stream", content: new ArrayBuffer(MAX_API_MESSAGE_BYTES) }] };
await assert.rejects(ok.send(huge), error => error.code === "E_CONTENT_TOO_LARGE");
for (const code of [10001, 10004, 10101, 10102, 10103, 10105, 10200, 10203, 1, "x", undefined]) {
  assert.ok(SAFE_DELIVERY_CODES.has(mapCloudflareApiError(code)), String(code));
}
assert.equal(cloudflareApiPayload({ ...message, headers: undefined }).headers, undefined);

// No send_email bindings remain; the account ID is the only rendered var.
const template = readFileSync(new URL("../wrangler.template.jsonc", import.meta.url), "utf8");
assert.doesNotMatch(template, /send_email/);
const native = readFileSync(new URL("../src/worker/providers/native.ts", import.meta.url), "utf8");
assert.doesNotMatch(native, /env\.EMAIL\b|EMAIL_DYNAMIC|EMAIL_MULTI/);

console.log("PASS: Cloudflare Email Sending API transport, payload, errors and no send bindings");
