// Shared helpers for config rendering, secret upload, setup and deploy scripts.
import { keysOf } from "../config/schema.mjs";

export const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The deploy-ready Wrangler config: the committed wrangler.jsonc with the
 * resolved names, the D1 database ID and the Worker vars. Secrets are never
 * rendered; the output is checked for every non-empty secret value as a
 * defence against a mis-classified key.
 */
export function renderWrangler(base, values, databaseId) {
  const config = structuredClone(base);
  // databaseId null: Wrangler finds or creates the database by name on deploy
  // and keeps it linked (a fork deployed by Workers Builds without deploy keys).
  for (const [key, value] of Object.entries({ WORKER_NAME: values.WORKER_NAME, D1_DATABASE_NAME: values.D1_DATABASE_NAME,
    R2_BUCKET_NAME: values.R2_BUCKET_NAME, ...(databaseId === null ? {} : { D1_DATABASE_ID: databaseId }) })) {
    if (!String(value ?? "").trim()) throw new Error(`Missing value for ${key}`);
  }
  config.name = values.WORKER_NAME;
  const db = config.d1_databases?.find(binding => binding.binding === "DB");
  const bucket = config.r2_buckets?.find(binding => binding.binding === "MAIL");
  if (!db || !bucket) throw new Error("wrangler.jsonc must bind DB (D1) and MAIL (R2)");
  db.database_name = values.D1_DATABASE_NAME;
  if (databaseId === null) delete db.database_id;
  else db.database_id = databaseId;
  bucket.bucket_name = values.R2_BUCKET_NAME;
  // Worker vars: the Worker's own name, and the account ID the Email Sending
  // API needs (already a deploy key, not secret). All instance settings live in D1.
  const vars = { LTM_WORKER_NAME: values.WORKER_NAME };
  const accountId = String(values.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  if (/^[a-f0-9]{32}$/i.test(accountId)) vars.CF_EMAIL_SENDING_ACCOUNT_ID = accountId;
  config.vars = vars;
  const output = `// Prepared for deploy by scripts/config-render.mjs from the committed wrangler.jsonc.\n${JSON.stringify(config, null, 2)}\n`;
  assertNoSecrets(output, values);
  return output;
}

export function assertNoSecrets(text, values) {
  for (const key of keysOf("secret").concat("CLOUDFLARE_API_TOKEN")) {
    const value = String(values[key] ?? "");
    if (value.length >= 8 && text.includes(value)) {
      throw new Error(`Refusing to render: the value of ${key} would appear in generated config`);
    }
  }
}

async function cloudflare(path, values) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(values.CLOUDFLARE_ACCOUNT_ID)}${path}`, {
    headers: { Authorization: `Bearer ${values.CLOUDFLARE_API_TOKEN}`, Accept: "application/json" },
  }).catch(() => null);
  if (!response?.ok) return null;
  const payload = await response.json().catch(() => null);
  return payload?.success ? payload.result : null;
}

/** LTM production path: resolve D1 from the currently deployed Worker binding. */
export async function databaseIdFromDeployedWorker(values) {
  const settings = await cloudflare(`/workers/scripts/${encodeURIComponent(values.WORKER_NAME)}/settings`, values);
  const matches = (settings?.bindings ?? []).filter(binding =>
    binding?.type === "d1" && binding?.name === "DB" && typeof (binding?.database_id ?? binding?.id) === "string");
  return matches.length === 1 ? matches[0].database_id ?? matches[0].id : null;
}

/** Self-host path: resolve D1 by database name. */
export async function databaseIdByName(values) {
  const list = await cloudflare(`/d1/database?name=${encodeURIComponent(values.D1_DATABASE_NAME)}&per_page=100`, values);
  const match = Array.isArray(list) ? list.filter(db => db?.name === values.D1_DATABASE_NAME) : [];
  return match.length === 1 ? match[0].uuid ?? match[0].id ?? null : null;
}

export function isWorkersBuildOnMain() {
  return process.env.WORKERS_CI === "1" && process.env.WORKERS_CI_BRANCH?.trim() === "main";
}

/** The GitHub Actions production deploy (.github/workflows/deploy.yml) on main. */
export function isGitHubActionsOnMain() {
  return process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REF === "refs/heads/main";
}

/** A production deploy from main, by Workers Builds or GitHub Actions. */
export function isProductionDeploy() {
  return isWorkersBuildOnMain() || isGitHubActionsOnMain();
}

/** Dist folder name produced by the Cloudflare Vite plugin for the Worker. */
export const distWorkerDir = workerName => workerName.replace(/[^A-Za-z0-9]/g, "_");
