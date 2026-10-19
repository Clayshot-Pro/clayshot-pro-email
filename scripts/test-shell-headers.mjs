// The Worker serves index.html itself; its security headers must match the
// ones public/_headers gives static assets, or browsers flip between policies
// (HSTS in particular is replaced by whichever response came last).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const staticBlock = read("public/_headers").split(/\n(?=\S)/).find(block => block.startsWith("/*\n"));
const staticHeaders = Object.fromEntries(staticBlock.split("\n").slice(1).filter(line => line.trim())
  .map(line => line.trim().match(/^([^:]+):\s*(.*)$/).slice(1)));

const shellSource = read("src/worker/instance.ts").match(/const SHELL_HEADERS[^{]*\{([\s\S]*?)\n\};/)[1];
const shellHeaders = Object.fromEntries([...shellSource.matchAll(/^\s*"([^"]+)":\s*"([^"]*)",?$/gm)].map(match => [match[1], match[2]]));

assert.ok(Object.keys(staticHeaders).length >= 7, "the /* block of public/_headers was parsed");
assert.deepEqual(shellHeaders, staticHeaders);
assert.doesNotMatch(staticHeaders["Strict-Transport-Security"], /includeSubDomains/i,
  "instances run on arbitrary domains: HSTS must not reach unrelated subdomains");
console.log("PASS: the app shell sends the same security headers as static assets");
