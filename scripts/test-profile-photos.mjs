// v3.10: every custom mailbox can have its own profile photo; account lists
// and the admin panel use the stored version, never an R2 lookup per mailbox.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { primaryProfilePath } from "../src/worker/accountAccess.ts";

function d1(db) {
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(row => ({ ...row })) }),
    first: async () => { const row = db.prepare(sql).get(...args); return row ? { ...row } : null; },
  });
  return { prepare: sql => statement(sql), batch: async list => { for (const s of list) await s.run(); return []; } };
}
function r2() {
  const objects = new Map();
  return {
    objects,
    put: async (key, body, options) => { objects.set(key, { body, ...options }); },
    get: async key => objects.has(key) ? { body: objects.get(key).body, httpMetadata: objects.get(key).httpMetadata } : null,
    head: async key => objects.has(key) ? { customMetadata: objects.get(key).customMetadata, etag: "etag1" } : null,
    delete: async key => { for (const k of [key].flat()) objects.delete(k); },
  };
}

async function run(m) {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter(file => file.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, dir), "utf8"));
  db.exec(`INSERT INTO native_mailboxes (id, email_address, display_name) VALUES ('native:admin', 'admin@example.com', 'Admin'), ('native:work', 'work@example.com', 'Work')`);
  const bucket = r2();
  const env = { DB: d1(db), MAIL: bucket, EMAIL: { send: async () => undefined } };
  const url = (id, path = "/api/profile/photo") => new URL(`https://mail.example.com${path}?accountId=${encodeURIComponent(id)}`);
  const upload = (type = "image/jpeg") => { const form = new FormData(); form.append("photo", new File([new Uint8Array([1, 2, 3])], "p.jpg", { type })); return new Request("https://mail.example.com/x", { method: "PUT", body: form }); };

  // Upgrade: admin@'s pre-v3.10 photo keeps its key and gets a version.
  await bucket.put("profile/avatar.jpg", new Uint8Array([9]), { customMetadata: { uploadedAt: "2026-01-01T00:00:00Z" } });
  await m.adoptLegacyProfilePhoto(env);
  assert.equal(db.prepare("SELECT photo_version FROM native_mailboxes WHERE id = 'native:admin'").get().photo_version, "2026-01-01T00:00:00Z");

  // A mailbox user sets, reads and removes their own photo.
  assert.equal((await m.listConnectedAccounts(env)).find(a => a.id === "native:work").avatarUrl, null, "no photo yet");
  assert.equal((await m.saveProfilePhoto(upload("image/gif"), env, url("native:work"))).status, 415);
  const saved = await (await m.saveProfilePhoto(upload(), env, url("native:work"))).json();
  assert.ok(saved.version);
  assert.ok(bucket.objects.has("profile/mailbox/native%3Awork.jpg"), "each mailbox has its own object");
  assert.equal((await m.getProfilePhoto(env, url("native:work"))).status, 200);
  assert.equal((await m.saveProfilePhoto(upload(), env, url("gmail:abc"))).status, 400, "Gmail avatars come from Google");
  assert.equal((await m.getProfilePhoto(env, url("native:missing"))).status, 404);

  // Account lists (switcher, Settings) and the admin mailbox list carry the photo.
  const accounts = await m.listConnectedAccounts(env);
  const work = accounts.find(a => a.id === "native:work");
  assert.equal(work.avatarUrl, `/api/profile/photo?accountId=native%3Awork&v=${encodeURIComponent(saved.version)}`);
  assert.match(accounts.find(a => a.id === "native:admin").avatarUrl, /accountId=native%3Aadmin/);
  assert.equal((await m.allNativeMailboxes(env)).find(b => b.id === "native:work").photo_version, saved.version);

  assert.equal((await m.deleteProfilePhoto(env, url("native:work"))).status, 200);
  assert.ok(!bucket.objects.has("profile/mailbox/native%3Awork.jpg"));
  assert.equal((await m.listConnectedAccounts(env)).find(a => a.id === "native:work").avatarUrl, null);
}

// Authorization: photo routes are checked against the mailbox in ?accountId=.
assert.equal(primaryProfilePath("/api/profile/photo"), true);
const router = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
assert.match(router, /primaryProfilePath\(url\.pathname\) && !\(await deviceAuthorized\(request, env, profileMailboxId\(url\)\)\)/);
assert.match(readFileSync(new URL("../src/client/components/MailboxManager.tsx", import.meta.url), "utf8"), /box\.photo_version \? \(/,
  "the admin panel shows a mailbox's photo when it has one");

const out = mkdtempSync(join(tmpdir(), "ltm-photos-"));
try {
  const entry = join(out, "entry.ts");
  const src = new URL("../src/worker/", import.meta.url).pathname;
  writeFileSync(entry, `export * from "${src}api/profile.ts"; export { listConnectedAccounts } from "${src}providers/registry.ts"; export { allNativeMailboxes } from "${src}mailboxes.ts";`);
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*"],
    outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
console.log("PASS: per-mailbox profile photos are stored, listed and authorized per mailbox");
