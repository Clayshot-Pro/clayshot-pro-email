// Apply pending D1 migrations with Wrangler before a production deploy.
// GitHub Actions and command-line deploys fail on an error. In Cloudflare
// Workers Builds (the Deploy to Cloudflare button) the build token may not be
// allowed to run D1 queries; the app applies pending migrations itself on its
// first request (src/worker/migrationRunner.ts), so a failure only warns there.
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote"], {
  stdio: "inherit", shell: process.platform === "win32",
});
if (result.status === 0) {
  console.log("Applied pending D1 migrations.");
} else if (process.env.WORKERS_CI === "1") {
  console.warn("Could not apply D1 migrations from the build; the app applies them on its first request.");
} else {
  process.exit(result.status ?? 1);
}
