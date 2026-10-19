import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The production deploy guard accepts main from Workers Builds or GitHub Actions only.
const guard = env => spawnSync(process.execPath, ["scripts/assert-cloudflare-production.mjs"], {
  env: { PATH: process.env.PATH, ...env }, encoding: "utf8",
}).status;

assert.equal(guard({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "main" }), 0, "Workers Builds on main deploys");
assert.equal(guard({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main" }), 0, "GitHub Actions on main deploys");
assert.notEqual(guard({}), 0, "a local run is refused");
assert.notEqual(guard({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "v3.05" }), 0, "Workers Builds on a version branch is refused");
assert.notEqual(guard({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/v3.05" }), 0, "GitHub Actions on a version branch is refused");
assert.notEqual(guard({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/pull/1/merge" }), 0, "a pull request run is refused");

// The workflow only runs for main and keeps the deploy token out of install steps.
const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const triggers = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
assert.match(triggers, /push:\n\s+branches:\n\s+- main\n/, "deploys on push to main");
assert.doesNotMatch(triggers, /pull_request|schedule|workflow_run/, "no other automatic triggers");
assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/, "manual runs are limited to main");
assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'\n/, "every repository, forks included, deploys main");
assert.doesNotMatch(workflow, /DEPLOY_WITH_ACTIONS|github\.repository ==/, "no opt-in or repository check");

// A fork built by Workers Builds has no deploy keys: the render leaves the
// database ID out (Wrangler links it by name); elsewhere a missing ID is an error.
{
  const { spawnSync } = await import("node:child_process");
  const { readFileSync: read, writeFileSync: write } = await import("node:fs");
  const file = new URL("../wrangler.jsonc", import.meta.url);
  const committed = read(file, "utf8");
  const clean = { ...process.env };
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "GITHUB_ACTIONS", "GITHUB_REF"]) delete clean[key];
  const render = env => spawnSync(process.execPath, ["scripts/config-render.mjs"], { cwd: new URL("..", import.meta.url), env: { ...clean, ...env }, encoding: "utf8" });
  try {
    const fork = render({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "main" });
    assert.equal(fork.status, 0, fork.stderr);
    const prepared = JSON.parse(read(file, "utf8").replace(/^\/\/.*\n/, ""));
    assert.equal(prepared.d1_databases[0].database_id, undefined, "no ID: Wrangler links the database by name");
    assert.equal(prepared.vars.LTM_WORKER_NAME, "ltm-email-service");
    write(file, committed);
    const strict = spawnSync(process.execPath, ["scripts/config-render.mjs", "--strict"], { cwd: new URL("..", import.meta.url), env: clean, encoding: "utf8" });
    assert.notEqual(strict.status, 0, "outside Workers Builds a missing database ID and keys is an error");
    assert.match(strict.stderr, /Missing required configuration/);
  } finally {
    write(file, committed);
  }
}
// A fresh fork's first deploy creates its database and bucket; an existing
// Worker never gets a new database. Cloudflare is faked behind fetch.
{
  const { deployedWorkerDatabase, provisionFirstDeploy, workerExists } = await import("./config-lib.mjs");
  const values = { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CLOUDFLARE_API_TOKEN: "token-123456789",
    WORKER_NAME: "fresh-mail", D1_DATABASE_NAME: "fresh-mail", R2_BUCKET_NAME: "fresh-mail-mail" };
  const fake = (state, { r2Disabled = false, scriptsForbidden = false, unbound = false } = {}) => {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(url).pathname.replace(`/client/v4/accounts/${values.CLOUDFLARE_ACCOUNT_ID}`, "");
      const method = init.method ?? "GET";
      calls.push(`${method} ${path}`);
      const reply = (status, result, errors = []) => new Response(JSON.stringify({ success: status < 300, result, errors }), { status });
      if (path === `/workers/scripts/${values.WORKER_NAME}/settings`) {
        if (scriptsForbidden) return reply(403, null, [{ code: 10000, message: "Authentication error" }]);
        if (!state.worker) return reply(404, null, [{ code: 10007, message: "not found" }]);
        return reply(200, { bindings: unbound ? [{ type: "plain_text", name: "X" }] : [{ type: "d1", name: "DB", id: state.databases[0]?.uuid }] });
      }
      if (path === "/d1/database" && method === "GET") return reply(200, state.databases);
      if (path === "/d1/database" && method === "POST") {
        const db = { uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: JSON.parse(init.body).name };
        state.databases.push(db);
        return reply(200, db);
      }
      if (path === `/r2/buckets/${values.R2_BUCKET_NAME}`) {
        if (r2Disabled) return reply(403, null, [{ code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." }]);
        return state.buckets.includes(values.R2_BUCKET_NAME) ? reply(200, { name: values.R2_BUCKET_NAME }) : reply(404, null, [{ code: 10006, message: "The specified bucket does not exist." }]);
      }
      if (path === "/r2/buckets" && method === "POST") { state.buckets.push(JSON.parse(init.body).name); return reply(200, {}); }
      throw new Error(`unexpected call ${method} ${path}`);
    };
    return calls;
  };
  const realFetch = globalThis.fetch;
  try {
    const fresh = { worker: false, databases: [], buckets: [] };
    const calls = fake(fresh);
    assert.equal(await workerExists(values), false);
    const logs = [];
    assert.equal(await provisionFirstDeploy(values, line => logs.push(line)), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.deepEqual(fresh.buckets, ["fresh-mail-mail"]);
    assert.ok(calls.includes("POST /d1/database") && calls.includes("POST /r2/buckets"));
    assert.equal(logs.length, 2);
    // Run again (a retried first deploy): nothing is created twice.
    const again = fake(fresh);
    await provisionFirstDeploy(values, () => {});
    assert.ok(!again.some(call => call.startsWith("POST")), "existing resources are reused");
    assert.equal(fresh.databases.length, 1);

    fake({ worker: true, databases: [{ uuid: "x", name: "fresh-mail" }], buckets: [] });
    assert.equal(await workerExists(values), true, "an existing Worker is detected");
    assert.deepEqual(await deployedWorkerDatabase(values), { state: "bound", id: "x" }, "a Worker keeps its own database");
    fake({ worker: true, databases: [], buckets: [] }, { unbound: true });
    assert.deepEqual(await deployedWorkerDatabase(values), { state: "unbound" }, "a Worker without a database (an earlier failed setup) has nothing to lose");
    const forbidden = fake({ worker: false, databases: [], buckets: [] }, { scriptsForbidden: true });
    assert.equal((await deployedWorkerDatabase(values)).state, "unknown");
    assert.match((await deployedWorkerDatabase(values)).detail, /HTTP 403: Authentication error/);
    assert.ok(!forbidden.some(call => call.startsWith("POST")), "nothing is created when the Worker cannot be read");
    fake({ worker: false, databases: [], buckets: [] }, { scriptsForbidden: true });
    assert.equal(await workerExists(values), null, "a token without access is not mistaken for a new instance");
    fake({ worker: false, databases: [], buckets: [] }, { r2Disabled: true });
    await assert.rejects(provisionFirstDeploy(values, () => {}), /enable|R2 Storage: Edit/, "a disabled R2 is explained");
  } finally {
    globalThis.fetch = realFetch;
  }
  const render = readFileSync(new URL("./config-render.mjs", import.meta.url), "utf8");
  assert.match(render, /deployed\?\.state === "missing" \|\| deployed\?\.state === "unbound"\) \{\n\s+databaseId = await provisionFirstDeploy/,
    "only a deploy whose Worker is missing or has no database provisions");
  assert.match(render, /Could not read the Worker/, "an unreadable Worker names the account and permissions");
  assert.match(workflow, /- name: Check the Cloudflare secrets[\s\S]{0,800}Repository secrets/, "missing secrets fail with directions");
  assert.ok(workflow.indexOf("Check the Cloudflare secrets") < workflow.indexOf("- name: Checkout"), "checked before anything runs");
  assert.match(workflow, /GITHUB_STEP_SUMMARY/, "the run summary names the app address");
}

// The deploy creates the encryption key secret only when the Worker has none.
{
  const { ensureCredentialKeySecret } = await import("./config-lib.mjs");
  const values = { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CLOUDFLARE_API_TOKEN: "token-123456789", WORKER_NAME: "fresh-mail" };
  const realFetch = globalThis.fetch;
  const fake = (secrets, { listStatus = 200 } = {}) => {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ method: init.method ?? "GET", path: new URL(url).pathname, body: init.body ? JSON.parse(init.body) : null });
      if ((init.method ?? "GET") === "GET") {
        return new Response(JSON.stringify(listStatus === 200 ? { success: true, result: secrets.map(name => ({ name, type: "secret_text" })) }
          : { success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: listStatus });
      }
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
    };
    return calls;
  };
  try {
    const kept = fake(["PROVIDER_CREDENTIAL_KEY", "OTHER"]);
    assert.equal(await ensureCredentialKeySecret(values), "present");
    assert.ok(!kept.some(call => call.method === "PUT"), "an existing key is never replaced");
    const created = fake(["OTHER"]);
    assert.equal(await ensureCredentialKeySecret(values), "created");
    const put = created.find(call => call.method === "PUT");
    assert.equal(put.path, `/client/v4/accounts/${values.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/fresh-mail/secrets`);
    assert.equal(put.body.name, "PROVIDER_CREDENTIAL_KEY");
    assert.equal(put.body.type, "secret_text");
    assert.match(put.body.text, /^[A-Za-z0-9_-]{43}$/, "a random 32-byte key");
    fake([], { listStatus: 403 });
    await assert.rejects(ensureCredentialKeySecret(values), /Workers Scripts: Edit/);
  } finally {
    globalThis.fetch = realFetch;
  }
  const deploy = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts.deploy;
  assert.match(deploy, /wrangler-deploy\.mjs && node scripts\/ensure-worker-secrets\.mjs$/, "the key is ensured after every production deploy");
  // A deploy that already succeeded is never failed by this step.
  const ensure = env => spawnSync(process.execPath, ["scripts/ensure-worker-secrets.mjs"], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  const local = ensure({});
  assert.equal(local.status, 0);
  assert.match(local.stdout, /Not a production deploy/);
  const keyless = ensure({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main" });
  assert.equal(keyless.status, 0);
  assert.match(keyless.stdout, /::warning title=Encryption key::/);
}

// Repository variables override the committed names in both the build and the deploy.
for (const step of ["Type-check and build", "Apply D1 migrations and deploy"]) {
  const body = workflow.slice(workflow.indexOf(`- name: ${step}`)).split(/\n\s+- name:/)[0];
  for (const key of ["WORKER_NAME", "D1_DATABASE_NAME", "R2_BUCKET_NAME", "D1_DATABASE_ID"]) {
    assert.match(body, new RegExp(`${key}: \\$\\{\\{ vars\\.${key} \\}\\}`), `${step} reads the ${key} repository variable`);
  }
}
const install = workflow.slice(workflow.indexOf("Install dependencies"), workflow.indexOf("Generate browser favicon"));
assert.doesNotMatch(install, /CLOUDFLARE_API_TOKEN/, "the token is not exposed to npm ci");
assert.doesNotMatch(workflow, /^\s{4}env:/m, "no job-wide secrets");

// v3.22: the GitHub Actions deploy hands its own Cloudflare token to the app as
// one Worker secret, uploaded with the version (wrangler deploy --secrets-file).
{
  const { deployConnectionSecret } = await import("./config-lib.mjs");
  const token = "t".repeat(40), account = "a".repeat(32);
  assert.deepEqual(JSON.parse(deployConnectionSecret({ CLOUDFLARE_API_TOKEN: ` ${token} `, CLOUDFLARE_ACCOUNT_ID: account, WORKER_NAME: "mail" }).CLOUDFLARE_DEPLOY_CONNECTION),
    { token, accountId: account, scriptName: "mail" });
  for (const bad of [{ CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: account, WORKER_NAME: "mail" },
    { CLOUDFLARE_API_TOKEN: "short", CLOUDFLARE_ACCOUNT_ID: account, WORKER_NAME: "mail" },
    { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: "not-an-account", WORKER_NAME: "mail" },
    { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, WORKER_NAME: "" }]) {
    assert.equal(deployConnectionSecret(bad), null);
  }
  assert.match(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts.deploy,
    /node scripts\/wrangler-deploy\.mjs && node scripts\/ensure-worker-secrets\.mjs$/);

  // Run the wrapper in a copy of the repo with a fake wrangler that records what it got.
  const root = mkdtempSync(join(tmpdir(), "ltm-deploy-"));
  try {
    for (const path of ["config", "scripts/config-lib.mjs", "scripts/wrangler-deploy.mjs", "wrangler.jsonc"]) {
      cpSync(new URL(`../${path}`, import.meta.url), join(root, path), { recursive: true });
    }
    mkdirSync(join(root, "node_modules/wrangler/bin"), { recursive: true });
    const record = join(root, "record.json");
    writeFileSync(join(root, "node_modules/wrangler/bin/wrangler.js"), `const { readFileSync, statSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2), file = args[args.indexOf("--secrets-file") + 1];
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, secrets: args.includes("--secrets-file") ? JSON.parse(readFileSync(file, "utf8")) : null,
  mode: args.includes("--secrets-file") ? statSync(file).mode & 0o777 : null, file }));
process.exit(Number(process.env.FAKE_STATUS || 0));`);
    const run = env => {
      const result = spawnSync(process.execPath, [join(root, "scripts/wrangler-deploy.mjs")],
        { env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, ...env }, encoding: "utf8" });
      return { ...result, record: JSON.parse(readFileSync(record, "utf8")) };
    };
    const production = run({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", RUNNER_TEMP: root });
    assert.equal(production.status, 0);
    assert.equal(production.record.args[0], "deploy");
    const connection = JSON.parse(production.record.secrets.CLOUDFLARE_DEPLOY_CONNECTION);
    assert.equal(connection.token, token);
    assert.equal(connection.accountId, account);
    assert.ok(connection.scriptName, "the Worker name comes from wrangler.jsonc");
    assert.equal(production.record.mode, 0o600, "the secrets file is private");
    assert.throws(() => readFileSync(production.record.file), /ENOENT/, "and deleted after the deploy");
    assert.doesNotMatch(production.stdout + production.stderr, new RegExp(token), "the token is never printed");
    assert.match(production.stdout, /CLOUDFLARE_DEPLOY_CONNECTION/);

    const elsewhere = run({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/v3.22" });
    assert.deepEqual(elsewhere.record.args, ["deploy"], "only the production deploy hands the token over");
    assert.equal(run({}).record.secrets, null, "nor does a deploy from a computer");
    assert.equal(run({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", RUNNER_TEMP: root, FAKE_STATUS: "1" }).status, 1, "a failed deploy fails");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("PASS: production deploys only from main (Workers Builds or GitHub Actions)");
