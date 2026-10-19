// v3.12: first-run setup with a Cloudflare token, the stored connection, and
// automatic domain wiring. Runs the real code against the migrations on
// node:sqlite with a fake Cloudflare API that records every call.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

function d1(db) {
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(row => ({ ...row })) }),
    first: async () => { const row = db.prepare(sql).get(...args); return row ? { ...row } : null; },
  });
  return {
    prepare: sql => statement(sql),
    batch: async statements => { db.exec("BEGIN"); try { for (const s of statements) await s.run(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return []; },
  };
}
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter(file => file.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, dir), "utf8"));
  return db;
}

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const VERSION = "11111111-2222-4333-8444-555555555555";
const TOKEN = "cf_token_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A fake Cloudflare API: one account, one Worker, one zone. */
function fakeCloudflare(options = {}) {
  const state = {
    accounts: options.accounts ?? [ACCOUNT],
    scripts: options.scripts ?? { [ACCOUNT]: ["ltm-email-service"] },
    versions: options.versions ?? { [`${ACCOUNT}/ltm-email-service`]: [VERSION] },
    zones: options.zones ?? [{ id: "zone1", name: "example.org", account: ACCOUNT }],
    mx: options.mx ?? [],
    routing: options.routing ?? false,
    catchAll: options.catchAll ?? { enabled: false, actions: [{ type: "drop" }] },
    subdomains: options.subdomains ?? [],
    txt: options.txt ?? [],
    secrets: {},
    calls: [],
  };
  const ok = result => new Response(JSON.stringify({ success: true, result }), { status: 200 });
  const fail = (status, code, message) => new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status });
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    if (url.hostname === "cloudflare-dns.com") return new Response(JSON.stringify({ Answer: [] }));
    assert.equal(url.hostname, "api.cloudflare.com");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`, "every call uses the token");
    const path = url.pathname.replace("/client/v4", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push(`${method} ${path}`);
    let m;
    if (path === "/accounts") return options.tokenInvalid ? fail(401, 1000, "Invalid API Token") : ok(state.accounts.map(id => ({ id })));
    if ((m = path.match(/^\/accounts\/(\w+)\/workers\/scripts\/([^/]+)\/versions\/([\w-]+)$/))) {
      return state.versions[`${m[1]}/${decodeURIComponent(m[2])}`]?.includes(m[3]) ? ok({ id: m[3] }) : fail(404, 10007, "not found");
    }
    if ((m = path.match(/^\/accounts\/(\w+)\/workers\/scripts$/))) return ok((state.scripts[m[1]] ?? []).map(id => ({ id })));
    if ((m = path.match(/^\/accounts\/(\w+)\/workers\/scripts\/([^/]+)\/secrets$/)) && method === "PUT") {
      state.secrets[body.name] = body; return ok({ name: body.name });
    }
    if (path === "/zones") {
      return ok(state.zones.filter(zone => zone.name === url.searchParams.get("name") && zone.account === url.searchParams.get("account.id")));
    }
    if ((m = path.match(/^\/zones\/(\w+)\/dns_records$/)) && method === "GET") {
      const type = url.searchParams.get("type"), name = url.searchParams.get("name");
      return ok(type === "MX" ? state.mx.filter(r => r.name === name) : state.txt.filter(r => r.name === name));
    }
    if ((m = path.match(/^\/zones\/(\w+)\/dns_records\/(\w+)$/)) && method === "DELETE") {
      state.mx = state.mx.filter(r => r.id !== m[2]); return ok({ id: m[2] });
    }
    if ((m = path.match(/^\/zones\/(\w+)\/dns_records$/)) && method === "POST") { state.txt.push(body); return ok({ id: "txt1" }); }
    if ((m = path.match(/^\/zones\/(\w+)\/email\/routing$/))) return ok({ enabled: state.routing });
    if ((m = path.match(/^\/zones\/(\w+)\/email\/routing\/dns$/)) && method === "POST") {
      state.routing = true;
      const zoneName = state.zones.find(zone => zone.id === m[1])?.name;
      state.mx = [{ id: "mx1", name: body?.name ?? zoneName, content: "route1.mx.cloudflare.net", priority: 13 }];
      return ok({ enabled: true });
    }
    if ((m = path.match(/^\/zones\/(\w+)\/email\/routing\/rules\/catch_all$/))) {
      if (method === "PUT") state.catchAll = body;
      return ok(state.catchAll);
    }
    if ((m = path.match(/^\/zones\/(\w+)\/email\/sending\/subdomains$/))) {
      if (method === "GET") return ok(state.subdomains);
      if (options.sendingFails) return fail(401, 2036, "Unauthorized");
      state.subdomains.push({ name: body.name, tag: "s1" }); return ok({ name: body.name, tag: "s1" });
    }
    throw new Error(`unexpected Cloudflare call ${method} ${path}`);
  };
  return { state, fetch, mutations: () => state.calls.filter(call => !call.startsWith("GET")) };
}

const setupRequest = body => new Request("https://mail.example.org/api/setup", { method: "POST", body: JSON.stringify(body) });

async function run(m) {
  const env = (db, extra = {}) => ({ DB: d1(db), MAIL: { head: async () => null }, CF_VERSION_METADATA: { id: VERSION },
    LTM_WORKER_NAME: "ltm-email-service", ...extra });

  // Locating the Worker: by name, by scanning (a renamed Worker), and refusing other accounts.
  {
    const cf = fakeCloudflare();
    assert.deepEqual(await m.locateWorker(env(database()), TOKEN, cf.fetch), { accountId: ACCOUNT, scriptName: "ltm-email-service" });
    const renamed = fakeCloudflare({ scripts: { [ACCOUNT]: ["other", "my-mail"] }, versions: { [`${ACCOUNT}/my-mail`]: [VERSION] } });
    assert.deepEqual(await m.locateWorker(env(database()), TOKEN, renamed.fetch), { accountId: ACCOUNT, scriptName: "my-mail" });
    // Same Worker name in another account, different version: not this app.
    const impostor = fakeCloudflare({ accounts: [OTHER], scripts: { [OTHER]: ["ltm-email-service"] }, versions: { [`${OTHER}/ltm-email-service`]: ["99999999-2222-4333-8444-555555555555"] } });
    assert.match((await m.locateWorker(env(database()), TOKEN, impostor.fetch)).error, /cannot see the Worker that runs this app/);
    assert.match((await m.locateWorker(env(database()), TOKEN, fakeCloudflare({ tokenInvalid: true }).fetch)).error, /did not accept this token/);
    assert.match((await m.locateWorker(env(database(), { CF_VERSION_METADATA: undefined }), TOKEN, cf.fetch)).error, /only on the deployed app/);
  }

  // The encryption key: created only when entirely absent, never replaced.
  {
    const connection = { token: TOKEN, accountId: ACCOUNT, scriptName: "ltm-email-service" };
    const cf = fakeCloudflare();
    const created = await m.ensureCredentialKey(env(database()), connection, cf.fetch);
    assert.equal(Buffer.from(created.key, "base64url").length, 32);
    assert.deepEqual(cf.state.secrets.PROVIDER_CREDENTIAL_KEY, { name: "PROVIDER_CREDENTIAL_KEY", text: created.key, type: "secret_text" });
    const existing = fakeCloudflare();
    assert.deepEqual(await m.ensureCredentialKey(env(database(), { PROVIDER_CREDENTIAL_KEY: created.key }), connection, existing.fetch), { key: null });
    assert.deepEqual(existing.mutations(), [], "a valid key is left alone");
    const broken = fakeCloudflare();
    assert.match((await m.ensureCredentialKey(env(database(), { PROVIDER_CREDENTIAL_KEY: "too-short" }), connection, broken.fetch)).error, /not a valid key/);
    assert.deepEqual(broken.mutations(), [], "an invalid key is never overwritten");
  }

  // First-run setup with a token: one request does everything but the passkey.
  {
    const db = database();
    const cf = fakeCloudflare();
    globalThis.fetch = cf.fetch;
    const e = env(db);
    assert.equal((await m.setupInstance(setupRequest({ domain: "example.org", adminPassword: "x", cloudflareToken: TOKEN }), e)).status, 400,
      "the password is checked before anything else");
    assert.deepEqual(cf.state.calls, [], "no Cloudflare call for an invalid form");
    const response = await m.setupInstance(setupRequest({ domain: "Example.ORG", adminPassword: "correct horse", cloudflareToken: ` Bearer ${TOKEN} ` }), e);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.domain, "example.org");
    assert.equal(Buffer.from(result.generatedKey, "base64url").length, 32, "the new encryption key is returned once");
    assert.deepEqual(result.domainReport.steps.map(step => `${step.id}:${step.status}`),
      ["zone:done", "routing:done", "catch-all:done", "sending:done", "dmarc:done"]);
    assert.equal(result.domainReport.routingReady, true);
    assert.deepEqual(cf.state.catchAll.actions, [{ type: "worker", value: ["ltm-email-service"] }]);
    assert.deepEqual(cf.state.subdomains.map(s => s.name), ["example.org"]);
    assert.equal(cf.state.txt[0].content, "\"v=DMARC1; p=none\"");
    assert.equal(await m.verifyAdminPassword(e, "correct horse"), true, "the administrator password is set");
    const withKey = { ...e, PROVIDER_CREDENTIAL_KEY: result.generatedKey };
    assert.deepEqual(await m.cloudflareConnection(withKey), { token: TOKEN, accountId: ACCOUNT, scriptName: "ltm-email-service" },
      "the connection is stored, encrypted with the new key");
    assert.equal(await m.cloudflareConnection(e), null, "unreadable without the key");
    assert.ok(!JSON.stringify(db.prepare("SELECT value FROM instance_keys").all()).includes(TOKEN), "the token is never stored in plain text");
    assert.equal(await m.validSetupGrant(e, result.grant), true, "the grant authorizes the passkey");
    assert.equal(await m.validSetupGrant(e, "x".repeat(43)), false);
    assert.equal((await m.domainRow(e, "example.org")).status, "active");
    const keys = await (await m.adminKeysResponse(withKey)).json();
    assert.deepEqual(keys.cloudflare, { connected: true, hint: `…${TOKEN.slice(-4)}`, accountId: ACCOUNT, worker: "ltm-email-service" });
    assert.ok(!JSON.stringify(keys).includes(TOKEN), "Admin → Keys never shows the token");

    // Repeating setup (passkey not created yet) keeps the domain; once a passkey exists it is closed.
    const again = await m.setupInstance(setupRequest({ domain: "other.org", adminPassword: "new password", cloudflareToken: TOKEN }), withKey);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).domain, "example.org", "the main domain never changes");
    db.exec("INSERT INTO auth_credentials (id, public_key, counter) VALUES ('cred', x'00', 0)");
    assert.equal((await m.setupInstance(setupRequest({ domain: "example.org", adminPassword: "pw12", cloudflareToken: TOKEN }), withKey)).status, 409);
  }

  // A token from another account is refused and changes nothing.
  {
    const db = database();
    globalThis.fetch = fakeCloudflare({ accounts: [OTHER], scripts: { [OTHER]: [] } }).fetch;
    const response = await m.setupInstance(setupRequest({ domain: "example.org", adminPassword: "correct horse", cloudflareToken: TOKEN }), env(db));
    assert.equal(response.status, 401);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM domains WHERE is_primary = 1").get().n, 0, "nothing initialized");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_credentials").get().n, 0);
  }

  // The setup secret still works for installs without a token (no Cloudflare calls).
  {
    const db = database();
    const cf = fakeCloudflare();
    globalThis.fetch = cf.fetch;
    const e = env(db, { AUTH_SETUP_TOKEN: "legacy-setup-secret" });
    assert.equal((await m.setupInstance(setupRequest({ domain: "example.org", adminPassword: "correct horse", setupToken: "wrong" }), e)).status, 401);
    const response = await m.setupInstance(setupRequest({ domain: "example.org", adminPassword: "correct horse", setupToken: "legacy-setup-secret" }), e);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.domainReport, null);
    assert.equal(result.generatedKey, null);
    assert.deepEqual(cf.state.calls.filter(call => !call.includes("dns-query")), []);
  }

  // Domain wiring: another provider's MX records need confirmation; nothing changes until then.
  {
    const connection = { token: TOKEN, accountId: ACCOUNT, scriptName: "ltm-email-service" };
    const foreign = { id: "gmx", name: "example.org", content: "aspmx.l.google.com", priority: 1 };
    const cf = fakeCloudflare({ mx: [foreign] });
    const report = await m.connectDomain(connection, "example.org", {}, cf.fetch);
    assert.deepEqual(report.mxConflict, [{ host: "aspmx.l.google.com", priority: 1 }]);
    assert.deepEqual(report.steps.map(step => `${step.id}:${step.status}`), ["zone:done", "mx:action"]);
    assert.deepEqual(cf.mutations(), [], "nothing is changed before the administrator confirms");
    const confirmed = await m.connectDomain(connection, "example.org", { replaceMx: true }, cf.fetch);
    assert.ok(cf.mutations().includes("DELETE /zones/zone1/dns_records/gmx"));
    assert.equal(confirmed.steps[1].status, "done");
    assert.equal(confirmed.routingReady, true);

    // Already set up: every step is skipped and nothing is written.
    const ready = fakeCloudflare({ routing: true, mx: [{ id: "mx1", name: "example.org", content: "route1.mx.cloudflare.net" }],
      catchAll: { enabled: true, actions: [{ type: "worker", value: ["ltm-email-service"] }] },
      subdomains: [{ name: "example.org" }], txt: [{ name: "_dmarc.example.org", content: "v=DMARC1; p=quarantine" }] });
    const skipped = await m.connectDomain(connection, "example.org", {}, ready.fetch);
    assert.deepEqual(skipped.steps.map(step => step.status), ["done", "skipped", "skipped", "skipped", "skipped"]);
    assert.deepEqual(ready.mutations(), []);

    // A failed step is reported and the others still run; receive-only domains skip sending.
    const noSending = fakeCloudflare({ sendingFails: true });
    const partial = await m.connectDomain(connection, "example.org", {}, noSending.fetch);
    assert.equal(partial.steps.find(step => step.id === "sending").status, "failed");
    assert.match(partial.steps.find(step => step.id === "sending").detail, /another mail service/);
    assert.equal(partial.steps.find(step => step.id === "dmarc").status, "done");
    const receiveOnly = await m.connectDomain(connection, "example.org", { sending: false }, fakeCloudflare().fetch);
    assert.ok(!receiveOnly.steps.some(step => step.id === "sending"));

    // A subdomain finds its parent zone; a domain outside the account is refused.
    const sub = await m.connectDomain(connection, "mail.example.org", { sending: false }, fakeCloudflare().fetch);
    assert.equal(sub.steps[0].detail, "Zone example.org");
    const missing = await m.connectDomain(connection, "elsewhere.net", {}, fakeCloudflare().fetch);
    assert.match(missing.steps[0].detail, /not in this Cloudflare account/);
  }

  // Adding a domain with a connection wires and activates it in the same request.
  {
    const db = database();
    db.exec("INSERT INTO domains (domain, status, is_primary) VALUES ('example.net', 'active', 1)");
    const cf = fakeCloudflare({ zones: [{ id: "zone2", name: "example.com", account: ACCOUNT }] });
    globalThis.fetch = cf.fetch;
    const key = Buffer.alloc(32, 7).toString("base64url");
    const e = env(db, { PROVIDER_CREDENTIAL_KEY: key });
    const request = body => new Request("https://mail.example.org/api/admin/domains", { method: "POST", body: JSON.stringify(body) });
    const plain = await (await m.createDomain(request({ domain: "example.com", connect: true }), e)).json();
    assert.equal(plain.report, undefined, "without a stored connection the domain is only added");
    assert.equal(plain.domain.status, "pending");
    db.exec("DELETE FROM domains WHERE domain = 'example.com'");
    const located = await m.locateWorker(e, TOKEN, cf.fetch);
    const { storeCloudflareConnection } = m;
    await storeCloudflareConnection(e, { token: TOKEN, ...located });
    const wired = await (await m.createDomain(request({ domain: "example.com", connect: true }), e)).json();
    assert.equal(wired.report.routingReady, true);
    assert.equal(wired.domain.status, "active", "Cloudflare confirmed routing, so the domain is active");
    const reconnect = await m.connectDomainRoute(new Request("https://mail.example.org/x", { method: "POST", body: "{}" }), e, "example.com");
    assert.equal(reconnect.status, 200);
    assert.equal((await m.connectDomainRoute(new Request("https://mail.example.org/x", { method: "POST", body: "{}" }), e, "nope.org")).status, 404);
  }

  console.log("PASS: Cloudflare token setup, encrypted connection, encryption key creation and domain wiring");
}

const out = mkdtempSync(join(tmpdir(), "ltm-cloudflare-setup-"));
try {
  const entry = join(out, "entry.ts");
  const src = new URL("../src/worker/", import.meta.url).pathname;
  writeFileSync(entry, `export { setupInstance } from "${src}setup.ts";
export { validSetupGrant } from "${src}setupGrants.ts";
export { createDomain, connectDomainRoute, domainRow } from "${src}domains.ts";
export { locateWorker, ensureCredentialKey } from "${src}cloudflare/connection.ts";
export { connectDomain } from "${src}cloudflare/domainConnect.ts";
export { cloudflareConnection, adminKeysResponse, storeCloudflareConnection } from "${src}storedKeys.ts";
export { verifyAdminPassword } from "${src}adminAuth.ts";`);
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*"], outfile: join(out, "bundle.mjs"),
    logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
