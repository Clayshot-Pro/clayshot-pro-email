import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { adminProtectedApiPath } from "../src/worker/adminRoutePolicy.ts";
import {
  readOwnerSessionToken, OWNER_SESSION_TTL_SECONDS, OWNER_IDLE_TTL_SECONDS,
} from "../src/worker/ownerSessionPolicy.ts";

const site = process.env.TEST_ORIGIN || "https://mail.example.com";
const owner = "a".repeat(43);
const request = cookie => new Request(site, { headers: { Cookie: cookie } });

assert.equal(readOwnerSessionToken(request("__Host-ltm_session=" + owner)), owner);
assert.equal(readOwnerSessionToken(request("x=1; __Host-ltm_session=" + owner)), owner);
for (const invalid of [
  "__Host-ltm_session=%ZZ",
  "__Host-ltm_session=" + "a".repeat(50000),
  "__Host-ltm_session=guest",
  "__Host-ltm_session=" + "a".repeat(42),
  "__Host-ltm_session=" + "a".repeat(44),
  "__Host-ltm_session=" + owner + "; __Host-ltm_session=" + owner,
]) {
  assert.equal(readOwnerSessionToken(request(invalid)), null, invalid.slice(0,80));
}
assert.equal(readOwnerSessionToken(request("ltm_session=" + owner)), null);
assert.ok(OWNER_SESSION_TTL_SECONDS <= 12 * 60 * 60);
assert.ok(OWNER_IDLE_TTL_SECONDS <= 60 * 60);

for (const path of [
  "/api/admin/status", "/api/admin/password", "/api/admin/new-endpoint",
  "/api/mailboxes", "/api/mailboxes/native%3Aprimary",
  "/api/mailboxes/native%3Aprimary/reset-password",
  "/api/mailboxes/native%3Aprimary/restore",
  "/api/mailboxes/native%3Aprimary/purge",
  "/api/auth/sessions", "/api/auth/sessions/example",
]) {
  assert.equal(adminProtectedApiPath(path), true, path + " must require owner passkey");
}
for (const path of [
  "/api/admin/login/password", "/api/device/login", "/api/device/status",
  "/api/messages", "/api/auth/login/options",
]) assert.equal(adminProtectedApiPath(path), false, path);

const source = readFileSync(new URL("../src/worker/auth.ts", import.meta.url), "utf8");
assert.match(source, /ownerIdleModifier/);
assert.match(source, /last_seen_at > datetime\('now', \?\)/,
  "Owner session queries must enforce idle expiration");
assert.match(source, /await verifyAuthenticationResponse\(/);
assert.match(source, /requireUserVerification: true/);
assert.match(source, /consumePendingAdmin\(/,
  "MFA pending token must be consumed, not merely read");
const router = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
const guard = 'if (adminProtectedApiPath(url.pathname) && !isAdmin)';
assert.ok(router.includes(guard), "route classification must be enforced at API boundary");
assert.ok(router.indexOf(guard) < router.indexOf('if (url.pathname === "/api/admin/password"'),
  "admin session guard must precede all protected admin handlers");
assert.ok(router.indexOf(guard) < router.indexOf('if (url.pathname === "/api/admin/status"'),
  "ordinary mailbox sessions must not query the admin configuration");
console.log("PASS: owner session cookie constraints, expiration and admin route classification");
