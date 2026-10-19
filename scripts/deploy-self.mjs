// Deploy a self-hosted instance from the command line:
// render (strict) -> typecheck -> build -> remote migrations -> wrangler deploy.
// The Workers Builds production path keeps using `npm run deploy`.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadConfigValues } from "../config/schema.mjs";
import { WRANGLER_FILE } from "../config/wrangler-file.mjs";

if (process.env.WORKERS_CI === "1") {
  throw new Error("deploy:self is for command-line deployments. Workers Builds uses `npm run deploy`.");
}

const { values } = loadConfigValues();
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN };

if (!process.argv.includes("--yes")) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(
    `Deploy worker "${values.WORKER_NAME}" to account ${values.CLOUDFLARE_ACCOUNT_ID}? [y/N] `);
  prompt.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("Cancelled.");
    process.exit(1);
  }
}

// The deploy rewrites wrangler.jsonc with this account's database ID; put the
// committed file back afterwards so the working tree stays clean.
const committed = readFileSync(WRANGLER_FILE, "utf8");
let status = 0;
try {
  for (const [command, args] of [
    ["node", ["scripts/config-render.mjs", "--strict"]],
    ["npm", ["run", "typecheck"]],
    ["npx", ["vite", "build"]],
    ["npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote"]],
    ["npx", ["wrangler", "deploy"]],
  ]) {
    const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", env });
    if (result.status !== 0) { status = result.status ?? 1; break; }
  }
} finally {
  writeFileSync(WRANGLER_FILE, committed, "utf8");
}
if (status) process.exit(status);
console.log("Deployed. Open the Worker URL or custom domain and complete first-run setup.");
