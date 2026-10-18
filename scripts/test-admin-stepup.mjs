import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { adminMutationNeedsStepUp, isApprovedAdminMutation, hashMutationBody } from "../src/worker/adminStepUpPolicy.ts";
import { adminMutationEvent } from "../src/worker/adminSecurityAudit.ts";

for (const [method, path] of [
  ["POST","/api/admin/password"], ["POST","/api/mailboxes"],
  ["PATCH","/api/mailboxes/native%3Aexample"], ["DELETE","/api/mailboxes/native%3Aexample"],
  ["POST","/api/mailboxes/native%3Aexample/reset-password"],
  ["POST","/api/mailboxes/native%3Aexample/restore"],
  ["POST","/api/mailboxes/native%3Aexample/purge"],
  ["POST","/api/mailboxes/native%3Aexample/reconcile"],
  ["POST","/api/auth/sessions/reset"], ["DELETE","/api/auth/sessions/example"],
]) {
  assert.equal(adminMutationNeedsStepUp(method,path),true,path);
  assert.equal(isApprovedAdminMutation(method,path),true,path);
}
for (const path of ["/api/mailboxes/new-future-action", "/api/admin/future-action"]) {
  assert.equal(adminMutationNeedsStepUp("POST",path),true,
    "Future administrator writes must fail closed until expressly added");
  assert.equal(isApprovedAdminMutation("POST",path),false);
}
for (const path of ["/api/admin/step-up/options","/api/admin/step-up/verify","/api/admin/login/password"]) {
  assert.equal(adminMutationNeedsStepUp("POST",path),false);
}
assert.equal(adminMutationNeedsStepUp("GET","/api/mailboxes"),false);
assert.equal(adminMutationEvent("POST","/api/mailboxes"),"admin.mailbox.created");
assert.equal(adminMutationEvent("POST","/api/mailboxes/id/purge"),"admin.mailbox.purged");
assert.equal(adminMutationEvent("POST","/api/admin/password"),"admin.password.changed");

const emptyHash = await hashMutationBody(new Request("https://example.com", {method:"POST"}));
assert.equal(emptyHash,"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
const body = JSON.stringify({status:"disabled"});
const bodyHash = await hashMutationBody(new Request("https://example.com", {method:"POST",body}));
const alteredHash = await hashMutationBody(new Request("https://example.com", {method:"POST",body:body+" "}));
assert.notEqual(bodyHash,alteredHash,"Approval must bind to exact payload bytes");
assert.equal(await hashMutationBody(new Request("https://example.com", {
  method:"POST",body:"a".repeat(65537),
})),null,"Oversized administrative payloads must be rejected");

const worker=readFileSync(new URL("../src/worker/index.ts",import.meta.url),"utf8");
const stepUp=readFileSync(new URL("../src/worker/adminStepUp.ts",import.meta.url),"utf8");
const panel=readFileSync(new URL("../src/client/components/AdminPanel.tsx",import.meta.url),"utf8");
const manager=readFileSync(new URL("../src/client/components/MailboxManager.tsx",import.meta.url),"utf8");
assert.match(worker,/await consumeAdminApproval\(request, env\)/,"Server must enforce the one-time approval");
assert.match(worker,/if \(adminMutationNeedsStepUp\(request.method, url.pathname\)\)/);
assert.match(worker,/listAdminSecurityEvents\(env\)/);
assert.match(stepUp,/verifyAuthenticationResponse\(/);
assert.match(stepUp,/expectedOrigin: appConfig\(env\)\.origin/);
assert.match(stepUp,/expectedRPID: appConfig\(env\)\.rpId/);
assert.match(stepUp,/requireUserVerification: true/);
assert.match(stepUp,/DELETE FROM admin_stepup_challenges/);
assert.match(stepUp,/AND uses<max_uses/);
assert.match(stepUp,/AND session_hash=\?2/);
assert.match(stepUp,/AND body_hash=\?5/);
assert.match(panel,/adminActionFetch\("\/api\/admin\/password"/);
assert.match(manager,/approveAdminAction\(path, "POST"\)/);
assert.match(manager,/adminActionFetch\(path, method, payload, approval\)/);
const migration=readFileSync(new URL("../migrations/0015_admin_stepup_audit.sql",import.meta.url),"utf8");
for (const table of ["admin_stepup_challenges","admin_stepup_approvals","admin_security_events"])
  assert.ok(migration.includes(table));
console.log("PASS: passkey action binding, route coverage, one-time approvals and audit migrations");
