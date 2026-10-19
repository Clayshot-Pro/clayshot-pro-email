import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aliasTarget, normalizeMailboxAddress as normalize } from "../src/worker/mailboxRules.ts";
import { junkVerdict } from "../src/worker/email/junk.ts";
const suspectedJunk = (subject, sender, text) => junkVerdict({ subject, sender, text }).junk;
import { adminPasswordError, mailboxPasswordError } from "../src/worker/mailboxPasswordPolicy.ts";

const single = { domains: new Set(["example.com"]), defaultDomain: "example.com", adminAddress: "owner@example.com" };
const normalizeMailboxAddress = (value, allowReserved = false) => normalize(value, single, allowReserved);
assert.equal(normalizeMailboxAddress(" Personal@EXAMPLE.COM "), "personal@example.com");
assert.equal(normalizeMailboxAddress("work"), "work@example.com");
assert.equal(normalizeMailboxAddress("work+receipts@example.com"), "work+receipts@example.com");
assert.equal(normalizeMailboxAddress("Admin@example.com"), null, "admin identity is reserved for MFA");
assert.equal(normalizeMailboxAddress("owner@example.com"), null, "the configured admin address is never a mailbox");
assert.equal(normalizeMailboxAddress("postmaster@example.com", true), "postmaster@example.com");
assert.equal(normalizeMailboxAddress("abuse@example.com", true), "abuse@example.com");
for (const invalid of ["", "other@gmail.com", "account@example.com.evil", "../test", "x..y", "postmaster", "abuse", "@example.com", "a@b@example.com"]) {
  assert.equal(normalizeMailboxAddress(invalid), null, invalid);
}

// Multi-domain rules: same-domain aliases only, admin local part reserved everywhere.
const multi = { domains: new Set(["example.com", "example.org"]), defaultDomain: "example.com", adminAddress: "admin@example.com" };
assert.equal(normalize("me@Example.ORG", multi), "me@example.org");
assert.equal(normalize("me", multi), "me@example.com", "bare local parts use the primary domain");
assert.equal(normalize("me@example.net", multi), null, "unknown domains are rejected");
assert.equal(normalize("admin@example.org", multi), null, "admin is reserved on every domain");
assert.equal(normalize("me@exämple.org", multi), null, "raw IDN input is rejected");
assert.deepEqual(aliasTarget("a+x@example.org"), { kind: "plus", parent: "a@example.org" });
assert.notEqual(aliasTarget("a+x@example.org")?.parent, "a@example.com", "plus aliases never cross domains");
assert.deepEqual(aliasTarget("postmaster@example.org"), { kind: "postmaster", domain: "example.org" });
assert.deepEqual(aliasTarget("abuse@example.com"), { kind: "postmaster", domain: "example.com" });
assert.equal(aliasTarget("plain@example.com"), null);
assert.equal(aliasTarget("+x@example.com"), null);
assert.equal(suspectedJunk("Upcoming meeting notes", "noreply@university.ca", "Agenda attached"), false);
assert.equal(suspectedJunk("Lottery winner!!!", "unknown@contest.test", "Click here to claim"), true);
assert.equal(suspectedJunk("Urgent schedule change", "professor@university.ca", "Please see the course schedule"), false);
console.log("PASS: address normalization and conservative Junk classification");

assert.equal(mailboxPasswordError("correct-horse-battery-2026"),null);
assert.equal(mailboxPasswordError("Ab1!"), null);
assert.match(mailboxPasswordError("Ab!") ?? "", /at least 4/);
assert.match(mailboxPasswordError("X".repeat(33)) ?? "", /at most 32/);
assert.match(mailboxPasswordError("z".repeat(20))??"",/repetitive/);
assert.match(mailboxPasswordError("password-with-newline"+String.fromCharCode(10)+"2026")??"",/control/);
console.log("PASS: admin login address reserved and custom password policy validated");

assert.equal(adminPasswordError("Abcd?789"),null);
assert.equal(adminPasswordError("Ab1!"), null);
assert.match(adminPasswordError("Ab!") ?? "", /at least 4/);
assert.match(adminPasswordError("X".repeat(33))??"",/at most 32/);

const source = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
assert.match(source("src/worker/mailboxes.ts"), /crypto\.getRandomValues\(new Uint8Array\(24\)\)/);
assert.match(source("src/worker/deviceAuth.ts"), /rotateMailboxPassword[\s\S]*?new Uint8Array\(24\)/);
console.log("PASS: generated mailbox passwords remain within 4–32 characters");
