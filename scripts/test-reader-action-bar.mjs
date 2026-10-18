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
assert.equal(buttons.length, 9, "All action variants, including Trash actions, must be retained");
for (const [index, button] of buttons.entries()) {
  assert.match(button[0], /<Icon\b/, "Every action must still have an icon");
  assert.match(button[0], /<span className="reader-action-label">/, "Missing text wrapper on action " + index);
}
assert.match(footer, /reader-action-label">Unsubscribe<\/span>/);
assert.match(footer, /reader-action-label">Delete forever<\/span>/);
console.log("PASS: Reader toolbar uses dark mobile theme and optically centered labels");
