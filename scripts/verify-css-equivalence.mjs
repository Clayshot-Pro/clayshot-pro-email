#!/usr/bin/env node
// Proves that the CSS tokenization did not change the default render.
//
//   node scripts/verify-css-equivalence.mjs [base-ref]     (default 8215a7f)
//
// 1. Reads the CSS import order from src/client/main.tsx at <base-ref> (via
//    `git show`) and from the working tree.
// 2. Parses every imported stylesheet (old: from git, new: from disk) into an
//    ordered list of declarations with their at-rule context and selector.
// 3. Builds the root custom-property environment of each set: declarations in
//    rules whose selectors only match <html> in the default theme (`:root`,
//    `html`, `:root, [data-theme="ltm-dark"]`), winner chosen by importance,
//    specificity and order, exactly as the cascade would.
// 4. Resolves every var() recursively (with fallbacks) in both sets. Custom
//    properties that are also defined on non-root selectors are left as
//    var() text in both sets, so element-dependent values are compared
//    literally instead of being guessed.
// 5. Drops rules that exist only to serve other themes or opt-in hooks
//    ([data-theme] other than ltm-dark, [data-custom-accent], [data-density],
//    [data-text-size]) and root custom properties declared in files that are
//    not in the original import list (theme/token files: they are the
//    environment, not output).
// 6. Compares the ordered lists of (context, selector, property, value,
//    !important). Whitespace and hex case are normalised. Any difference is
//    printed and the script exits 1.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const base = process.argv[2] ?? "8215a7f";
const git = path => execFileSync("git", ["show", `${base}:${path}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });

// ---------------------------------------------------------------------------
function parseCss(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
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
      const raw = readUntil([";", "}"]);
      const colon = raw.indexOf(":");
      if (colon > 0) {
        const prop = raw.slice(0, colon).trim();
        let value = raw.slice(colon + 1).trim();
        let important = false;
        const imp = value.match(/\s*!\s*important\s*$/i);
        if (imp) { important = true; value = value.slice(0, imp.index).trim(); }
        decls.push({ ctx: ctx.join(" / "), selector, prop: prop.startsWith("--") ? prop : prop.toLowerCase(), value, important });
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

const cssImports = tsx => [...tsx.matchAll(/^\s*import\s+["'](\.\/[^"']+\.css)["'];?\s*$/gm)].map(m => posix.join("src/client", m[1]));

// ---------------------------------------------------------------------------
const splitSelectors = sel => { const out = []; let depth = 0, cur = "";
  for (const ch of sel) { if (ch === "(" || ch === "[") depth++; if (ch === ")" || ch === "]") depth--; if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; }
  out.push(cur.trim()); return out.filter(Boolean); };
const DEFAULT_THEME = /\[data-theme=(["']?)ltm-dark\1\]/g;
const rootSpecificity = part => {
  const p = part.replace(/\s+/g, "");
  if (p === "html") return 1;
  if (p === ":root" || p === "html:root") return p === ":root" ? 10 : 11;
  if (/^(:root|html)?\[data-theme=(["']?)ltm-dark\2\]$/.test(p)) return p.startsWith(":root") ? 20 : p.startsWith("html") ? 11 : 10;
  return -1;
};
const isHookPart = part => /\[data-(custom-accent|density|text-size)\b/.test(part)
  || (/\[data-theme\b/.test(part) && part.replace(DEFAULT_THEME, "").includes("[data-theme"));
function classifyRule(selector) {
  const parts = splitSelectors(selector);
  const hooks = parts.filter(isHookPart);
  if (hooks.length === parts.length) return { hook: true };
  if (hooks.length) throw new Error(`Selector mixes theme hooks with ordinary selectors: ${selector}`);
  const specs = parts.map(rootSpecificity);
  return { root: specs.every(s => s >= 0), specificity: Math.max(...specs) };
}

function load(files, readFile, originalFiles) {
  const decls = [];
  for (const file of files) for (const d of parseCss(readFile(file))) {
    const info = classifyRule(d.selector);
    decls.push({ ...d, file, ...info, original: originalFiles.has(file) });
  }
  return decls;
}

function buildEnv(decls) {
  const env = new Map(); const scoped = new Set();
  decls.forEach((d, order) => {
    if (!d.prop.startsWith("--") || d.hook) return;
    if (!d.root || d.ctx) { scoped.add(d.prop); return; }
    const prev = env.get(d.prop);
    const rank = [d.important ? 1 : 0, d.specificity, order];
    if (!prev || rank[0] > prev.rank[0] || (rank[0] === prev.rank[0] && (rank[1] > prev.rank[1] || (rank[1] === prev.rank[1] && rank[2] > prev.rank[2])))) env.set(d.prop, { value: d.value, rank });
  });
  return { env, scoped };
}

function resolve(value, ctx, stack = []) {
  let out = "", k = 0;
  while (k < value.length) {
    const at = value.indexOf("var(", k);
    if (at < 0 || (at > 0 && /[\w-]/.test(value[at - 1]))) { if (at < 0) { out += value.slice(k); break; } out += value.slice(k, at + 4); k = at + 4; continue; }
    out += value.slice(k, at);
    let depth = 0, end = at + 3;
    for (; end < value.length; end++) { if (value[end] === "(") depth++; else if (value[end] === ")" && --depth === 0) break; }
    const inner = value.slice(at + 4, end);
    const comma = (() => { let dd = 0; for (let j = 0; j < inner.length; j++) { if (inner[j] === "(") dd++; else if (inner[j] === ")") dd--; else if (inner[j] === "," && dd === 0) return j; } return -1; })();
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
    if (ctx.scoped.has(name)) out += `var(${name}${fallback === null ? "" : ", " + resolve(fallback, ctx, stack)})`;
    else if (stack.includes(name)) out += `<cycle ${name}>`;
    else if (ctx.env.has(name)) out += resolve(ctx.env.get(name).value, ctx, [...stack, name]);
    else if (fallback !== null) out += resolve(fallback, ctx, stack);
    else out += `<unset ${name}>`;
    k = end + 1;
  }
  return out;
}

const normalise = v => v.replace(/\s+/g, " ").replace(/\s*([(),\/])\s*/g, "$1").replace(/#[0-9a-f]{3,8}\b/gi, m => m.toLowerCase()).trim();

function comparable(decls) {
  const ctx = buildEnv(decls);
  return decls
    .filter(d => !d.hook)
    .filter(d => !(d.prop.startsWith("--") && !d.original))
    .map(d => ({ where: `${d.file}  ${d.ctx ? d.ctx + " → " : ""}${d.selector}`, key: `${d.ctx}|${d.selector}|${d.prop}`,
      text: `${d.prop}: ${normalise(resolve(d.value, ctx))}${d.important ? " !important" : ""}` }));
}

// ---------------------------------------------------------------------------
const oldFiles = cssImports(git("src/client/main.tsx"));
const newFiles = cssImports(readFileSync(join(ROOT, "src/client/main.tsx"), "utf8"));
const originals = new Set(oldFiles);
const oldList = comparable(load(oldFiles, f => git(f), originals));
const newList = comparable(load(newFiles, f => readFileSync(join(ROOT, f), "utf8"), originals));

console.log(`base ${base}`);
console.log(`old import order: ${oldFiles.join(", ")}`);
console.log(`new import order: ${newFiles.join(", ")}`);
let problems = 0;
for (const f of oldFiles) if (!newFiles.includes(f)) { console.log(`MISSING FILE  ${f} is no longer imported`); problems++; }
const keep = newFiles.filter(f => originals.has(f));
if (keep.join() !== oldFiles.filter(f => newFiles.includes(f)).join()) { console.log("ORDER  original stylesheets were reordered"); problems++; }

const n = Math.max(oldList.length, newList.length);
let shown = 0;
for (let i = 0; i < n; i++) {
  const a = oldList[i], b = newList[i];
  if (a && b && a.key === b.key && a.text === b.text) continue;
  problems++;
  if (shown++ < 40) {
    console.log(`\n#${i}`);
    console.log(`  - ${a ? a.where + "\n      " + a.text : "(none)"}`);
    console.log(`  + ${b ? b.where + "\n      " + b.text : "(none)"}`);
  }
  if (a && b && a.key !== b.key) { console.log("  (declaration lists diverge here; later differences are suppressed)"); break; }
}
const unresolved = newList.filter(d => /<(unset|cycle) /.test(d.text)).length;
console.log(`\ncompared ${oldList.length} original vs ${newList.length} new declarations; ${unresolved} with unresolved references`);
if (problems) { console.log(`FAIL: ${problems} difference(s)`); process.exit(1); }
console.log("PASS: default-theme cascade is declaration-for-declaration identical");
