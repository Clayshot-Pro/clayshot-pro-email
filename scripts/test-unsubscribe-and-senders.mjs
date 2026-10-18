import assert from "node:assert/strict";
import { listUnsubscribeUrl, messageUnsubscribeUrl } from "../src/worker/email/unsubscribe.ts";
import { selectTransport } from "../src/worker/transports/select.ts";

assert.equal(listUnsubscribeUrl("<https://list.example.com/u?id=12>, <mailto:remove@example.com>"), "https://list.example.com/u?id=12");
assert.equal(listUnsubscribeUrl("<mailto:unsubscribe@example.com?subject=stop>"), "mailto:unsubscribe@example.com?subject=stop");
assert.equal(listUnsubscribeUrl("<mailto:unsubscribe@example.com>, <https://list.example.com/stop>"), "https://list.example.com/stop");
assert.equal(listUnsubscribeUrl("<javascript:alert(1)>"), null);
assert.equal(listUnsubscribeUrl("<http://example.com/unsubscribe>"), null);
assert.equal(listUnsubscribeUrl("<https://127.0.0.1/admin>"), null);
assert.equal(listUnsubscribeUrl("<https://localhost/admin>"), null);
assert.equal(listUnsubscribeUrl(null), null);
assert.equal(
  messageUnsubscribeUrl('<p><a href="https://list.example.com/unsubscribe?id=7&amp;email=a">Unsubscribe</a></p>', ""),
  "https://list.example.com/unsubscribe?id=7&email=a",
);
assert.equal(
  messageUnsubscribeUrl('<p>To unsubscribe, <a href="https://list.example.com/off">click here</a>.</p>', ""),
  "https://list.example.com/off",
);
assert.equal(
  messageUnsubscribeUrl('<a href="javascript:alert(1)">Unsubscribe</a>', ""), null,
);
assert.equal(
  messageUnsubscribeUrl('<a href="http://list.example.com/remove">Unsubscribe</a>', ""), null,
);
assert.equal(
  messageUnsubscribeUrl('<a href="https://example.com/pay">View invoice</a>', ""), null,
);
assert.equal(
  messageUnsubscribeUrl("", "To unsubscribe from emails:\\nhttps://list.example.com/remove?ref=1"),
  "https://list.example.com/remove?ref=1",
);
assert.equal(
  messageUnsubscribeUrl("", "Unsubscribe: mailto:remove@example.com?subject=unsubscribe"),
  "mailto:remove@example.com?subject=unsubscribe",
);
assert.equal(messageUnsubscribeUrl(null, "This message has no unsubscribe instructions."), null);

// Sender authorization: every active mailbox on an active domain may send
// through the Cloudflare Email Sending API (no per-address bindings or gate).
const select = input => selectTransport({ domainStatus: "active", domainTransport: "cloudflare", emailApiConfigured: true, resendConfigured: false, ...input });
assert.deepEqual(select({}), { kind: "cloudflare" });
assert.equal(select({ emailApiConfigured: false }).kind, "unavailable");
assert.equal(select({ domainStatus: null }).kind, "unavailable", "addresses on unknown domains never send");
assert.equal(select({ domainStatus: "disabled" }).kind, "unavailable");
console.log("Unsubscribe and automatic native sending regressions: passed (API transport covered by test-cloudflare-api)");
