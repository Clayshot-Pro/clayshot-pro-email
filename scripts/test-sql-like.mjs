// Search patterns: bound and LIKE-escaped (quotes and wildcards are literal
// text), and within D1's 50-byte LIKE pattern limit, so a long search returns
// results instead of "LIKE or GLOB pattern too complex".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LIKE_PATTERN_MAX_BYTES, likeContains } from "../src/worker/sql.ts";

const bytes = text => new TextEncoder().encode(text).length;
assert.equal(likeContains("hello"), "%hello%");
assert.equal(likeContains("50% off_now\\"), "%50\\% off\\_now\\\\%", "wildcards and the escape character are literal");
assert.equal(likeContains("' OR 1=1 --"), "%' OR 1=1 --%", "quotes are plain text: the value is bound, never part of the SQL");
for (const term of ["x".repeat(200), "%".repeat(200), "é".repeat(200), "🙂".repeat(200), "a_".repeat(100)]) {
  const pattern = likeContains(term);
  assert.ok(bytes(pattern) <= LIKE_PATTERN_MAX_BYTES, `${term.slice(0, 4)}…: ${bytes(pattern)} bytes`);
  assert.ok(pattern.startsWith("%") && pattern.endsWith("%"));
  const trailingEscapes = pattern.slice(1, -1).match(/\\*$/)[0].length;
  assert.equal(trailingEscapes % 2, 0, "an escape is never cut off from its character");
}
assert.equal(likeContains("x".repeat(48)), `%${"x".repeat(48)}%`, "48 bytes of text still fit");

// Every LIKE in the Worker goes through likeContains or binds a validated value.
const blocked = readFileSync(new URL("../src/worker/blockedSenders.ts", import.meta.url), "utf8");
assert.doesNotMatch(blocked, /LIKE '%' \|\|/, "blocked domains use a suffix comparison, not a LIKE pattern that can exceed 50 bytes");
console.log("PASS: search patterns are literal, bound and within D1's LIKE limit");
