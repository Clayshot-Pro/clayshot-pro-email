// Regenerate .env.example from config/schema.mjs. `--check` fails if it is stale.
import { readFile, writeFile } from "node:fs/promises";
import { renderEnvExample } from "../config/schema.mjs";

const target = new URL("../.env.example", import.meta.url);
const expected = renderEnvExample();

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current.replace(/\r\n/g, "\n") !== expected) {
    console.error(".env.example is out of date. Run `npm run config:example`.");
    process.exit(1);
  }
  console.log(".env.example matches config/schema.mjs.");
} else {
  await writeFile(target, expected, "utf8");
  console.log("Wrote .env.example.");
}
