// v3.29: one look for the admin panel's controls, a green passkey chip, a
// chevron that turns in place, an attachment viewer that opens files outside
// the app, and a solid status-bar strip for iOS 26 Safari.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const css = read("src/client/admin-ui.css");
const main = read("src/client/main.tsx");
const verify = read("scripts/verify-css-equivalence.mjs");

assert.match(main, /import "\.\/layout-fixes\.css";\nimport "\.\/admin-ui\.css";/, "the admin stylesheet loads last");
assert.match(verify, /AMENDMENTS = new Set\(\["src\/client\/layout-fixes\.css", "src\/client\/admin-ui\.css"\]\)/, "it is reviewed as a deliberate change");
for (const rule of css.match(/^[^\s/*@}][^{]*\{/gm)) {
  assert.match(rule, /^#root \.admin-home\b/, `every admin rule is scoped to the admin panel: ${rule}`);
}
assert.doesNotMatch(css, /#root \.admin-home-/, "no class was rewritten into an ID selector");
assert.match(css, /#root \.admin-home :is\(button, a\)\.settings-primary \{\s*border-color: var\(--ui-cta-border\);\s*background: var\(--ui-cta\);/, "primary buttons keep the accent");
assert.match(css, /#root \.admin-home select:not\(\[multiple\]\) \{\s*-webkit-appearance: none;\s*appearance: none;/, "dropdowns use the themed field");
assert.match(css, /details > summary::after \{\s*content: "";[\s\S]*?transform: translateY\(-25%\) rotate\(45deg\);/, "the chevron is drawn, not a glyph");
assert.match(css, /details\[open\] > summary::after \{\s*transform: translateY\(25%\) rotate\(225deg\);/, "and turns in place when open");
assert.match(css, /:is\(\.key-chip-ok, \.admin-mailbox-status\.is-active, \.admin-domain-chip\.chip-active, \.admin-audit-success\) \{\s*border-color: color-mix\(in srgb, var\(--color-success\)/, "enabled and set-up states are green");

const admin = read("src/client/components/AdminPanel.tsx");
assert.match(admin, /<span className="key-chip key-chip-ok"><span aria-hidden="true">✓<\/span> Passkey enabled<\/span>/, "Passkey enabled uses the green set-up chip");
const kickers = ["DomainManager", "MailboxManager", "MailSettingsManager", "SuppressionManager", "KeysManager", "BrandingManager", "AdminSecurityLog"]
  .map(name => read(`src/client/components/${name}.tsx`).match(/admin-section-kicker">([^<]+)</)[1]);
assert.deepEqual(kickers, ["Domains", "Mailboxes", "Mail", "Deliverability", "Keys", "Branding", "Activity"], "section labels match the navigation");

const preview = read("src/client/components/AttachmentPreview.tsx");
assert.match(preview, /className="attachment-preview-open" href=\{previewUrl\} target="_blank" rel="noopener noreferrer"/, "Open shows the file in the system viewer");
assert.equal([...preview.matchAll(/download=\{attachment\.filename\} target="_blank" rel="noopener noreferrer"/g)].length, 2, "downloads never replace the app");
assert.match(preview, /onClick=\{event => \{ if \(event\.target === event\.currentTarget\) onClose\(\); \}\}/, "tapping outside the file closes the viewer");

const nav = read("src/client/components/MobileNav.tsx");
const fixes = read("src/client/layout-fixes.css");
assert.match(nav, /<div className="mobile-status-backdrop" aria-hidden="true"\/>/);
assert.match(fixes, /\.mobile-status-backdrop \{\s*display: block;\s*position: fixed;\s*top: 0;\s*left: 0;\s*right: 0;\s*z-index: 44;\s*height: calc\(env\(safe-area-inset-top\) \+ 12px\);\s*background-color: var\(--tone-bg-945\);/,
  "a full-width, solid strip touches the top edge and stays taller than WebKit's 10px minimum even without a safe-area inset");
assert.match(fixes, /html,\s*body \{\s*background-color: var\(--tone-bg-953\);/, "the root has a plain colour for Safari to fall back on");
assert.doesNotMatch(fixes.slice(fixes.indexOf(".mobile-status-backdrop {\n    display: block;")).split("}")[0], /backdrop-filter/, "no filter on the strip");
console.log("PASS: admin controls, passkey chip, chevron, attachment viewer and iOS status-bar strip");
