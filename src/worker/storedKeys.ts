import type { CloudflareConnection } from "./cloudflare/connection";
import { credentialEncryptionAvailable, decryptSecret, encryptSecret, toBase64Url } from "./providers/crypto";
import { vapidPair, type VapidPair } from "./vapid";

/**
 * Integration keys stored in D1 (v3.06), encrypted with the
 * PROVIDER_CREDENTIAL_KEY Worker secret. A Worker secret with the same name
 * still wins and is mirrored into D1, so deleting it later keeps the latest
 * value. The VAPID pair is one row so it can never mismatch, and is generated
 * when neither D1 nor the Worker has one. The Cloudflare connection (v3.12) is
 * one row too: token, account and Worker name together.
 */
export const EDITABLE_KEYS = [
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "CF_EMAIL_SENDING_TOKEN",
] as const;
export type EditableKey = typeof EDITABLE_KEYS[number];
type StoredName = EditableKey | "VAPID" | "CLOUDFLARE";
type StoredValue = string | VapidPair | CloudflareConnection;
export type KeySource = "worker" | "stored" | "none";

const FORMATS: Record<EditableKey, RegExp> = {
  GOOGLE_CLIENT_ID: /^[A-Za-z0-9._-]{1,200}\.apps\.googleusercontent\.com$/,
  GOOGLE_CLIENT_SECRET: /^[\x21-\x7e]{8,256}$/,
  RESEND_API_KEY: /^re_[A-Za-z0-9_]{8,256}$/,
  RESEND_WEBHOOK_SECRET: /^whsec_[A-Za-z0-9+/=]{8,256}$/,
  CF_EMAIL_SENDING_TOKEN: /^[A-Za-z0-9_-]{20,256}$/,
};

export const isEditableKey = (name: string): name is EditableKey => (EDITABLE_KEYS as readonly string[]).includes(name);

export function validKeyValue(name: EditableKey, value: string): boolean {
  return FORMATS[name].test(value);
}

/** A short, non-secret fragment shown in the admin panel. */
export function keyHint(name: StoredName, value: StoredValue): string {
  if (typeof value !== "string") return "token" in value ? `…${value.token.slice(-4)}` : `${value.publicKey.slice(0, 8)}…`;
  return name === "GOOGLE_CLIENT_ID" ? `${value.slice(0, 8)}…` : `…${value.slice(-4)}`;
}

const workerValue = (env: Record<string, unknown>, name: EditableKey): string =>
  typeof env[name] === "string" ? (env[name] as string).trim() : "";

export type KeyPlan = {
  values: Partial<Record<EditableKey, string>>;
  vapid: VapidPair | null;
  /** Worker secrets not yet mirrored into D1 (or changed since). */
  writes: Array<{ name: StoredName; value: StoredValue }>;
};

/** Pure: effective values and the D1 writes needed, given stored rows and Worker secrets. */
export function planKeys(stored: Map<StoredName, StoredValue>, env: Record<string, unknown>): KeyPlan {
  const plan: KeyPlan = { values: {}, vapid: null, writes: [] };
  for (const name of EDITABLE_KEYS) {
    const fromWorker = workerValue(env, name);
    const fromStore = stored.get(name);
    if (fromWorker) {
      plan.values[name] = fromWorker;
      if (fromStore !== fromWorker) plan.writes.push({ name, value: fromWorker });
    } else if (typeof fromStore === "string" && fromStore) {
      plan.values[name] = fromStore;
    }
  }
  const workerPair = vapidPair(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const storedPair = stored.get("VAPID");
  const validStored = typeof storedPair === "object" && "publicKey" in storedPair ? vapidPair(storedPair.publicKey, storedPair.privateKey) : null;
  if (workerPair) {
    plan.vapid = workerPair;
    if (validStored?.publicKey !== workerPair.publicKey || validStored.privateKey !== workerPair.privateKey) {
      plan.writes.push({ name: "VAPID", value: workerPair });
    }
  } else {
    plan.vapid = validStored;
  }
  return plan;
}

const aad = (name: StoredName) => `instance-key:${name}`;

async function readStored(env: Env): Promise<Map<StoredName, StoredValue>> {
  const { results } = await env.DB.prepare("SELECT name, value FROM instance_keys").all<{ name: StoredName; value: string }>();
  const stored = new Map<StoredName, StoredValue>();
  for (const row of results) {
    try {
      stored.set(row.name, await decryptSecret<StoredValue>(env, row.value, aad(row.name)));
    } catch {
      // A changed PROVIDER_CREDENTIAL_KEY or a tampered row: skip it, never log values.
      console.error("stored_key_unreadable", row.name);
    }
  }
  return stored;
}

async function writeStored(env: Env, name: StoredName, value: StoredValue, onlyIfMissing = false): Promise<void> {
  const conflict = onlyIfMissing
    ? "DO NOTHING"
    : "DO UPDATE SET value = excluded.value, hint = excluded.hint, updated_at = CURRENT_TIMESTAMP";
  await env.DB.prepare(`INSERT INTO instance_keys (name, value, hint) VALUES (?1, ?2, ?3) ON CONFLICT(name) ${conflict}`)
    .bind(name, await encryptSecret(env, value, aad(name)), keyHint(name, value)).run();
}

async function generateVapidPair(): Promise<VapidPair> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
  return { publicKey: toBase64Url(publicKey), privateKey: d ?? "" };
}

/** Generate once; concurrent isolates keep whichever pair was stored first. */
async function ensureVapid(env: Env): Promise<VapidPair | null> {
  await writeStored(env, "VAPID", await generateVapidPair(), true);
  const stored = (await readStored(env)).get("VAPID");
  return typeof stored === "object" && "publicKey" in stored ? vapidPair(stored.publicKey, stored.privateKey) : null;
}

async function resolveKeys(env: Env): Promise<Env> {
  if (!(await credentialEncryptionAvailable(env))) return env;
  const plan = planKeys(await readStored(env), env as unknown as Record<string, unknown>);
  for (const write of plan.writes) await writeStored(env, write.name, write.value);
  const vapid = plan.vapid ?? await ensureVapid(env);
  const resolved = {
    ...env,
    ...plan.values,
    ...(vapid ? { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey } : {}),
  } as Env;
  workerEnvs.set(resolved, env);
  return resolved;
}

const KEY_CACHE_MS = 60_000;
const cache = new WeakMap<object, { at: number; generation: number; env: Env }>();
const workerEnvs = new WeakMap<object, Env>();
let generation = 0;

/**
 * The Worker environment with stored keys applied. Cached per isolate for a
 * minute; an admin change refreshes this isolate at once. Falls back to the
 * plain environment if D1 or encryption is unavailable.
 */
export async function withStoredKeys(env: Env): Promise<Env> {
  const hit = cache.get(env);
  if (hit && hit.generation === generation && Date.now() - hit.at < KEY_CACHE_MS) return hit.env;
  const resolved = await resolveKeys(env).catch(error => {
    console.error("stored_keys_unavailable", error instanceof Error ? error.name : "unknown");
    return env;
  });
  cache.set(env, { at: Date.now(), generation, env: resolved });
  return resolved;
}

const workerEnv = (env: Env): Record<string, unknown> => (workerEnvs.get(env) ?? env) as unknown as Record<string, unknown>;

/** GET /api/admin/keys: where each key comes from, with a hint. Never values. */
export async function adminKeysResponse(env: Env): Promise<Response> {
  const worker = workerEnv(env);
  const { results } = await env.DB.prepare("SELECT name, hint FROM instance_keys").all<{ name: StoredName; hint: string }>()
    .catch(() => ({ results: [] as Array<{ name: StoredName; hint: string }> }));
  const hints = new Map(results.map(row => [row.name, row.hint]));
  const status = (name: StoredName, fromWorker: string) => {
    const source: KeySource = fromWorker ? "worker" : hints.has(name) ? "stored" : "none";
    return { name, source, hint: source === "worker" ? keyHint(name, fromWorker) : hints.get(name) ?? "" };
  };
  const workerPair = vapidPair(worker.VAPID_PUBLIC_KEY, worker.VAPID_PRIVATE_KEY);
  const connection = hints.has("CLOUDFLARE") ? await cloudflareConnection(env) : null;
  return Response.json({
    encryption: await credentialEncryptionAvailable(env),
    keys: EDITABLE_KEYS.map(name => status(name, workerValue(worker, name))),
    push: status("VAPID", workerPair?.publicKey ?? ""),
    cloudflare: connection
      ? { connected: true, hint: hints.get("CLOUDFLARE") ?? "", accountId: connection.accountId, worker: connection.scriptName }
      : { connected: false },
  }, { headers: { "Cache-Control": "no-store" } });
}

/** The stored Cloudflare connection, or null (none, or unreadable with the current key). */
export async function cloudflareConnection(env: Env): Promise<CloudflareConnection | null> {
  if (!(await credentialEncryptionAvailable(env))) return null;
  const row = await env.DB.prepare("SELECT value FROM instance_keys WHERE name = 'CLOUDFLARE'").first<{ value: string }>()
    .catch(() => null);
  if (!row) return null;
  try {
    const value = await decryptSecret<CloudflareConnection>(env, row.value, aad("CLOUDFLARE"));
    return value && typeof value.token === "string" && typeof value.accountId === "string" && typeof value.scriptName === "string" ? value : null;
  } catch {
    console.error("stored_key_unreadable", "CLOUDFLARE");
    return null;
  }
}

/** Store the connection. `env` must carry a valid PROVIDER_CREDENTIAL_KEY (possibly just created). */
export async function storeCloudflareConnection(env: Env, connection: CloudflareConnection): Promise<void> {
  await writeStored(env, "CLOUDFLARE", connection);
  generation++;
}

export async function removeCloudflareConnection(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM instance_keys WHERE name = 'CLOUDFLARE'").run();
  generation++;
}

async function editable(env: Env, name: string): Promise<Response | EditableKey> {
  if (!isEditableKey(name)) return Response.json({ error: "Unknown key" }, { status: 404 });
  if (workerValue(workerEnv(env), name)) {
    return Response.json({ error: `${name} is set as a Worker secret. Delete it under Worker → Settings → Variables & Secrets to manage it here.` }, { status: 409 });
  }
  if (!(await credentialEncryptionAvailable(env))) {
    return Response.json({ error: "Add PROVIDER_CREDENTIAL_KEY as a Worker secret before storing keys." }, { status: 409 });
  }
  return name;
}

/** PUT /api/admin/keys/:name { value } (administrator step-up). */
export async function saveStoredKey(request: Request, env: Env, name: string): Promise<Response> {
  const key = await editable(env, name);
  if (key instanceof Response) return key;
  const body = await request.json<{ value?: unknown }>().catch(() => null);
  const value = typeof body?.value === "string" ? body.value.trim() : "";
  if (!validKeyValue(key, value)) return Response.json({ error: `That is not a valid ${key}.` }, { status: 400 });
  await writeStored(env, key, value);
  generation++;
  return adminKeysResponse(env);
}

/** DELETE /api/admin/keys/:name (administrator step-up). */
export async function deleteStoredKey(env: Env, name: string): Promise<Response> {
  const key = await editable(env, name);
  if (key instanceof Response) return key;
  await env.DB.prepare("DELETE FROM instance_keys WHERE name = ?1").bind(key).run();
  generation++;
  return adminKeysResponse(env);
}
