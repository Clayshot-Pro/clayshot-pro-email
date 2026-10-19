import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

console.log("PASS: production deploys only from main (Workers Builds or GitHub Actions)");
