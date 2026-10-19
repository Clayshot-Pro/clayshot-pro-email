import assert from "node:assert/strict";
import { formatSender, mapResendError, ResendTransport, resendPayload, toBase64 } from "../src/worker/transports/resend.ts";
import { SAFE_DELIVERY_CODES, TransportError } from "../src/worker/transports/types.ts";

// Error mapping only ever yields safe codes.
const cases = [
  [429, "rate_limit_exceeded", "E_RATE_LIMIT_EXCEEDED"],
  [409, "concurrent_idempotent_requests", "E_RATE_LIMIT_EXCEEDED"],
  [429, "daily_quota_exceeded", "E_RATE_LIMIT_EXCEEDED"],
  [400, "daily_quota_exceeded", "E_DAILY_LIMIT_EXCEEDED"],
  [400, "monthly_quota_exceeded", "E_DAILY_LIMIT_EXCEEDED"],
  [422, "invalid_from_address", "E_SENDER_DOMAIN_NOT_AVAILABLE"],
  [403, "validation_error", "E_SENDER_DOMAIN_NOT_AVAILABLE"],
  [413, undefined, "E_CONTENT_TOO_LARGE"],
  [500, "internal_server_error", "E_INTERNAL_SERVER_ERROR"],
  [502, "something_new", "E_INTERNAL_SERVER_ERROR"],
  [422, "validation_error", "E_DELIVERY_FAILED"],
  [400, "<script>alert(1)</script>", "E_DELIVERY_FAILED"],
  [401, { nested: true }, "E_DELIVERY_FAILED"],
];
for (const [status, name, expected] of cases) {
  const code = mapResendError(status, name);
  assert.equal(code, expected, `${status} ${String(name)}`);
  assert.ok(SAFE_DELIVERY_CODES.has(code));
}
assert.equal(new TransportError("raw provider text").code, "E_DELIVERY_FAILED", "unknown codes collapse to a safe one");

// Display names cannot break out of the quoted phrase.
assert.equal(formatSender("Alex", "a@example.com"), "\"Alex\" <a@example.com>");
assert.equal(formatSender("Evil\" <x@evil.test>\r\nBcc: y", "a@example.com"), "\"Evil x@evil.test Bcc: y\" <a@example.com>");
assert.equal(formatSender("", "a@example.com"), "a@example.com");

// Payload: only threading headers pass, attachments are base64.
const bytes = new TextEncoder().encode("hello attachment").buffer;
const payload = resendPayload({
  from: { email: "a@example.com", name: "Alex" }, replyTo: "a@example.com",
  to: ["b@example.net"], cc: [], bcc: ["c@example.net"], subject: "Hi", text: "Body", html: "<p>Body</p>",
  headers: { "In-Reply-To": "<x@y>", References: "<x@y>", "X-Injected": "1", "Bcc": "evil@example.net" },
  attachments: [{ filename: "a.txt", type: "text/plain", content: bytes }],
});
assert.deepEqual(payload.headers, { "In-Reply-To": "<x@y>", References: "<x@y>" });
assert.equal(payload.cc, undefined, "empty cc is omitted");
assert.deepEqual(payload.bcc, ["c@example.net"]);
assert.equal(payload.attachments[0].content, Buffer.from("hello attachment").toString("base64"));
assert.equal(toBase64(new Uint8Array(70000).fill(65).buffer), Buffer.alloc(70000, 65).toString("base64"), "large buffers are chunked");

// Transport behaviour with a fake fetch.
const message = { from: { email: "a@example.com", name: "Alex" }, replyTo: "a@example.com", to: ["b@example.net"], cc: [], bcc: [],
  subject: "Hi", text: "Body", html: "<p>Body</p>", attachments: [], idempotencyKey: "native:x:key-123456789012" };
let seen;
const ok = new ResendTransport("re_test", async (url, init) => {
  // The send, then a lookup of the Message-ID Resend gave it.
  if (init?.method !== "POST") return new Response(JSON.stringify({ id: "email_123", message_id: "<abc@mail.example.com>" }), { status: 200 });
  seen = { url, init };
  return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
});
assert.deepEqual(await ok.send(message), { providerMessageId: "email_123", messageIdHeader: "<abc@mail.example.com>" });
assert.equal(seen.url, "https://api.resend.com/emails");
assert.equal(seen.init.headers.Authorization, "Bearer re_test");
assert.equal(seen.init.headers["Idempotency-Key"], "native:x:key-123456789012");

const rejected = new ResendTransport("re_test", async () =>
  new Response(JSON.stringify({ name: "invalid_from_address", message: "secret internals" }), { status: 422 }));
await assert.rejects(rejected.send(message), error => error.code === "E_SENDER_DOMAIN_NOT_AVAILABLE" && !error.message.includes("secret"));

const offline = new ResendTransport("re_test", async () => { throw new TypeError("network down"); });
await assert.rejects(offline.send(message), error => error.code === "E_DELIVERY_UNCERTAIN" && error.uncertain === true,
  "a network failure after sending is uncertain, never retried automatically");

console.log("PASS: Resend payload, sender quoting, safe error mapping and uncertain sends");
