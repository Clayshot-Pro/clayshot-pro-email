import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { d1, migratedDatabase } from "./test-harness.mjs";
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
assert.ok(webhook > 0 && webhook < router.indexOf("if (!sameOrigin(request))"));
assert.equal((router.match(/\/api\/webhooks\//g) ?? []).length, 1, "no other webhook routes bypass the origin check");
const handler = readFileSync(new URL("../src/worker/webhooks/resend.ts", import.meta.url), "utf8");
assert.match(handler, /INSERT OR IGNORE INTO webhook_receipts/, "replayed events are deduplicated");
assert.ok(handler.indexOf("verifySvix(") < handler.indexOf("INSERT OR IGNORE INTO webhook_receipts"), "verify before any write");
assert.ok(handler.indexOf("verifySvix(") < handler.indexOf("env.DB"), "verify before any database access");
assert.ok(handler.indexOf("checkAuthRateLimit(") > handler.indexOf("verifySvix("),
  "verified events are never throttled; only failed verifications are rate limited");
assert.match(handler, /authRateLimitBucket\(request, "webhook:resend:invalid"\)/, "the limit is per source IP, not global");

// An event is recorded as processed only together with its effects: when storing them
// fails, Resend's retry is processed again instead of being dropped as a duplicate.
{
  const out = mkdtempSync(join(tmpdir(), "ltm-resend-"));
  try {
    const entry = join(out, "entry.ts");
    writeFileSync(entry, `export { resendWebhook } from "${new URL("../src/worker/webhooks/resend.ts", import.meta.url).pathname}";`);
    await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"],
      outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
    const { resendWebhook } = await import(pathToFileURL(join(out, "bundle.mjs")).href);
    const db = migratedDatabase();
    const real = d1(db);
    let failNextBatch = true;
    const flaky = { ...real, batch: async list => {
      if (failNextBatch) { failNextBatch = false; throw new Error("D1_ERROR: network connection lost"); }
      return real.batch(list);
    } };
    const env = { DB: flaky, RESEND_WEBHOOK_SECRET: secret };
    const bounce = JSON.stringify({ type: "email.bounced", data: { email_id: "re_1", to: ["gone@partner.test"], bounce: { type: "Permanent" } } });
    const deliver = () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      return resendWebhook(new Request("https://mail.example.org/api/webhooks/resend", { method: "POST", body: bounce,
        headers: { "svix-id": "msg_bounce", "svix-timestamp": timestamp, "svix-signature": sign("msg_bounce", timestamp, bounce) } }), env);
    };
    await assert.rejects(deliver(), /network/, "the first delivery fails (Resend gets a 500)");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM webhook_receipts").get().n, 0, "a failed event is not recorded as processed");
    const retry = await deliver();
    assert.deepEqual(await retry.json(), { ok: true }, "the retry is processed, not dropped as a duplicate");
    assert.deepEqual(db.prepare("SELECT address, reason FROM suppressed_recipients").all().map(row => ({ ...row })), [{ address: "gone@partner.test", reason: "hard_bounce" }]);
    assert.deepEqual(await (await deliver()).json(), { ok: true, duplicate: true }, "a replay after success is a duplicate");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

console.log("PASS: Resend webhook signatures, replay handling, event mapping and suppression targets");
