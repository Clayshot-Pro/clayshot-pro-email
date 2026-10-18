// Guard: no instance identity may be hard-coded in shipped source.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const FORBIDDEN = [/liamthemo/i, /LTM Mails?\b/, /contact@/i, /"Liam"/];

function files(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const targets = [...files(join(root, "src")), ...files(join(root, "public")), join(root, "index.html")]
  .filter(path => /\.(ts|tsx|js|mjs|css|html|json|webmanifest)$/.test(path));
const offenders = [];
for (const path of targets) {
  const text = readFileSync(path, "utf8");
  text.split(/\r?\n/).forEach((line, index) => {
    // The licence-required attribution link is the one permitted reference.
    const checked = line.replace("https://github.com/LiamTheMo/LTM-Email-Service", "");
    if (FORBIDDEN.some(pattern => pattern.test(checked))) offenders.push(`${path.slice(root.length)}:${index + 1}: ${line.trim().slice(0, 120)}`);
  });
}
assert.deepEqual(offenders, [], `Hard-coded instance identity found:\n${offenders.join("\n")}`);
console.log(`PASS: no hard-coded instance identity in ${targets.length} shipped files`);
