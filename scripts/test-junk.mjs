// v3.10 junk filter: spam and phishing land in Junk; ordinary mail does not.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JUNK_SCORE, junkVerdict, suspectedJunk, trustedResult } from "../src/worker/email/junk.ts";

const headers = values => ({ get: name => values[name.toLowerCase()] ?? null });
const verdict = input => junkVerdict({ subject: "", sender: "someone@example.com", text: "", ...input });

const spam = {
  "lottery": { subject: "Lottery winner!!!", text: "Click here to claim your prize." },
  "phishing with an IP link": { subject: "Your account has been suspended", sender: "alert@secure-login-help.net",
    text: "Dear customer, unusual activity was detected. Verify your account now: http://185.23.44.10/login" },
  "brand impersonation": { subject: "Action required: payment declined", sender: "billing@mail-updates.xyz", senderName: "PayPal Support",
    text: "Your payment card is limited. Click here to update your details." },
  "advance-fee": { subject: "Urgent business proposal", text: "I am the next of kin of a deceased client with 4.5 million dollars. Reply with your bank details." },
  "crypto bait": { subject: "BITCOIN INVESTMENT WITH GUARANTEED RETURNS", text: "Double your money in 24 hours.", replyTo: "agent@other.biz" },
  "gift cards": { subject: "Quick favour", text: "Please send me 5 gift cards today and scratch the codes. Dear friend, it is urgent.", replyTo: "ceo.office@freemail.example" },
};
for (const [name, input] of Object.entries(spam)) assert.equal(verdict(input).junk, true, `${name} is junk (score ${verdict(input).score})`);

const ham = {
  "meeting notes": { subject: "Upcoming meeting notes", sender: "noreply@university.ca", text: "Agenda attached" },
  "urgent from a colleague": { subject: "Urgent schedule change", sender: "professor@university.ca", text: "Please see the course schedule" },
  "shop newsletter": { subject: "Limited time: 20% off everything!!!", sender: "news@shop.example", senderName: "Example Shop",
    text: "Our autumn sale ends Sunday. Shop now: https://bit.ly/abc" },
  "real security notice": { subject: "New sign-in to your account", sender: "no-reply@accounts.google.com", senderName: "Google",
    text: "We noticed a new sign-in to your Google Account on a Mac device. If this was you, you don't need to do anything." },
  "receipt": { subject: "Your Amazon.com order #112-334", sender: "auto-confirm@amazon.com", senderName: "Amazon.com", text: "Thanks for your order. Arriving Tuesday." },
  "password reset you asked for": { subject: "Reset your password", sender: "support@github.com", text: "Click the link below to reset your password. If you did not request this, ignore this email." },
};
for (const [name, input] of Object.entries(ham)) assert.equal(verdict(input).junk, false, `${name} stays out of Junk (score ${verdict(input).score}: ${verdict(input).reasons.join(", ")})`);

// Upstream flags and failed authentication are decisive.
assert.equal(verdict({ headers: headers({ "x-spam-flag": "YES" }) }).junk, true);
assert.equal(verdict({ headers: headers({ "x-spam-status": "Yes, score=7.1" }) }).junk, true);
assert.equal(verdict({ headers: headers({ "x-spam-status": "No, score=0.2" }) }).junk, false);
assert.equal(verdict({ headers: headers({ "authentication-results": "mx.cloudflare.net; dmarc=fail header.from=bank.com" }) }).junk, true);
assert.equal(verdict({ headers: headers({ "authentication-results": "spf=fail smtp.mailfrom=x.com; dkim=none" }) }).junk, true);
assert.equal(verdict({ headers: headers({ "authentication-results": "spf=fail smtp.mailfrom=x.com; dkim=pass header.d=x.com" }) }).junk, false,
  "forwarded mail with a valid DKIM signature is fine");
assert.equal(verdict({ headers: headers({ "authentication-results": "mx.cloudflare.net; arc=pass; dmarc=fail", "list-id": "<news.lists.example.org>" }) }).junk, false,
  "mailing lists with a validated ARC chain break DMARC alignment legitimately");
assert.equal(verdict({ headers: headers({ "authentication-results": "dkim=pass header.d=attacker.test; dmarc=fail", "list-id": "<x.attacker.test>" }) }).junk, true,
  "the attacker's own DKIM signature plus a List-Id does not excuse a DMARC failure");
assert.equal(verdict({ headers: headers({ "authentication-results": "dmarc=fail", "list-id": "<forged>" }) }).junk, true,
  "a List-Id header alone does not excuse a DMARC failure");
assert.equal(verdict({ headers: headers({ "authentication-results": "spf=pass; dkim=pass; dmarc=pass" }) }).junk, false);

// Senders the mailbox has written to skip content scoring when authenticated, never spoofing checks.
const pass = headers({ "authentication-results": "mx.cloudflare.net; dkim=pass header.d=example.com; dmarc=pass" });
assert.equal(verdict({ ...spam.lottery, sender: "friend@example.com", knownSender: true, headers: pass }).junk, false);
assert.equal(verdict({ ...spam.lottery, sender: "friend@example.com", knownSender: true }).junk, true,
  "a forged From of a contact without authentication is still scored");
assert.equal(verdict({ ...spam.lottery, sender: "friend@example.com", knownSender: true,
  headers: headers({ "authentication-results": "dkim=pass header.d=example.com" }) }).junk, false, "aligned DKIM counts");
assert.equal(verdict({ ...spam.lottery, sender: "friend@example.com", knownSender: true,
  headers: headers({ "authentication-results": "dkim=pass header.d=mail.example.com" }) }).junk, false, "a subdomain signature is aligned");
assert.equal(verdict({ ...spam.lottery, sender: "friend@example.com", knownSender: true,
  headers: headers({ "authentication-results": "dkim=pass header.d=attacker.test" }) }).junk, true, "unaligned DKIM does not");
assert.equal(verdict({ ...spam.lottery, sender: "friend@bank.co.uk", knownSender: true,
  headers: headers({ "authentication-results": "dkim=pass header.d=attacker.co.uk" }) }).junk, true, "a sibling under a public suffix is not aligned");
assert.equal(verdict({ ...spam.lottery, sender: "friend@mail.example.com", knownSender: true,
  headers: headers({ "authentication-results": "dkim=pass header.d=example.com" }) }).junk, false, "a parent-domain signature is aligned");

// Only the receiving server's result is trusted; forged results sit below it.
const ar = (value, key = "authentication-results") => ({ key, value });
assert.equal(trustedResult([ar("mx.cloudflare.net; spf=fail; dkim=none"), ar("evil.test; dkim=pass")]), "mx.cloudflare.net; spf=fail; dkim=none");
assert.equal(trustedResult([ar("relay.example; dkim=pass"), ar("i=1; mx.cloudflare.net; dkim=fail", "arc-authentication-results")]),
  "i=1; mx.cloudflare.net; dkim=fail", "the Cloudflare ARC result wins over an unlabelled one");
assert.equal(trustedResult([ar("first.example; dmarc=fail"), ar("second.example; dmarc=pass")]), "first.example; dmarc=fail", "otherwise the topmost");
assert.equal(trustedResult([ar("i=1; mx.cloudflare.net; dmarc=fail", "arc-authentication-results"), ar("mx.cloudflare.net; dmarc=pass")]),
  "i=1; mx.cloudflare.net; dmarc=fail", "a forged plain Cloudflare result below the real ARC one loses");
assert.equal(trustedResult([]), "");
const forged = verdict({ headers: headers({ "authentication-results": "ignored" }),
  authenticationHeaders: [ar("mx.cloudflare.net; spf=fail smtp.mailfrom=x.com; dkim=none"), ar("mx.cloudflare.net; dkim=pass")] });
assert.equal(forged.junk, true, "a forged dkim=pass below the real result does not rescue an SPF failure");
assert.equal(verdict({ knownSender: true, headers: headers({ "authentication-results": "dmarc=fail" }) }).junk, true);
assert.equal(verdict(spam.lottery).score >= JUNK_SCORE, true);

// Compatibility wrapper used before v3.10.
assert.equal(suspectedJunk("Lottery winner!!!", "unknown@contest.test", "Click here to claim"), true);

// Inbound wiring: blocked senders first, then the verdict with headers and contacts.
const receive = readFileSync(new URL("../src/worker/email/receive.ts", import.meta.url), "utf8");
assert.match(receive, /mailbox\.spam_filter_enabled === 1 && junkVerdict\(\{/);
assert.match(receive, /headers: message\.headers/);
assert.match(receive, /authenticationHeaders: parsed\.headers\.filter/);
assert.match(receive, /knownSender: await hasWrittenTo\(env, mailbox\.id, fromAddress\)/);
const migration = readFileSync(new URL("../migrations/0022_photos_and_junk_filter.sql", import.meta.url), "utf8");
assert.match(migration, /UPDATE native_mailboxes SET spam_filter_enabled = 1;/, "the filter is on for existing mailboxes");
assert.match(readFileSync(new URL("../src/worker/mailboxes.ts", import.meta.url), "utf8"), /spam_filter_enabled\) VALUES \(\?1,\?2,\?3,\?4,1\)/, "and for new ones");

console.log(`PASS: junk filter flags ${Object.keys(spam).length} spam samples and passes ${Object.keys(ham).length} ordinary ones`);
