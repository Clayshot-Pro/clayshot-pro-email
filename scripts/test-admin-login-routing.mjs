import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAdminLoginEmail } from "../src/client/adminIdentity.ts";
const source = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
for (const address of ["admin@clayshotpro.com", "admin@email.clayshot-dev.com",
  "admin@liamthemo.com", "admin@email.liamthemo.com", "ADMIN@MAIL.EXAMPLE.ORG"]) {
  assert.equal(isAdminLoginEmail(address), true, address);
}
for (const address of ["user@clayshotpro.com", "admin@@clayshotpro.com",
  "admin@", "admin@some domain.com", "xadmin@clayshotpro.com"]) {
  assert.equal(isAdminLoginEmail(address), false, address);
}
const ui = source("src/client/AccountSignIn.tsx");
assert.match(ui, /isAdminLoginEmail\(email\)/);
assert.match(ui, /isAdmin \? "\/api\/admin\/login\/password" : "\/api\/device\/login"/);
assert.match(ui, /minLength=\{1\}/, "Keep legacy passwords usable at sign-in");
assert.match(source("src/client/components/MailboxManager.tsx"), /minLength=\{4\} maxLength=\{32\}/);
assert.match(source("src/client/components/AdminPanel.tsx"), /minLength=\{4\} maxLength=\{32\}/);
console.log("PASS: admin sign-in routing and password boundaries");
