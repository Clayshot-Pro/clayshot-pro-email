#!/usr/bin/env node
// Lists every hard-coded colour literal in the client stylesheets, by file and
// line, then groups identical values. No dependencies.
//
//   node scripts/audit-css-colors.mjs              # all src/client CSS (incl. theme/)
//   node scripts/audit-css-colors.mjs --components # skip src/client/theme/themes/*.css
//   node scripts/audit-css-colors.mjs --json       # machine-readable output
//   node scripts/audit-css-colors.mjs path/a.css path/b.css
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Minimal CSS reader (shared shape with verify-css-equivalence / test-css-tokens)
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
// Properties whose values are identifiers, never colours.
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
        let value = raw.slice(colon + 1);
        const valueStart = start + colon + 1 + (value.length - value.trimStart().length);
        value = value.trim();
        let important = false;
        const imp = value.match(/\s*!\s*important\s*$/i);
        if (imp) { important = true; value = value.slice(0, imp.index).trim(); }
        decls.push({ ctx, selector, prop, value, important, line: lineAt(start), valueStart, valueLine: lineAt(valueStart) });
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
      if (src[i] === "}") { continue; }
      i++; // {
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

// Returns [{text, index}] colour literals found in a declaration value.
function findColourLiterals(prop, value) {
  // Blank out strings and url() so their contents are never matched.
  const masked = value.replace(/url\((?:[^()"']|"[^"]*"|'[^']*')*\)/gi, m => " ".repeat(m.length))
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, m => " ".repeat(m.length));
  const found = [];
  for (const m of masked.matchAll(/#[0-9a-fA-F]{3,8}(?![\w-])/g)) {
    if ([4, 5, 7, 9].includes(m[0].length)) found.push({ text: m[0], index: m.index });
  }
  for (const m of masked.matchAll(/(?<![\w-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi)) {
    let depth = 0, k = m.index + m[0].length - 1;
    for (; k < masked.length; k++) { if (masked[k] === "(") depth++; else if (masked[k] === ")" && --depth === 0) break; }
    found.push({ text: value.slice(m.index, k + 1), index: m.index });
  }
  if (!NON_COLOUR_PROPS.test(prop)) {
    for (const m of masked.matchAll(/(?<![\w#.-])[a-zA-Z]+(?![\w(-])/g)) {
      if (NAMED_COLOURS.has(m[0].toLowerCase())) found.push({ text: m[0], index: m.index });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const json = args.includes("--json");
const componentsOnly = args.includes("--components");
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let files = args.filter(a => !a.startsWith("--"));
if (!files.length) {
  const walk = dir => readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".css") ? [p] : [];
  });
  files = walk(join(root, "src/client")).map(p => relative(root, p).replace(/\\/g, "/"));
  if (componentsOnly) files = files.filter(f => !f.startsWith("src/client/theme/themes/"));
}

const report = [];
for (const file of files) {
  const abs = existsSync(file) ? file : join(root, file);
  for (const d of parseCss(readFileSync(abs, "utf8"))) {
    for (const lit of findColourLiterals(d.prop, d.value)) {
      report.push({ file, line: d.valueLine, selector: d.selector, prop: d.prop, literal: lit.text, context: d.ctx.join(" / ") });
    }
  }
}

if (json) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
const byFile = new Map();
for (const r of report) byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1);
for (const r of report) console.log(`${r.file}:${r.line}\t${r.literal}\t${r.prop}\t${r.selector}`);
console.log("\nTotals by file:");
for (const [f, n] of byFile) console.log(`  ${String(n).padStart(4)}  ${f}`);
const groups = new Map();
const norm = s => s.toLowerCase().replace(/\s+/g, "");
for (const r of report) { const k = norm(r.literal); groups.set(k, (groups.get(k) ?? 0) + 1); }
console.log(`\n${report.length} literals, ${groups.size} distinct values:`);
for (const [v, n] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${v}`);

