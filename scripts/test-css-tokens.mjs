#!/usr/bin/env node
// CI guard for the v3.03 theme tokens. No dependencies.
//
//  1. No colour literal (hex, rgb[a](), hsl[a](), hwb/lab/lch/oklab/oklch/
//     color(), or a named colour such as white/black/red) appears in any
//     stylesheet under src/client outside src/client/theme/themes/*.css.
//     email-html.css (rendered message bodies) is allow-listed; transparent,
//     currentColor and inherit are not colour literals.
//  2. Component stylesheets never use palette primitives (--p-*) and every
//     var() they reference is defined by the default theme.
//  3. Every preset theme defines exactly the semantic token set of the
//     default theme (--color-*, --auth-*, --shadow-*), only uses palette
//     primitives it defines itself, and every --tone-* used by the components
//     is either derived from the semantic tokens in tokens.css or
//     intentionally fixed.
//  4. Contrast: --color-text vs --color-bg / --color-surface, and
//     --color-text-on-accent vs --color-accent (plus the --auth-* equivalents
//     and muted text) must be >= 4.5:1 in every preset (>= 7:1 for body text
//     in high-contrast). The default theme is reported only: it must stay
//     identical to the pre-theming look.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const rel = p => relative(ROOT, p).replace(/\\/g, "/");
const read = p => readFileSync(join(ROOT, p), "utf8");

// ---------------------------------------------------------------------------
const NAMED_COLOURS = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
  "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue " +
  "darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
  "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink " +
  "deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold " +
  "goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush " +
  "lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey " +
  "lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
  "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
  "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin " +
  "navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise " +
  "palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue " +
  "saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow " +
  "springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "));
const NON_COLOUR_PROPS = /^(font|font-family|animation|animation-name|grid-area|grid-template-areas|grid-row|grid-column|content|transition|transition-property|will-change|counter-reset|counter-increment|list-style|list-style-type|quotes|view-transition-name|container|container-name)$/i;

function parseCss(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === "\n") lineStarts.push(k + 1);
  const lineAt = pos => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };
  const decls = [];
  let i = 0;
  const readUntil = stops => {
    const start = i; let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '"' || c === "'") { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; } i++; continue; }
      if (c === "(") depth++; else if (c === ")") depth--;
      else if (depth === 0 && stops.includes(c)) break;
      i++;
    }
    return src.slice(start, i);
  };
  const parseDecls = (ctx, selector) => {
    while (i < src.length) {
      while (i < src.length && /[\s;]/.test(src[i])) i++;
      if (src[i] === "}") { i++; return; }
      const start = i;
      const raw = readUntil([";", "}"]);
      const colon = raw.indexOf(":");
      if (colon > 0) {
        const prop = raw.slice(0, colon).trim();
        let value = raw.slice(colon + 1).trim();
        const imp = value.match(/\s*!\s*important\s*$/i);
        if (imp) value = value.slice(0, imp.index).trim();
        decls.push({ ctx: ctx.join(" / "), selector, prop, value, line: lineAt(start) });
      }
    }
  };
  const parseBlock = ctx => {
    while (i < src.length) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (i >= src.length) return;
      if (src[i] === "}") { i++; return; }
      const prelude = readUntil(["{", ";", "}"]).trim().replace(/\s+/g, " ");
      if (src[i] === ";") { i++; continue; }
      if (src[i] === "}") continue;
      i++;
      if (prelude.startsWith("@")) {
        const name = prelude.slice(1).split(/[\s(]/)[0].toLowerCase();
        if (["media", "supports", "layer", "container", "document", "keyframes", "-webkit-keyframes", "scope", "starting-style"].includes(name)) parseBlock([...ctx, prelude]);
        else parseDecls(ctx, prelude);
      } else parseDecls(ctx, prelude);
    }
  };
  parseBlock([]);
  return decls;
}

function findColourLiterals(prop, value) {
  const masked = value.replace(/url\((?:[^()"']|"[^"]*"|'[^']*')*\)/gi, m => " ".repeat(m.length))
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, m => " ".repeat(m.length));
  const found = [];
  for (const m of masked.matchAll(/#[0-9a-fA-F]{3,8}(?![\w-])/g)) if ([4, 5, 7, 9].includes(m[0].length)) found.push(m[0]);
  for (const m of masked.matchAll(/(?<![\w-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi)) found.push(m[0] + "…)");
  if (!NON_COLOUR_PROPS.test(prop)) for (const m of masked.matchAll(/(?<![\w#.-])[a-zA-Z]+(?![\w(-])/g)) if (NAMED_COLOURS.has(m[0].toLowerCase())) found.push(m[0]);
  return found;
}
const varRefs = value => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]);

// ---------------------------------------------------------------------------
const failures = [];
const fail = msg => failures.push(msg);
const walk = dir => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".css") ? [p] : []; });
const allCss = walk(join(ROOT, "src/client")).map(rel);
const THEMES_DIR = "src/client/theme/themes/";
const ALLOW = new Set(["src/client/email-html.css"]);
const themeFiles = allCss.filter(f => f.startsWith(THEMES_DIR));
const componentFiles = allCss.filter(f => !f.startsWith("src/client/theme/"));
const tokensFile = "src/client/theme/tokens.css";

// 1. literal guard -------------------------------------------------------------
let literalCount = 0;
for (const file of allCss) {
  if (file.startsWith(THEMES_DIR) || ALLOW.has(file)) continue;
  for (const d of parseCss(read(file))) for (const lit of findColourLiterals(d.prop, d.value)) {
    literalCount++; fail(`${file}:${d.line} colour literal ${lit} in ${d.selector} { ${d.prop} } — use a token`);
  }
}

// 2. component references --------------------------------------------------------
const parsed = Object.fromEntries(allCss.map(f => [f, parseCss(read(f))]));
const defaultFile = THEMES_DIR + "ltm-dark.css";
const isDefaultRoot = sel => sel.split(",").every(s => /^(:root|html|\[data-theme="ltm-dark"\])$/.test(s.trim()));
const defaultEnv = new Map();
for (const f of [defaultFile, tokensFile, ...componentFiles]) for (const d of parsed[f] ?? []) if (d.prop.startsWith("--") && !d.ctx && isDefaultRoot(d.selector)) defaultEnv.set(d.prop, d.value);
const componentRefs = new Set();
for (const f of componentFiles) for (const d of parsed[f]) for (const name of varRefs(d.value)) {
  componentRefs.add(name);
  if (name.startsWith("--p-")) fail(`${f}:${d.line} uses palette primitive ${name} directly`);
  if (!defaultEnv.has(name)) fail(`${f}:${d.line} references ${name}, which the default theme does not define`);
}
for (const d of parsed[tokensFile] ?? []) for (const name of varRefs(d.value)) if (name.startsWith("--p-")) fail(`${tokensFile}:${d.line} uses palette primitive ${name}`);

// 3. preset completeness ------------------------------------------------------------
const SEMANTIC = /^--(color|auth|shadow)-/;
const semanticSet = new Set([...defaultEnv.keys()].filter(n => SEMANTIC.test(n)));
const presetIdOf = file => file.slice(THEMES_DIR.length, -4);
const presets = themeFiles.filter(f => f !== defaultFile);
const themeProps = {};
for (const file of presets) {
  const id = presetIdOf(file);
  const props = new Map();
  for (const d of parsed[file]) {
    if (!d.prop.startsWith("--")) continue;
    if (!d.selector.split(",").every(s => s.trim() === `:root[data-theme="${id}"]`)) { fail(`${file}:${d.line} token declared outside :root[data-theme="${id}"]`); continue; }
    props.set(d.prop, d.value);
  }
  themeProps[id] = props;
  for (const name of semanticSet) if (!props.has(name)) fail(`${file} does not define ${name}`);
  for (const name of props.keys()) if (SEMANTIC.test(name) && !semanticSet.has(name)) fail(`${file} defines ${name}, which is not a default-theme semantic token`);
  for (const [name, value] of props) for (const ref of varRefs(value)) {
    if (ref.startsWith("--p-") && !props.has(ref)) fail(`${file} ${name} uses ${ref}, a palette primitive it does not define`);
    if (ref.startsWith("--tone-")) fail(`${file} ${name} references component tone ${ref}`);
  }
}
const derivation = new Map();
for (const d of parsed[tokensFile] ?? []) if (d.selector === ':root[data-theme]:not([data-theme="ltm-dark"])') derivation.set(d.prop, d.value);
const usedTones = [...componentRefs].filter(n => n.startsWith("--tone-"));
const fixedTones = usedTones.filter(n => !derivation.has(n));
for (const n of fixedTones) if (!/^--tone-fixed-/.test(n)) fail(`${n} is used by components but has no derivation in tokens.css (only --tone-fixed-* may stay fixed)`);
for (const [tone, expr] of derivation) {
  if (!defaultEnv.has(tone)) fail(`tokens.css derives ${tone}, which the default theme does not define`);
  for (const ref of varRefs(expr)) if (!semanticSet.has(ref)) fail(`tokens.css derives ${tone} from ${ref}, which is not a semantic token`);
}

// 4. contrast -----------------------------------------------------------------------
function resolve(value, env, seen = []) {
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (m, name, fb) => {
    if (seen.includes(name)) return "invalid";
    if (env.has(name)) return resolve(env.get(name), env, [...seen, name]);
    return fb !== undefined ? resolve(fb.trim(), env, seen) : "invalid";
  });
}
function toRgb(v) {
  v = v.trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) { let h = m[1]; if (h.length <= 4) h = [...h].map(c => c + c).join(""); const a = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1; return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(a); }
  m = v.match(/^rgba?\(([^)]*)\)$/);
  if (m) { const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
  return null;
}
const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const PAIRS = [
  ["--color-text", "--color-bg", "text"], ["--color-text", "--color-surface", "text"],
  ["--color-text-muted", "--color-surface", "secondary"], ["--color-text-on-accent", "--color-accent", "secondary"],
  ["--auth-text", "--auth-bg", "text"], ["--auth-text", "--auth-surface", "text"],
  ["--auth-text-muted", "--auth-surface", "secondary"], ["--auth-text-on-accent", "--auth-accent", "secondary"],
];
const themes = [["ltm-dark", defaultEnv, true], ...presets.map(f => { const id = presetIdOf(f); const env = new Map(defaultEnv); for (const [k, v] of themeProps[id]) env.set(k, v); return [id, env, false]; })];
console.log("Contrast (WCAG 2.x ratios):");
for (const [id, env, reportOnly] of themes) {
  const rows = [];
  for (const [fg, bg, kind] of PAIRS) {
    const a = toRgb(resolve(env.get(fg) ?? "", env)), b = toRgb(resolve(env.get(bg) ?? "", env));
    if (!a || !b || a[3] < 1 || b[3] < 1) { rows.push(`${fg} / ${bg}: skipped (not an opaque hex/rgb value)`); continue; }
    const r = ratio(a, b);
    const min = id === "high-contrast" && kind === "text" ? 7 : 4.5;
    const ok = r >= min;
    rows.push(`${ok ? "ok  " : reportOnly ? "note" : "FAIL"} ${r.toFixed(2).padStart(5)}:1 ${fg} on ${bg}${ok ? "" : ` (needs ${min}:1)`}`);
    if (!ok && !reportOnly) fail(`${id}: ${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${min}:1`);
  }
  console.log(`  ${id}${reportOnly ? " (default, report only)" : ""}`);
  for (const row of rows) console.log(`    ${row}`);
}

console.log(`\nScanned ${allCss.length} stylesheets; ${componentRefs.size} tokens referenced by components; ${semanticSet.size} semantic tokens; ${presets.length} presets; ${derivation.size} derived tones; fixed tones: ${fixedTones.join(", ") || "none"}.`);
if (failures.length) {
  console.log(`\nFAIL: ${failures.length} problem(s)`);
  for (const f of failures.slice(0, 200)) console.log("  " + f);
  if (failures.length > 200) console.log(`  … ${failures.length - 200} more`);
  process.exit(1);
}
console.log("PASS: no colour literals outside theme files, presets complete, contrast OK");
