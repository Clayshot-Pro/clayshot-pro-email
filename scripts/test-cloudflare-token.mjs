// One Cloudflare API token deploys the app and sets up its domains. The
// permission list in the app is the single source for the token link, the
// help text and the README, and it covers everything either side asks for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLOUDFLARE_TOKEN_PERMISSIONS, CLOUDFLARE_TOKEN_URL } from "../src/client/cloudflareToken.ts";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const listed = new Set(CLOUDFLARE_TOKEN_PERMISSIONS.map(permission => `${permission.name}: ${permission.access}`));

// Deploys: wrangler deploy, D1 migrations, the R2 bucket and account lookups.
for (const needed of ["Workers Scripts: Edit", "D1: Edit", "Workers R2 Storage: Edit", "Account Settings: Read"]) {
  assert.ok(listed.has(needed), `deploys need ${needed}`);
}
// The app: every permission its Cloudflare errors can ask for is on the list.
const hints = [...read("src/worker/cloudflare/api.ts").matchAll(/needs ([A-Za-z0-9 ]+: (?:Edit|Read))(?: and ([A-Za-z0-9 ]+: (?:Edit|Read)))?/g)]
  .flatMap(match => match.slice(1).filter(Boolean));
assert.ok(hints.length >= 6);
for (const needed of hints) assert.ok(listed.has(needed), `the app asks for ${needed}`);

// The link pre-selects every permission Cloudflare has a key for; the rest are named for adding by hand.
const prefilled = JSON.parse(new URL(CLOUDFLARE_TOKEN_URL).searchParams.get("permissionGroupKeys"));
assert.deepEqual(prefilled, CLOUDFLARE_TOKEN_PERMISSIONS.filter(permission => permission.key)
  .map(permission => ({ key: permission.key, type: permission.access.toLowerCase() })));
assert.deepEqual(CLOUDFLARE_TOKEN_PERMISSIONS.filter(permission => !permission.key).map(permission => permission.name),
  ["Email Sending", "Email Routing Rules"]);

// The README asks for the same token, with the same permissions and link.
const readme = read("README.md");
for (const permission of listed) assert.ok(readme.includes(`**${permission}**`), `README lists ${permission}`);
assert.ok(readme.includes(CLOUDFLARE_TOKEN_URL), "README links the same pre-filled token form");
console.log(`PASS: one Cloudflare token covers deploys and the app (${listed.size} permissions)`);
