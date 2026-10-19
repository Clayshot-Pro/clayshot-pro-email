// Integration keys in D1 (v3.06): Worker secrets win and are mirrored, VAPID
// is generated once, values are encrypted and never returned to the browser.
// Runs storedKeys.ts against migrations applied to node:sqlite.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { d1, migratedDatabase } from "./test-harness.mjs";

const out = mkdtempSync(join(tmpdir(), "ltm-stored-keys-"));
try {
  await build({
    entryPoints: [new URL("../src/worker/storedKeys.ts", import.meta.url).pathname],
    bundle: true, format: "esm", platform: "neutral", outfile: join(out, "storedKeys.mjs"), logLevel: "silent",
  });
  const keys = await import(pathToFileURL(join(out, "storedKeys.mjs")).href);
  await run(keys);
} finally {
  rmSync(out, { recursive: true, force: true });
}

/** Minimal D1 over node:sqlite: prepare().bind().run/all/first. */

function database() {
  const db = migratedDatabase();
  return db;
}

async function run(keys) {
  const { planKeys, validKeyValue, keyHint, withStoredKeys, adminKeysResponse, saveStoredKey, deleteStoredKey, encryptionKeyBackup,
    cloudflareConnection, deployCloudflareConnection, storeCloudflareConnection, removeCloudflareConnection } = keys;
  const credential = randomBytes(32).toString("base64url");
  const resend = "re_live_ABCDEFGH12345678";
  const put = value => new Request("https://mail.example.com/api/admin/keys/x", { method: "PUT", body: JSON.stringify({ value }) });

  // Pure planning: Worker secrets win and are mirrored when D1 differs.
  const plan = planKeys(new Map([["RESEND_API_KEY", "re_old_value_1234"], ["GOOGLE_CLIENT_ID", "1-abc.apps.googleusercontent.com"]]),
    { RESEND_API_KEY: ` ${resend} ` });
  assert.equal(plan.values.RESEND_API_KEY, resend);
  assert.equal(plan.values.GOOGLE_CLIENT_ID, "1-abc.apps.googleusercontent.com");
  assert.deepEqual(plan.writes, [{ name: "RESEND_API_KEY", value: resend }]);
  assert.equal(plan.vapid, null, "no VAPID pair yet");
  assert.deepEqual(planKeys(new Map([["RESEND_API_KEY", resend]]), { RESEND_API_KEY: resend }).writes, [], "unchanged secrets are not rewritten");

  assert.equal(validKeyValue("RESEND_API_KEY", resend), true);
  assert.equal(validKeyValue("RESEND_API_KEY", "sk_wrong"), false);
  assert.equal(validKeyValue("RESEND_WEBHOOK_SECRET", `whsec_${randomBytes(24).toString("base64")}`), true);
  assert.equal(validKeyValue("GOOGLE_CLIENT_ID", "123-abc.apps.googleusercontent.com"), true);
  assert.equal(validKeyValue("GOOGLE_CLIENT_SECRET", "has space"), false);
  assert.equal(validKeyValue("CF_EMAIL_SENDING_TOKEN", "short"), false);
  assert.equal(keyHint("RESEND_API_KEY", resend), "…5678", "hints show only the last four characters");

  // Without a valid PROVIDER_CREDENTIAL_KEY nothing is read or written.
  const plainDb = database();
  const plain = { DB: d1(plainDb), RESEND_API_KEY: resend };
  assert.equal(await withStoredKeys(plain), plain);
  assert.equal(plainDb.prepare("SELECT COUNT(*) AS n FROM instance_keys").get().n, 0);

  // Upgrade: Worker secrets are mirrored and a VAPID pair is generated once.
  const db = database();
  const upgraded = await withStoredKeys({ DB: d1(db), PROVIDER_CREDENTIAL_KEY: credential, RESEND_API_KEY: resend });
  assert.equal(upgraded.RESEND_API_KEY, resend);
  assert.equal(upgraded.VAPID_PUBLIC_KEY.length, 87);
  assert.equal(upgraded.VAPID_PRIVATE_KEY.length, 43);
  const rows = db.prepare("SELECT name, value, hint FROM instance_keys ORDER BY name").all();
  assert.deepEqual(rows.map(row => row.name), ["RESEND_API_KEY", "VAPID"]);
  for (const row of rows) {
    assert.match(row.value, /^v1\./, `${row.name} is encrypted`);
    assert.ok(!row.value.includes(resend) && !row.value.includes(upgraded.VAPID_PRIVATE_KEY), "no plaintext in D1");
  }

  // The Worker secret is deleted: the mirrored value and the same VAPID pair remain.
  const env = { DB: d1(db), PROVIDER_CREDENTIAL_KEY: credential };
  const after = await withStoredKeys(env);
  assert.equal(after.RESEND_API_KEY, resend);
  assert.equal(after.VAPID_PUBLIC_KEY, upgraded.VAPID_PUBLIC_KEY, "VAPID is never regenerated");
  assert.equal(after.VAPID_PRIVATE_KEY, upgraded.VAPID_PRIVATE_KEY);
  assert.equal(await withStoredKeys(env), after, "cached per isolate");

  // A different PROVIDER_CREDENTIAL_KEY cannot read the rows.
  const wrong = await withStoredKeys({ DB: d1(db), PROVIDER_CREDENTIAL_KEY: randomBytes(32).toString("base64url") });
  assert.equal(wrong.RESEND_API_KEY, undefined);

  // Admin API: write-only values, Worker secrets are read-only here.
  const listing = await (await adminKeysResponse(after)).json();
  assert.equal(listing.encryption, true);
  assert.deepEqual(listing.keys.find(key => key.name === "RESEND_API_KEY"), { name: "RESEND_API_KEY", source: "stored", hint: "…5678" });
  assert.equal(listing.push.source, "stored");
  assert.ok(!JSON.stringify(listing).includes(resend) && !JSON.stringify(listing).includes(after.VAPID_PRIVATE_KEY), "values never leave the Worker");

  const google = "123456-abcdef.apps.googleusercontent.com";
  assert.equal((await saveStoredKey(put(google), after, "GOOGLE_CLIENT_ID")).status, 200);
  assert.equal((await saveStoredKey(put("not a key"), after, "GOOGLE_CLIENT_SECRET")).status, 400);
  assert.equal((await saveStoredKey(put("x"), after, "VAPID")).status, 404, "VAPID is managed automatically");
  assert.equal((await saveStoredKey(put(google), after, "AUTH_SETUP_TOKEN")).status, 404);
  assert.equal((await withStoredKeys(env)).GOOGLE_CLIENT_ID, google, "a save refreshes this isolate at once");

  const withSecret = await withStoredKeys({ DB: d1(db), PROVIDER_CREDENTIAL_KEY: credential, GOOGLE_CLIENT_SECRET: "GOCSPX-workersecret" });
  assert.equal((await saveStoredKey(put("GOCSPX-replacement"), withSecret, "GOOGLE_CLIENT_SECRET")).status, 409);
  assert.equal((await deleteStoredKey(withSecret, "GOOGLE_CLIENT_SECRET")).status, 409);
  const secretListing = await (await adminKeysResponse(withSecret)).json();
  assert.equal(secretListing.keys.find(key => key.name === "GOOGLE_CLIENT_SECRET").source, "worker");

  assert.equal((await deleteStoredKey(after, "GOOGLE_CLIENT_ID")).status, 200);
  assert.equal((await withStoredKeys(env)).GOOGLE_CLIENT_ID, undefined);

  const noEncryption = { DB: d1(database()) };
  assert.equal((await saveStoredKey(put(google), noEncryption, "GOOGLE_CLIENT_ID")).status, 409);

  // The table only accepts known names.
  assert.throws(() => db.prepare("INSERT INTO instance_keys (name, value) VALUES ('AUTH_SETUP_TOKEN', 'x')").run());

  // The encryption key backup (behind a passkey approval) returns the Worker secret, and only a valid one.
  {
    const shown = await encryptionKeyBackup(await withStoredKeys({ DB: d1(db), PROVIDER_CREDENTIAL_KEY: credential }));
    assert.equal(shown.status, 200);
    assert.equal((await shown.json()).key, credential);
    assert.equal(shown.headers.get("cache-control"), "no-store");
    assert.equal((await encryptionKeyBackup({ DB: d1(db) })).status, 404, "no key set");
    assert.equal((await encryptionKeyBackup({ DB: d1(db), PROVIDER_CREDENTIAL_KEY: "not-a-key" })).status, 404, "an invalid key is not shown");
  }

  // v3.22: the deploy's own token is used when no token is connected in Admin → Keys.
  {
    const deployed = { token: "d".repeat(40), accountId: "a".repeat(32), scriptName: "mail" };
    const secret = JSON.stringify(deployed);
    const fresh = { DB: d1(db), CLOUDFLARE_DEPLOY_CONNECTION: secret };
    assert.deepEqual(deployCloudflareConnection(fresh), deployed);
    assert.deepEqual(await cloudflareConnection(fresh), deployed, "works without an encryption key");
    const listed = (await (await adminKeysResponse(fresh)).json()).cloudflare;
    assert.deepEqual(listed, { connected: true, source: "deploy", hint: "…dddd", accountId: deployed.accountId, worker: "mail" });
    assert.doesNotMatch(JSON.stringify(listed), /d{8}/, "the token is never listed");
    for (const bad of ["", "{", JSON.stringify({ ...deployed, token: "short" }), JSON.stringify({ ...deployed, accountId: "x" }),
      JSON.stringify({ ...deployed, scriptName: "" }), JSON.stringify([deployed])]) {
      assert.equal(deployCloudflareConnection({ DB: d1(db), CLOUDFLARE_DEPLOY_CONNECTION: bad }), null, bad);
    }
    // A token connected in Admin → Keys wins; removing it falls back to the deploy's.
    const both = { DB: d1(db), PROVIDER_CREDENTIAL_KEY: credential, CLOUDFLARE_DEPLOY_CONNECTION: secret };
    const own = { token: "o".repeat(40), accountId: "b".repeat(32), scriptName: "mail" };
    await storeCloudflareConnection(both, own);
    assert.deepEqual(await cloudflareConnection(both), own);
    assert.equal((await (await adminKeysResponse(both)).json()).cloudflare.source, "stored");
    await removeCloudflareConnection(both);
    assert.deepEqual(await cloudflareConnection(both), deployed);
    assert.equal(await cloudflareConnection({ DB: d1(db), PROVIDER_CREDENTIAL_KEY: credential }), null, "neither: not connected");
  }
  console.log("PASS: stored keys are encrypted, write-only, mirrored from Worker secrets, VAPID generated once");
}
