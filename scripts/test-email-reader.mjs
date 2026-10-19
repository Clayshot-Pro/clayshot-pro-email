// Native email reader: colour maths, the two display modes, and the
// guarantees the reader must keep (sandbox, full width, no white box).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { READABLE, contrast, emailBaseStyles, isClear, isNearWhite, parseColor } from "../src/client/emailTheme.ts";

// Colour parsing covers what computed styles and email authors produce.
assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
assert.deepEqual(parseColor("#11223380"), { r: 17, g: 34, b: 51, a: 128 / 255 });
assert.deepEqual(parseColor("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3, a: 1 });
assert.deepEqual(parseColor("rgba(1, 2, 3, 0.5)"), { r: 1, g: 2, b: 3, a: 0.5 });
assert.deepEqual(parseColor("rgb(1 2 3 / 50%)"), { r: 1, g: 2, b: 3, a: 0.5 });
assert.deepEqual(parseColor("White"), { r: 255, g: 255, b: 255, a: 1 });
assert.equal(parseColor("transparent").a, 0);
assert.equal(parseColor("color-mix(in srgb, red 50%, blue)"), null);
assert.equal(parseColor(""), null);

// WCAG contrast: black on white is 21:1, symmetric, and equal colours are 1:1.
const black = parseColor("#000"), white = parseColor("#fff"), dark = parseColor("rgb(18, 18, 18)");
assert.equal(Math.round(contrast(black, white)), 21);
assert.equal(contrast(white, black), contrast(black, white));
assert.equal(contrast(dark, dark), 1);
assert.ok(contrast(black, dark) < READABLE, "black text is unreadable on the dark theme and gets replaced");
assert.ok(contrast(parseColor("#e8e8e8"), dark) >= READABLE, "theme text stays readable");

// White paper is dropped in native mode; clear backgrounds show what is behind.
assert.equal(isClear(null), true);
assert.equal(isClear(parseColor("rgba(0,0,0,0)")), true);
assert.equal(isNearWhite(parseColor("#fafafa")), true);
assert.equal(isNearWhite(parseColor("#336699")), false);

// Native mode is themed and transparent; paper mode is a light card. Both size to content.
const theme = { text: "rgb(232, 232, 232)", link: "rgb(120, 170, 255)", background: "rgb(18, 18, 18)", font: "Inter, sans-serif", scheme: "dark" };
const native = emailBaseStyles("native", theme), paper = emailBaseStyles("paper", theme);
assert.match(native, /background: transparent !important/);
assert.match(native, /color: rgb\(232, 232, 232\)/);
assert.match(native, /a \{ color: rgb\(120, 170, 255\)/);
assert.match(paper, /background: #fff !important/);
for (const css of [native, paper]) assert.match(css, /height: auto !important/);
// A colour scheme that differs from the app's makes browsers paint the frame on an opaque (white) canvas.
assert.match(native, /:root \{ color-scheme: dark; \}/);
assert.match(paper, /:root \{ color-scheme: light; \}/);
for (const css of [native, paper]) assert.match(css, /body \{ font: 14px\/1\.6 Inter, sans-serif; \}/, "unstyled mail uses the app font");

// The reader keeps the sandbox, fills the reader column and only shows adapted mail.
const reader = readFileSync(new URL("../src/client/components/MessageReader.tsx", import.meta.url), "utf8");
assert.match(reader, /sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"/);
assert.doesNotMatch(reader, /sandbox="[^"]*allow-scripts/);
assert.match(reader, /classifyEmail\(doc\)/);
assert.match(reader, /if \(next === "native"\) applyNativeColors\(doc, theme\)/);
assert.match(reader, /visibility: "hidden"/);
assert.match(reader, /new Observer\(fit\)/);
assert.match(reader, /fitEmailWidth\(doc\)/, "wide newsletters are scaled to the reader width");
assert.match(reader, /scheme: style\.colorScheme/);
const css = readFileSync(new URL("../src/client/email-html.css", import.meta.url), "utf8");
assert.doesNotMatch(css, /760px/, "no width cap narrower than the reader column");
assert.match(css, /\.rich-email-shell \{\s*width: 100%;/);
assert.match(css, /\.rich-email-shell\.is-native \{\s*background: transparent;/);
assert.doesNotMatch(css.match(/\.rich-email-shell \{[^}]*\}/)[0], /#fff|border:/, "the base shell has no white box");

console.log("email reader checks passed");
