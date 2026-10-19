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

/** One account-scoped Cloudflare API call: { status, success, result, errors }; status 0 when unreachable. */
async function cloudflareCall(path, values, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(values.CLOUDFLARE_ACCOUNT_ID)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${values.CLOUDFLARE_API_TOKEN}`, Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => null);
  if (!response) return { status: 0, success: false, result: null, errors: [] };
  const payload = await response.json().catch(() => null);
  return { status: response.status, success: Boolean(response.ok && payload?.success), result: payload?.result ?? null, errors: payload?.errors ?? [] };
}

async function cloudflare(path, values) {
  const call = await cloudflareCall(path, values);
  return call.success ? call.result : null;
}

const describe = call => call.status === 0 ? "Cloudflare could not be reached"
  : `HTTP ${call.status}${call.errors[0]?.message ? `: ${call.errors[0].message}` : ""}`;

/**
 * The app encrypts stored keys (and its push notification keys) with the
 * PROVIDER_CREDENTIAL_KEY Worker secret. A deploy creates it when the Worker
 * has none, so a new instance works without a manual step. An existing one is
 * never replaced: data encrypted with it would become unreadable. Returns
 * "created", "present", or throws with the reason.
 */
export async function ensureCredentialKeySecret(values) {
  const path = `/workers/scripts/${encodeURIComponent(values.WORKER_NAME)}/secrets`;
  const list = await cloudflareCall(path, values);
  if (!list.success) throw new Error(`Could not list the Worker's secrets (${describe(list)}). The API token needs Workers Scripts: Edit.`);
  if ((list.result ?? []).some(secret => secret?.name === "PROVIDER_CREDENTIAL_KEY")) return "present";
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const created = await cloudflareCall(path, values, { method: "PUT", body: { name: "PROVIDER_CREDENTIAL_KEY", text: key, type: "secret_text" } });
  if (!created.success) throw new Error(`Could not create the PROVIDER_CREDENTIAL_KEY secret (${describe(created)}).`);
  return "created";
}

/**
 * The Worker's database, as deployed: "missing" (no such Worker), "unbound"
 * (the Worker exists without a DB binding, for example a placeholder made in
 * the dashboard or an earlier failed setup), "bound" with its database ID, or
 * "unknown" with a reason when it cannot be read (no permission, wrong account).
 */
export async function deployedWorkerDatabase(values) {
  const call = await cloudflareCall(`/workers/scripts/${encodeURIComponent(values.WORKER_NAME)}/settings`, values);
  if (!call.success) {
    if (call.status === 404 || call.errors.some(error => error?.code === 10007)) return { state: "missing" };
    return { state: "unknown", detail: describe(call) };
  }
  const bindings = (call.result?.bindings ?? []).filter(binding => binding?.type === "d1" && binding?.name === "DB");
  if (!bindings.length) return { state: "unbound" };
  const id = bindings.length === 1 ? bindings[0].database_id ?? bindings[0].id : null;
  return typeof id === "string" && id ? { state: "bound", id } : { state: "unknown", detail: "the Worker's DB binding has no database ID" };
}

/** Whether the Worker is already deployed: true, false, or null when that cannot be told. */
export async function workerExists(values) {
  const { state } = await deployedWorkerDatabase(values);
  return state === "missing" ? false : state === "unknown" ? null : true;
}

/**
 * First deploy of a new instance (a fresh fork): create the D1 database and
 * the R2 bucket named in the config when they do not exist yet. Only called
 * when the Worker does not exist or has no database bound, so an instance
 * with data is never pointed at a new, empty database. Returns the database ID.
 */
export async function provisionFirstDeploy(values, log = console.log) {
  let databaseId = await databaseIdByName(values);
  if (!databaseId) {
    const created = await cloudflareCall("/d1/database", values, { method: "POST", body: { name: values.D1_DATABASE_NAME } });
    databaseId = created.success ? created.result?.uuid ?? created.result?.id ?? null : null;
    if (!databaseId) {
      throw new Error(`Could not create the D1 database "${values.D1_DATABASE_NAME}" (${describe(created)}). The API token needs D1: Edit.`);
    }
    log(`First deploy: created the D1 database "${values.D1_DATABASE_NAME}".`);
  }
  const bucket = await cloudflareCall(`/r2/buckets/${encodeURIComponent(values.R2_BUCKET_NAME)}`, values);
  if (!bucket.success) {
    if (bucket.status !== 404) {
      throw new Error(`Could not check the R2 bucket "${values.R2_BUCKET_NAME}" (${describe(bucket)}). The API token needs Workers R2 Storage: Edit, and R2 must be enabled in the Cloudflare dashboard.`);
    }
    const created = await cloudflareCall("/r2/buckets", values, { method: "POST", body: { name: values.R2_BUCKET_NAME } });
    if (!created.success) {
      throw new Error(`Could not create the R2 bucket "${values.R2_BUCKET_NAME}" (${describe(created)}). The API token needs Workers R2 Storage: Edit, and R2 must be enabled in the Cloudflare dashboard.`);
    }
    log(`First deploy: created the R2 bucket "${values.R2_BUCKET_NAME}".`);
  }
  return databaseId;
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
