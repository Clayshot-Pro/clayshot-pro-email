// v3.27 phone layout: folders in a drawer from the left, New message in the
// bottom-right corner, and the open message's actions along the bottom edge.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const nav = read("src/client/components/MobileNav.tsx");
const reader = read("src/client/components/MessageReader.tsx");
const fixes = read("src/client/layout-fixes.css");

assert.doesNotMatch(nav, /className="mobile-nav"/, "the bottom tab bar is gone");
assert.match(nav, /className="mobile-menu-button"[\s\S]*?aria-expanded=\{drawerOpen\}/, "a menu button opens the drawer");
assert.match(nav, /<nav id="mobile-folder-drawer" className=\{`mobile-drawer \$\{drawerOpen \? "open" : ""\}`\}[^>]*inert=\{!drawerOpen\}/,
  "the closed drawer cannot be focused or read");
assert.match(nav, /onFolderChange\(item\.key\); closeDrawer\(\);/, "choosing a folder closes the drawer");
assert.match(nav, /event\.key === "Escape"/, "Escape closes the drawer");
assert.match(nav, /className="mobile-compose-fab"/, "New message stays a floating button");

assert.match(fixes, /\.mobile-compose-fab \{\s*bottom: calc\(18px \+ env\(safe-area-inset-bottom\)\);/, "New message sits in the bottom-right corner");
assert.match(fixes, /\.app-shell \{\s*padding-bottom: 0;/, "no space is kept for a tab bar");
assert.match(fixes, /\.mobile-drawer \{[^}]*transform: translateX\(-100%\);/, "the drawer slides in from the left");
assert.match(fixes, /\.app-shell\.message-open \.reader-reply-bar \{\s*padding-top: 5px;\s*padding-bottom: calc\(5px \+ env\(safe-area-inset-bottom\)\);/,
  "the action bar clears the home indicator");

const toolbar = reader.split('<header className="reader-toolbar">')[1].split("</header>")[0];
const toolbarButtons = [...toolbar.matchAll(/<button\b/g)].length;
assert.equal(toolbarButtons, 2, "the reader toolbar keeps only Back and Star; the other actions are in the bottom bar");
const footer = reader.split('<footer className="reader-reply-bar">')[1].split("</footer>")[0];
const labels = [...footer.matchAll(/reader-action-label">([^<{]+|\{[^}]+\})</g)].map(match => match[1]);
assert.deepEqual(labels, ["Reply", "Forward", "Not junk", '{message.isArchived ? "Unarchive" : "Archive"}', "Junk", "Unsubscribe", "Block", "Delete", "Restore", "Delete forever"],
  "actions run Reply, Forward, Archive (or Not junk), Junk, Unsubscribe, Delete");
console.log("PASS: phone folders drawer, corner compose button and bottom action bar");
