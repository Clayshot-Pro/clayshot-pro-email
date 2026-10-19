// Prepare wrangler.jsonc for a production deploy. The committed file is the
// Deploy to Cloudflare button's source and works as is for local development
// and validation builds, so this only rewrites it in strict mode (a production
// deploy from main by Workers Builds or GitHub Actions, or --strict): it fills
// in the D1 database ID and the Worker vars. Command-line deploys restore the
// committed file afterwards (scripts/deploy-self.mjs, scripts/setup.mjs).
import { readFile, writeFile } from "node:fs/promises";
import { loadConfigValues, missingRequired } from "../config/schema.mjs";
import { WRANGLER_FILE, parseJsonc } from "../config/wrangler-file.mjs";
import { renderWrangler, databaseIdFromDeployedWorker, databaseIdByName, isProductionDeploy, isWorkersBuildOnMain, provisionFirstDeploy, workerExists } from "./config-lib.mjs";

const strict = process.argv.includes("--strict") || isProductionDeploy();
if (!strict) {
  console.log("Using the committed wrangler.jsonc (not a production deploy).");
  process.exit(0);
}

const { values } = loadConfigValues();
let databaseId = values.D1_DATABASE_ID?.trim() || "";
const missing = missingRequired(values, ["deploy"]);
if (!databaseId && missing.length && isWorkersBuildOnMain()) {
  // A fork deployed by Cloudflare Workers Builds has no deploy keys: Wrangler
  // finds or creates the database and bucket by name and keeps them linked.
  databaseId = null;
} else if (!databaseId) {
  // Not in wrangler.jsonc (the Deploy button writes it there) or .env: look it
  // up with the deploy keys.
  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}. In a GitHub fork, add them under Settings → Secrets and variables → Actions → Repository secrets; elsewhere set them in .env or as Workers Builds build variables.`);
  }
  // A fresh fork's first deploy: no Worker yet, so nothing can be lost by
  // creating the database and bucket. An existing Worker always resolves its
  // own database, and a lookup that fails for it stops the deploy.
  const firstDeploy = isProductionDeploy() && await workerExists(values) === false;
  databaseId = firstDeploy
    ? await provisionFirstDeploy(values)
    : (isProductionDeploy() ? await databaseIdFromDeployedWorker(values) : null) ?? await databaseIdByName(values) ?? "";
  if (!databaseId) {
    throw new Error("Could not resolve the D1 database. Run `npm run setup`, or set D1_DATABASE_ID, and check the API token has D1 and Workers Scripts access.");
  }
}

const base = parseJsonc(await readFile(WRANGLER_FILE, "utf8"));
await writeFile(WRANGLER_FILE, renderWrangler(base, values, databaseId), "utf8");
console.log(`Prepared wrangler.jsonc for worker ${values.WORKER_NAME} (deployable${databaseId === null ? "; Wrangler links the database by name" : ""}).`);
