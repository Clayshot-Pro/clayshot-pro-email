// First-run setup for a self-hosted instance. Safe to re-run:
//   1. validate .env
//   2. create the D1 database and R2 bucket if missing
//   3. record D1_DATABASE_ID in .env
//   4. render wrangler.jsonc, upload secrets, apply remote migrations
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { loadConfigValues, missingRequired } from "../config/schema.mjs";
import { databaseIdByName } from "./config-lib.mjs";

const envFile = new URL("../.env", import.meta.url);
if (!existsSync(envFile)) throw new Error("No .env file found. Copy .env.example to .env and fill it in first.");

let { values } = loadConfigValues(envFile);
const missing = missingRequired(values, ["var", "deploy"]);
if (missing.length) throw new Error(`Fill these keys in .env first: ${missing.join(", ")}`);

const credentials = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN,
};
function run(command, args, { allowFailure = false, quiet = false } = {}) {
  const result = spawnSync(command, args, {
    stdio: quiet ? "pipe" : "inherit", shell: process.platform === "win32", env: credentials, encoding: "utf8",
  });
  if (result.status !== 0 && !allowFailure) process.exit(result.status ?? 1);
  return result;
}

console.log(`Setting up worker "${values.WORKER_NAME}" in account ${values.CLOUDFLARE_ACCOUNT_ID}.`);

let databaseId = values.D1_DATABASE_ID?.trim() || await databaseIdByName(values);
if (!databaseId) {
  console.log(`Creating D1 database ${values.D1_DATABASE_NAME}…`);
  run("npx", ["wrangler", "d1", "create", values.D1_DATABASE_NAME]);
  databaseId = await databaseIdByName(values);
  if (!databaseId) throw new Error("D1 database was created but could not be resolved through the API. Check the token's D1 permission.");
}
if (!values.D1_DATABASE_ID?.trim()) {
  appendFileSync(envFile, `\n# Added by npm run setup\nD1_DATABASE_ID=${databaseId}\n`, "utf8");
  console.log("Recorded D1_DATABASE_ID in .env.");
}

const bucket = run("npx", ["wrangler", "r2", "bucket", "create", values.R2_BUCKET_NAME], { allowFailure: true, quiet: true });
const bucketOutput = `${bucket.stdout ?? ""}${bucket.stderr ?? ""}`;
if (bucket.status === 0) console.log(`Created R2 bucket ${values.R2_BUCKET_NAME}.`);
else if (/already exists|already own/i.test(bucketOutput)) console.log(`R2 bucket ${values.R2_BUCKET_NAME} already exists.`);
else { console.error(bucketOutput); process.exit(bucket.status ?? 1); }

run("node", ["scripts/config-render.mjs", "--strict"]);
run("node", ["scripts/secrets-push.mjs"]);
run("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote"]);

console.log(`
Setup complete. Next:
  npm run deploy:self
Then follow docs/v3/SELF_HOSTING.md: custom domain, Email Routing catch-all, first sign-in.`);
