import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/client/ui-overrides.css", import.meta.url), "utf8");
const reader = readFileSync(new URL("../src/client/components/MessageReader.tsx", import.meta.url), "utf8");

const mobile = css.slice(css.indexOf("/* ---- mobile-mail-actions.css ---- */"), css.indexOf("/* ---- auth.css ---- */"));
assert.ok(mobile.includes("background: var(--tone-v208-reader-bar);"), "Mobile action bar must use the theme's reader surface");
assert.ok(!mobile.includes("background: rgba(255,255,255,.98);"), "White mobile action-bar frame must not return");
assert.ok(mobile.includes("backdrop-filter: none;"), "Do not add a bright backdrop over the dark reader");
assert.ok(mobile.includes(".reader-reply-bar .reader-action-label"), "Optical text adjustment must target labels, not icons");
assert.ok(mobile.includes("transform: translateY(-1.5px);"), "Raise labels slightly to center alongside icons");
assert.ok(mobile.includes("align-items: center;"), "Buttons must vertically center their contents");

const footer = reader.split('<footer className="reader-reply-bar">')[1]?.split("</footer>")[0];
assert.ok(footer, "Message reader needs its footer action bar");
const buttons = [...footer.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)];
assert.equal(buttons.length, 10, "All action variants, including Trash actions and Block, must be retained");
for (const [index, button] of buttons.entries()) {
  assert.match(button[0], /<Icon\b/, "Every action must still have an icon");
  assert.match(button[0], /<span className="reader-action-label">/, "Missing text wrapper on action " + index);
}
assert.match(footer, /reader-action-label">Unsubscribe<\/span>/);
// Block is a desktop footer action; phones reach it from the Unsubscribe dialog.
assert.match(footer, /className="reader-block-action"[^>]*>.*reader-action-label">Block<\/span>/);
assert.match(readFileSync(new URL("../src/client/layout-fixes.css", import.meta.url), "utf8"), /\.reader-reply-bar \.reader-block-action \{\s*display: none;/);
assert.match(readFileSync(new URL("../src/client/components/MessageReader.tsx", import.meta.url), "utf8"), />Block sender<\/button>/);
assert.match(footer, /reader-action-label">Delete forever<\/span>/);
console.log("PASS: Reader toolbar uses dark mobile theme and optically centered labels");

// v3.10 phone spacing: no doubled top inset in the reader, one row of
// actions, and the iOS 26 installed-app viewport reaches the screen bottom.
const fixes = readFileSync(new URL("../src/client/layout-fixes.css", import.meta.url), "utf8");
assert.match(fixes, /@media \(display-mode: standalone\) \{\s*html \{\s*min-height: min\(100lvh, calc\(100% \+ env\(safe-area-inset-top\)\)\);/,
  "installed iOS app: the root is screen-tall so the bottom bar reaches the bottom edge (WebKit 301108)");
assert.match(fixes, /\.app-shell\.message-open \.reader-toolbar \{\s*min-height: 0;\s*padding-top: 6px;/,
  "the open reader's toolbar must not add the top safe area again");
assert.match(fixes, /\.app-shell\.message-open \.reader-reply-bar \{\s*grid-template-columns: none;\s*grid-auto-flow: column;/,
  "phone reader actions stay on one row");
