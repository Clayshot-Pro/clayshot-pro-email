// v3.28 desktop reader: equal-width actions with short labels, list and
// reader taking turns below 1280px, a window-height row, aligned header
// borders, and sender names that never break across lines.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { oneLine } from "../src/client/mailUtils.ts";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const fixes = read("src/client/layout-fixes.css");

assert.match(fixes, /\.reader-reply-bar button \{\s*min-width: 0;\s*justify-content: center;\s*container: reader-action \/ inline-size;/, "each action button is a size container");
assert.match(fixes, /@container reader-action \(max-width: 84px\) \{\s*\.unsubscribe-action \.label-long \{ display: none; \}\s*\.unsubscribe-action \.label-short \{ display: inline; \}/, "Unsubscribe shortens to Unsub when it does not fit");
assert.match(fixes, /grid-auto-columns: minmax\(0, 132px\);/, "desktop actions share equal columns");
assert.match(fixes, /@media \(min-width: 761px\) and \(max-width: 1279px\) \{\s*\.mail-workspace \{\s*grid-template-columns: minmax\(0, 1fr\);/, "medium windows show the list or the reader");
assert.match(fixes, /\.app-shell\.message-open \.mail-list-pane > :not\(\.desktop-topbar\) \{\s*display: none;/, "the search bar stays while the list is hidden");
assert.match(fixes, /\.app-shell \{\s*grid-template-rows: minmax\(0, 1fr\);/, "the desktop row fits the window height");
assert.match(fixes, /@media \(min-width: 761px\) \{\s*\.mail-filter-tabs,\s*\.draft-list-label,\s*\.reader-toolbar \{\s*height: 61px;/, "the list's tab row and the reader's title bar share one height");

assert.equal(oneLine("Intern Insider"), "Intern\u00a0Insider");
assert.equal(oneLine("  Intern\n Insider\u2028Weekly "), "Intern\u00a0Insider\u00a0Weekly", "line breaks and separators become non-breaking spaces");
const reader = read("src/client/components/MessageReader.tsx");
const list = read("src/client/components/MailList.tsx");
assert.match(reader, /"You" : oneLine\(senderLabel\(message\)\)/, "the reader shows the sender on one line");
assert.match(list, /: oneLine\(senderLabel\(message\)\)\}<\/span>/, "the list shows the sender on one line");
console.log("PASS: desktop actions, medium and short windows, aligned headers, one-line sender names");
