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
  ["POST","/api/admin/domains"], ["PATCH","/api/admin/domains/example.org"], ["DELETE","/api/admin/domains/example.org"],
  ["POST","/api/admin/suppressions"], ["DELETE","/api/admin/suppressions/someone%40example.net"],
  ["PUT","/api/admin/keys/RESEND_API_KEY"], ["DELETE","/api/admin/keys/GOOGLE_CLIENT_SECRET"],
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
assert.equal(adminMutationEvent("POST","/api/admin/domains"),"admin.domain.created");
assert.equal(adminMutationEvent("PATCH","/api/admin/domains/example.org"),"admin.domain.updated");
assert.equal(adminMutationEvent("DELETE","/api/admin/domains/example.org"),"admin.domain.deleted");
assert.equal(adminMutationNeedsStepUp("GET","/api/admin/domains/example.org/dns"),false,"DNS checks are read-only lookups");
assert.equal(isApprovedAdminMutation("POST","/api/admin/domains/example.org/dns"),false);
assert.equal(adminMutationEvent("PUT","/api/admin/keys/RESEND_API_KEY"),"admin.key.updated");
assert.equal(adminMutationEvent("DELETE","/api/admin/keys/RESEND_API_KEY"),"admin.key.removed");
assert.equal(adminMutationNeedsStepUp("GET","/api/admin/keys"),false,"listing keys returns no values");
assert.equal(isApprovedAdminMutation("POST","/api/admin/keys/RESEND_API_KEY"),false);
// v3.12: the Cloudflare connection and automatic domain wiring need a fresh passkey too.
for (const [method, path] of [["PUT","/api/admin/cloudflare"],["DELETE","/api/admin/cloudflare"],["POST","/api/admin/domains/example.org/connect"]]) {
  assert.equal(adminMutationNeedsStepUp(method,path),true,path);
  assert.equal(isApprovedAdminMutation(method,path),true,path);
}
assert.equal(isApprovedAdminMutation("POST","/api/admin/cloudflare"),false);
assert.equal(isApprovedAdminMutation("POST","/api/admin/domains/a/b/connect"),false);
assert.equal(isApprovedAdminMutation("PUT","/api/admin/keys/resend_api_key/../x"),false);

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
assert.ok(stepUp.includes("expectedOrigin: appOrigin(request)"));
assert.ok(stepUp.includes("expectedRPID: passkeyRpId(request)"));
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
