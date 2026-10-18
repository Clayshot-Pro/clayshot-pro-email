import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  adminLoginAddress, appOrigin, appHostname, isAdministratorEmail,
  legacyAdminLoginAddress, passkeyRpId,
} from "../src/worker/config.ts";

const deployed = new Request("https://mail.example.org/api/auth/login/options");
const original = new Request("https://email.liamthemo.com/api/auth/login/options");
const workersDev = new Request("https://ltm-email-service.owner.workers.dev/api/auth/login/options");
const localhost = new Request("http://localhost:8787/api/auth/login/options");
assert.equal(adminLoginAddress(deployed), "admin@mail.example.org");
assert.equal(passkeyRpId(deployed), "mail.example.org");
assert.equal(appOrigin(deployed), "https://mail.example.org");
assert.equal(appHostname(workersDev), "ltm-email-service.owner.workers.dev");
assert.equal(adminLoginAddress(workersDev), "admin@ltm-email-service.owner.workers.dev");
assert.equal(appOrigin(localhost), "http://localhost:8787");
assert.equal(passkeyRpId(localhost), "localhost");

assert.equal(adminLoginAddress(original), "admin@email.liamthemo.com");
assert.equal(legacyAdminLoginAddress(original, "contact@liamthemo.com"), "admin@liamthemo.com");
assert.equal(isAdministratorEmail(original,"admin@liamthemo.com","contact@liamthemo.com"),true,
  "Existing owner sign-ins remain accepted");
assert.equal(isAdministratorEmail(original,"admin@email.liamthemo.com","contact@liamthemo.com"),true);
assert.equal(isAdministratorEmail(deployed,"admin@mail.example.org","contact@liamthemo.com"),true);
assert.equal(isAdministratorEmail(deployed,"admin@liamthemo.com","contact@liamthemo.com"),false,
  "Legacy admin aliases must not be recognized on unrelated Worker domains");
assert.equal(isAdministratorEmail(deployed,"Admin@Mail.Example.Org","contact@liamthemo.com"),true);
assert.equal(isAdministratorEmail(deployed,"admin@other.example.org","contact@liamthemo.com"),false);
assert.equal(legacyAdminLoginAddress(workersDev,"contact@liamthemo.com"),null);
assert.throws(()=>appOrigin(new Request("http://example.org/")),/Secure HTTPS origin required/);
assert.equal(appOrigin(new Request("http://127.0.0.1:8787/")),"http://127.0.0.1:8787");

function source(path) { return readFileSync(new URL("../" + path, import.meta.url), "utf8"); }
const router = source("src/worker/index.ts");
const auth = source("src/worker/auth.ts");
const stepup = source("src/worker/adminStepUp.ts");
const admin = source("src/worker/adminAuth.ts");
const device = source("src/worker/deviceAuth.ts");
const ui = source("src/client/AccountSignIn.tsx");
const google = source("src/worker/providers/google.ts");
assert.match(router,/request.headers.get\("Origin"\) === origin/,
  "CSRF protection must validate the active Worker origin");
assert.match(auth,/expectedOrigin: appOrigin\(request\)/);
assert.match(auth,/expectedRPID: passkeyRpId\(request\)/);
assert.match(stepup,/expectedOrigin: appOrigin\(request\)/);
assert.match(stepup,/expectedRPID: passkeyRpId\(request\)/);
assert.match(auth,/userName: adminLoginAddress\(request\)/);
// The legacy admin@<mail domain> alias follows the D1 primary domain.
assert.match(admin,/isAdministratorEmail\(request, email, await primaryDomain\(env\)\)/);
assert.match(device,/isAdministratorEmail\(request, email, await primaryDomain\(env\)\)/);
assert.equal(legacyAdminLoginAddress(original, "liamthemo.com"), "admin@liamthemo.com", "a bare primary domain works too");
assert.equal(legacyAdminLoginAddress(original, null), null, "an uninitialized instance has no legacy alias");
assert.match(device,/n.email_address NOT IN \(\?2,\?3\)/);
assert.match(ui,/isAdminLoginEmail\(email\)/, "Client must route admin identities to MFA login");
assert.match(google,/origin: appOrigin\(request\)/);
assert.match(google,/saved.origin !== appOrigin\(request\)/,
  "Google OAuth callback cannot redeem a state initiated on another Worker hostname");
assert.match(google,/redirect_uri: callbackUri\(request\)/);
assert.doesNotMatch(google,/REDIRECT_URI|APP_ORIGIN/);
assert.doesNotMatch(auth,/APP_ORIGIN|RP_ID/);
assert.doesNotMatch(stepup,/APP_ORIGIN|RP_ID/);
console.log("PASS: portable admin login, WebAuthn relying-party binding, CSRF and OAuth origin isolation");
