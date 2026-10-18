// Deploy a self-hosted instance from the command line:
// render (strict) -> typecheck -> build -> remote migrations -> wrangler deploy.
// The Workers Builds production path keeps using `npm run deploy`.
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { loadConfigValues } from "../config/schema.mjs";

if (process.env.WORKERS_CI === "1") {
  throw new Error("deploy:self is for command-line deployments. Workers Builds uses `npm run deploy`.");
}

const { values } = loadConfigValues();
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN };

if (!process.argv.includes("--yes")) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(
    `Deploy worker "${values.WORKER_NAME}" for ${values.APP_ORIGIN} to account ${values.CLOUDFLARE_ACCOUNT_ID}? [y/N] `);
  prompt.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("Cancelled.");
    process.exit(1);
  }
}

for (const [command, args] of [
  ["node", ["scripts/config-render.mjs", "--strict"]],
  ["npm", ["run", "typecheck"]],
  ["npx", ["vite", "build"]],
  ["npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote"]],
  ["npx", ["wrangler", "deploy"]],
]) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Deployed. Open ${values.APP_ORIGIN}`);
