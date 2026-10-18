import assert from "node:assert/strict";
import { evaluateDns } from "../src/worker/domainDns.ts";

const empty = { mx: [], rootTxt: [], dmarcTxt: [], dkim: {}, sendSubdomainTxt: [], sendSubdomainMx: [] };
const status = (report, id) => report.checks.find(check => check.id === id)?.status;

// Nothing configured: cannot activate, MX and SPF fail.
let report = evaluateDns(empty, "cloudflare", new Date("2026-10-17T00:00:00Z"));
assert.equal(report.canActivate, false);
assert.equal(status(report, "mx"), "fail");
assert.equal(status(report, "spf"), "fail");
assert.equal(status(report, "dmarc"), "warn", "DMARC is advisory");
assert.equal(report.checkedAt, "2026-10-17T00:00:00.000Z");

// Cloudflare Email Routing configured correctly.
const cloudflare = {
  ...empty,
  mx: ["13 route1.mx.cloudflare.net.", "86 route2.mx.cloudflare.net.", "24 route3.mx.cloudflare.net."],
  rootTxt: ["\"v=spf1 include:_spf.mx.cloudflare.net ~all\"", "\"google-site-verification=x\""],
  dmarcTxt: ["\"v=DMARC1; p=quarantine\""],
  dkim: { "cf2024-1": ["\"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\""] },
};
report = evaluateDns(cloudflare, "cloudflare");
assert.equal(report.canActivate, true);
assert.deepEqual(report.checks.map(check => check.status), ["pass", "pass", "pass", "pass"]);

// Competing MX hosts are flagged but do not block activation.
report = evaluateDns({ ...cloudflare, mx: [...cloudflare.mx, "10 mail.other-host.test."] }, "cloudflare");
assert.equal(report.canActivate, true);
assert.equal(status(report, "mx-extra"), "warn");

// MX elsewhere blocks activation.
report = evaluateDns({ ...cloudflare, mx: ["10 aspmx.l.google.com."] }, "cloudflare");
assert.equal(report.canActivate, false);
assert.match(report.checks[0].detail, /aspmx\.l\.google\.com/);

// Two SPF records are invalid; SPF without the Cloudflare include warns.
assert.equal(status(evaluateDns({ ...cloudflare, rootTxt: ["v=spf1 -all", "v=spf1 ~all"] }, "cloudflare"), "spf"), "fail");
assert.equal(status(evaluateDns({ ...cloudflare, rootTxt: ["v=spf1 include:example.net ~all"] }, "cloudflare"), "spf"), "warn");
// Split TXT strings are joined.
assert.equal(status(evaluateDns({ ...cloudflare, rootTxt: ["\"v=spf1 include:_spf.mx.\" \"cloudflare.net ~all\""] }, "cloudflare"), "spf"), "pass");

// Resend requires the send-subdomain SPF and checks its own DKIM selector.
report = evaluateDns({ ...cloudflare, rootTxt: ["v=spf1 include:_spf.mx.cloudflare.net ~all"] }, "resend");
assert.equal(status(report, "resend-spf"), "fail");
assert.equal(status(report, "dkim"), "warn", "Cloudflare DKIM does not satisfy Resend");
report = evaluateDns({
  ...cloudflare,
  sendSubdomainTxt: ["\"v=spf1 include:amazonses.com ~all\""],
  sendSubdomainMx: ["10 feedback-smtp.us-east-1.amazonses.com."],
  dkim: { resend: ["p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ"] },
}, "resend");
assert.equal(status(report, "resend-spf"), "pass");
assert.equal(status(report, "resend-mx"), "pass");
assert.equal(status(report, "dkim"), "pass");

// Receive-only domains skip DKIM and only warn on SPF.
report = evaluateDns({ ...cloudflare, rootTxt: [] }, "none");
assert.equal(status(report, "dkim"), undefined);
assert.equal(status(report, "spf"), "warn");
assert.equal(report.canActivate, true);

console.log("PASS: domain DNS evaluation for Cloudflare, Resend and receive-only domains");
