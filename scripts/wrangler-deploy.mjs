// `wrangler deploy` for `npm run deploy`. On the GitHub Actions production
// deploy it also hands the deploy's Cloudflare token to the app (v3.22) as the
// CLOUDFLARE_DEPLOY_CONNECTION Worker secret. The secret goes up with the new
// version itself, so there is no extra deployment, and other secrets are kept.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigValues } from "../config/schema.mjs";
import { deployConnectionSecret, isGitHubActionsOnMain } from "./config-lib.mjs";

const secrets = isGitHubActionsOnMain() ? deployConnectionSecret(loadConfigValues().values) : null;
const args = [fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)), "deploy"];
const dir = secrets ? mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "deploy-secrets-")) : null;
try {
  if (dir) {
    const file = join(dir, "secrets.json");
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    args.push("--secrets-file", file);
  }
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  if (dir && result.status === 0) console.log("The app's Cloudflare connection uses this deploy's API token (Worker secret CLOUDFLARE_DEPLOY_CONNECTION).");
  process.exitCode = result.status ?? 1;
} finally {
  if (dir) rmSync(dir, { recursive: true, force: true });
}
