import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { eventEffect, shouldReplaceStatus, suppressionTargets, verifySvix } from "../src/worker/webhooks/resendEvents.ts";

const keyBytes = Buffer.from("resend-webhook-test-key-32-bytes!");
const secret = `whsec_${keyBytes.toString("base64")}`;
const now = 1_790_000_000;
const sign = (id, timestamp, body, key = keyBytes) =>
  `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
const body = JSON.stringify({ type: "email.delivered", data: { email_id: "email_1", to: ["b@example.net"] } });
const headers = { id: "msg_1", timestamp: String(now), signature: sign("msg_1", now, body) };

assert.equal(await verifySvix(secret, headers, body, now), true, "valid signature");
assert.equal(await verifySvix(secret, { ...headers, signature: `v1,bogus ${headers.signature}` }, body, now), true, "any listed v1 signature may match");
assert.equal(await verifySvix(secret, headers, body + " ", now), false, "tampered body");
assert.equal(await verifySvix(secret, { ...headers, id: "msg_2" }, body, now), false, "id is part of the signed content");
assert.equal(await verifySvix(`whsec_${Buffer.from("other-key").toString("base64")}`, headers, body, now), false, "wrong secret");
assert.equal(await verifySvix(secret, headers, body, now + 301), false, "stale timestamp");
assert.equal(await verifySvix(secret, headers, body, now - 301), false, "future timestamp");
assert.equal(await verifySvix(secret, { ...headers, signature: headers.signature.replace("v1,", "v2,") }, body, now), false, "unknown version");
assert.equal(await verifySvix(secret, { ...headers, signature: null }, body, now), false, "missing signature");
assert.equal(await verifySvix("", headers, body, now), false, "no secret configured");
assert.equal(await verifySvix("whsec_!!!not-base64", headers, body, now), false, "malformed secret");

// Event interpretation.
assert.deepEqual(eventEffect({ type: "email.delivered" }), { status: "delivered", suppress: null });
assert.deepEqual(eventEffect({ type: "email.delivery_delayed" }), { status: "delayed", suppress: null });
assert.deepEqual(eventEffect({ type: "email.bounced", data: { bounce: { type: "Permanent" } } }), { status: "bounced", suppress: "hard_bounce" });
assert.deepEqual(eventEffect({ type: "email.bounced", data: { bounce: { type: "Transient" } } }), { status: "bounced", suppress: null });
assert.deepEqual(eventEffect({ type: "email.complained" }), { status: "complained", suppress: "complaint" });
assert.equal(eventEffect({ type: "email.opened" }), null, "unknown events are ignored");
assert.equal(eventEffect({ type: { toString: () => "email.delivered" } }), null);

// Status never regresses.
assert.equal(shouldReplaceStatus("sent", "delivered"), true);
assert.equal(shouldReplaceStatus("delayed", "delivered"), true);
assert.equal(shouldReplaceStatus("delivered", "delayed"), false);
assert.equal(shouldReplaceStatus("complained", "delivered"), false);
assert.equal(shouldReplaceStatus(null, "bounced"), true);

// Suppression only targets a single, well-formed recipient.
assert.deepEqual(suppressionTargets({ data: { to: ["B@Example.net"] } }), ["b@example.net"]);
assert.deepEqual(suppressionTargets({ data: { to: ["Bob <bob@example.net>"] } }), ["bob@example.net"]);
assert.deepEqual(suppressionTargets({ data: { to: ["a@example.net", "b@example.net"] } }), [], "ambiguous multi-recipient events");
assert.deepEqual(suppressionTargets({ data: { to: ["not an address"] } }), []);
assert.deepEqual(suppressionTargets({ data: { to: "b@example.net" } }), []);

// The webhook is the only same-origin exemption, and it sits before the check.
const router = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
const webhook = router.indexOf('if (url.pathname === "/api/webhooks/resend" && request.method === "POST")');
assert.ok(webhook > 0 && webhook < router.indexOf("if (!sameOrigin(request, config.origin))"));
assert.equal((router.match(/\/api\/webhooks\//g) ?? []).length, 1, "no other webhook routes bypass the origin check");
const handler = readFileSync(new URL("../src/worker/webhooks/resend.ts", import.meta.url), "utf8");
assert.match(handler, /INSERT OR IGNORE INTO webhook_receipts/, "replayed events are deduplicated");
assert.ok(handler.indexOf("verifySvix(") < handler.indexOf("INSERT OR IGNORE INTO webhook_receipts"), "verify before any write");

console.log("PASS: Resend webhook signatures, replay handling, event mapping and suppression targets");
