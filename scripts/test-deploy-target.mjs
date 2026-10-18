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
const install = workflow.slice(workflow.indexOf("Install dependencies"), workflow.indexOf("Generate browser favicon"));
assert.doesNotMatch(install, /CLOUDFLARE_API_TOKEN/, "the token is not exposed to npm ci");
assert.doesNotMatch(workflow, /^\s{4}env:/m, "no job-wide secrets");

console.log("PASS: production deploys only from main (Workers Builds or GitHub Actions)");
