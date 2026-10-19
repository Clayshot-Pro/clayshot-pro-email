import { ownerSessionHash } from "./auth";
import { currentDeviceSession } from "./deviceAuth";
import { mailboxForRecipient } from "./mailboxes";
import { buildPushPayload, type PushSubscription } from "@block65/webcrypto-web-push";
import { vapidPair, type VapidPair } from "./vapid";

type StoredSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: number | null;
  device_session_id: string | null;
  owner_session_hash: string | null;
};
type SubscriptionInput = {
  endpoint?: unknown;
  expirationTime?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
};
export type NewMailPush = {
  id: string;
  subject: string;
  fromAddress: string;
  fromName?: string | null;
  toAddress: string;
  preview?: string | null;
};

/** VAPID contact: the admin mailbox from D1. */
async function vapidSubject(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT email_address FROM native_mailboxes WHERE id = 'native:admin'")
    .first<{ email_address: string }>().catch(() => null);
  return `mailto:${row?.email_address ?? "postmaster@localhost"}`;
}
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_ENDPOINT_LENGTH = 2048;
const PUSH_HOSTS = ["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com"];

function vapidKeys(env: Env): VapidPair | null {
  return vapidPair(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
}

function validEndpoint(value: string): boolean {
  if (!value || value.length > MAX_ENDPOINT_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && PUSH_HOSTS.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const notificationText = (value: string | null | undefined, max: number) =>
  (value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);

function notificationCopy(notification: NewMailPush) {
  const subject = notificationText(notification.subject, 120) || "(no subject)";
  const fromAddress = notificationText(notification.fromAddress, 160) || "Unknown sender";
  const fromName = notificationText(notification.fromName, 100);
  const sender = fromName && fromName.toLowerCase() !== fromAddress.toLowerCase()
    ? `${fromName} <${fromAddress}>`
    : fromAddress;
  const mailbox = notificationText(notification.toAddress, 160) || "your mailbox";
  const preview = notificationText(notification.preview, 180);
  const routingLine = `${sender} → ${mailbox}`;
  return {
    title: subject,
    body: preview ? `${routingLine}\n${preview}` : routingLine,
  };
}

export function pushConfig(env: Env): Response {
  const keys = vapidKeys(env);
  return Response.json({ configured: Boolean(keys), publicKey: keys?.publicKey ?? null });
}

export async function subscribePush(request: Request, env: Env): Promise<Response> {
  if (!vapidKeys(env)) return Response.json({ error: "Push notifications are not configured" }, { status: 503 });
  const body = await request.json<SubscriptionInput>().catch(() => null);
  if (!body) return Response.json({ error: "Invalid subscription payload" }, { status: 400 });
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh.trim() : "";
  const auth = typeof body.keys?.auth === "string" ? body.keys.auth.trim() : "";
  const expirationTime = typeof body.expirationTime === "number" && Number.isFinite(body.expirationTime)
    ? Math.floor(body.expirationTime)
    : null;
  if (!validEndpoint(endpoint) || p256dh.length < 40 || p256dh.length > 128 || auth.length < 16 || auth.length > 64 || !BASE64URL.test(p256dh) || !BASE64URL.test(auth)) {
    return Response.json({ error: "Invalid push subscription" }, { status: 400 });
  }
  const [device, ownerHash] = await Promise.all([
    currentDeviceSession(request, env),
    ownerSessionHash(request, env),
  ]);
  if (!device && !ownerHash) return Response.json({ error: "No verified device session" }, { status: 401 });
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO push_subscriptions
    (id,endpoint,p256dh,auth,expiration_time,created_at,updated_at,device_session_id,owner_session_hash)
    VALUES (?1,?2,?3,?4,?5,?6,?6,?7,?8)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh=excluded.p256dh,auth=excluded.auth,expiration_time=excluded.expiration_time,
      updated_at=excluded.updated_at,device_session_id=excluded.device_session_id,
      owner_session_hash=excluded.owner_session_hash`)
    .bind(id, endpoint, p256dh, auth, expirationTime, now, device?.id ?? null, ownerHash)
    .run();
  return Response.json({ ok: true }, { status: 201 });
}

export async function unsubscribePush(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ endpoint?: unknown }>().catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!validEndpoint(endpoint)) return Response.json({ error: "Invalid endpoint" }, { status: 400 });
  const [device, ownerHash] = await Promise.all([
    currentDeviceSession(request, env), ownerSessionHash(request, env),
  ]);
  await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint=?1 AND
    ((device_session_id=?2 AND ?2 IS NOT NULL) OR (owner_session_hash=?3 AND ?3 IS NOT NULL))`)
    .bind(endpoint,device?.id ?? null,ownerHash).run();
  return Response.json({ ok: true });
}

async function sendToSubscription(env: Env, row: StoredSubscription, notification: NewMailPush): Promise<void> {
  const keys = vapidKeys(env);
  if (!keys || !validEndpoint(row.endpoint)) return;
  const subscription: PushSubscription = {
    endpoint: row.endpoint,
    expirationTime: row.expiration_time,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
  const copy = notificationCopy(notification);
  const payload = await buildPushPayload({
    data: JSON.stringify({
      title: copy.title,
      body: copy.body,
      tag: `message-${notification.id}`,
      url: "/",
    }),
    // High urgency: Android otherwise holds normal pushes while the phone is
    // idle (Doze). A day of TTL still delivers to a phone that was offline.
    options: { ttl: 86_400, urgency: "high" },
  }, subscription, {
    subject: await vapidSubject(env),
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  });
  const response = await fetch(row.endpoint, payload);
  if (response.status === 404 || response.status === 410) {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1").bind(row.endpoint).run();
    return;
  }
  if (!response.ok) {
    // The push service's reason (e.g. Apple's BadJwtToken) says what to fix; never the endpoint itself.
    const reason = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    console.warn("Push delivery failed", new URL(row.endpoint).hostname, response.status, reason);
  }
}

export async function sendNewMailPush(env: Env, notification: NewMailPush): Promise<void> {
  if (!vapidKeys(env)) return;
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE expiration_time IS NOT NULL AND expiration_time <= ?1").bind(Date.now()).run();
  const mailbox = await mailboxForRecipient(env, notification.toAddress);
  if (!mailbox) return;
  // Historical unscoped subscriptions are intentionally excluded. Each
  // notification must be visible to the mailbox logged in on that device.
  const subscriptions = await env.DB.prepare(`SELECT p.id,p.endpoint,p.p256dh,p.auth,p.expiration_time,
      p.device_session_id,p.owner_session_hash
    FROM push_subscriptions p
    WHERE (
      p.device_session_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM device_session_accounts g
        JOIN device_sessions s ON s.id=g.session_id AND s.expires_at>datetime('now')
        WHERE g.session_id=p.device_session_id AND g.account_id=?1 AND g.provider='native'
      )
    ) OR (
      p.owner_session_hash IS NOT NULL AND EXISTS (
        SELECT 1 FROM auth_sessions a WHERE a.token_hash=p.owner_session_hash AND a.expires_at>datetime('now')
      )
    )
    ORDER BY p.updated_at DESC LIMIT 100`)
    .bind(mailbox.id).all<StoredSubscription>();
  await Promise.allSettled(subscriptions.results.map(row => sendToSubscription(env, row, notification)));
}
