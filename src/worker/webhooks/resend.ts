import { appConfig } from "../appConfig";
import { authRateLimitBucket, checkAuthRateLimit } from "../security";
import { eventEffect, shouldReplaceStatus, suppressionTargets, verifySvix, type ResendEvent } from "./resendEvents";

const MAX_BODY_BYTES = 256 * 1024;
const reply = (body: Record<string, unknown>, status = 200) => Response.json(body, { status });

/** POST /api/webhooks/resend: server-to-server, authenticated by Svix signature only. */
export async function resendWebhook(request: Request, env: Env): Promise<Response> {
  const secret = env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret || !appConfig(env).features.resendWebhook) return reply({ error: "Unauthorized" }, 401);
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return reply({ error: "Payload too large" }, 413);
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return reply({ error: "Payload too large" }, 413);

  const headers = {
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
  };
  // Verified events are never throttled (Resend sends several per message);
  // failed verifications are limited per source IP so they cannot starve them.
  if (!(await verifySvix(secret, headers, body, Math.floor(Date.now() / 1000)))) {
    const allowed = await checkAuthRateLimit(env, authRateLimitBucket(request, "webhook:resend:invalid"));
    return allowed ? reply({ error: "Unauthorized" }, 401) : reply({ error: "Too many requests" }, 429);
  }

  // Replays of an already-processed event are acknowledged and ignored.
  const claimed = await env.DB.prepare("INSERT OR IGNORE INTO webhook_receipts (provider, event_id) VALUES ('resend', ?1)")
    .bind(headers.id).run();
  if (!claimed.meta.changes) return reply({ ok: true, duplicate: true });

  let event: ResendEvent;
  try { event = JSON.parse(body) as ResendEvent; } catch { return reply({ ok: true, ignored: "malformed" }); }
  const effect = eventEffect(event);
  const emailId = typeof event.data?.email_id === "string" ? event.data.email_id.slice(0, 200) : "";
  if (!effect || !emailId) return reply({ ok: true, ignored: "event" });

  const attempt = await env.DB.prepare(
    "SELECT mailbox_id, message_id FROM outbound_attempts WHERE transport = 'resend' AND provider_message_id = ?1 LIMIT 1",
  ).bind(emailId).first<{ mailbox_id: string; message_id: string | null }>();
  if (attempt) {
    const now = new Date().toISOString();
    const message = attempt.message_id
      ? await env.DB.prepare("SELECT delivery_status FROM messages WHERE id = ?1 AND mailbox_id = ?2")
        .bind(attempt.message_id, attempt.mailbox_id).first<{ delivery_status: string | null }>()
      : null;
    const statements = [
      env.DB.prepare(`UPDATE outbound_attempts SET last_event = ?2, last_event_at = ?3, updated_at = CURRENT_TIMESTAMP
        WHERE transport = 'resend' AND provider_message_id = ?1`).bind(emailId, effect.status, now),
    ];
    if (message && attempt.message_id && shouldReplaceStatus(message.delivery_status, effect.status)) {
      statements.push(env.DB.prepare("UPDATE messages SET delivery_status = ?3, delivery_event_at = ?4 WHERE id = ?1 AND mailbox_id = ?2")
        .bind(attempt.message_id, attempt.mailbox_id, effect.status, now));
    }
    await env.DB.batch(statements);
  }
  if (effect.suppress) {
    const targets = suppressionTargets(event);
    if (targets.length) {
      await env.DB.batch(targets.map(address => env.DB.prepare(
        "INSERT OR IGNORE INTO suppressed_recipients (address, reason, source) VALUES (?1, ?2, 'resend')",
      ).bind(address, effect.suppress)));
    }
  }
  return reply({ ok: true });
}

export async function pruneWebhookReceipts(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM webhook_receipts WHERE received_at < datetime('now', '-30 days')").run();
}

/** Admin: list, add and remove suppressed recipients. */
export async function listSuppressions(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT address, reason, source, created_at FROM suppressed_recipients ORDER BY created_at DESC LIMIT 500",
  ).all();
  return Response.json({ suppressions: rows.results });
}

export async function addSuppression(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ address?: unknown }>().catch(() => null);
  const address = typeof body?.address === "string" ? body.address.trim().toLowerCase() : "";
  if (!address || address.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) {
    return reply({ error: "Enter a valid email address" }, 400);
  }
  await env.DB.prepare("INSERT OR IGNORE INTO suppressed_recipients (address, reason, source) VALUES (?1, 'manual', 'admin')")
    .bind(address).run();
  return reply({ ok: true }, 201);
}

export async function removeSuppression(env: Env, address: string): Promise<Response> {
  const removed = await env.DB.prepare("DELETE FROM suppressed_recipients WHERE address = ?1")
    .bind(address.trim().toLowerCase()).run();
  return removed.meta.changes ? reply({ ok: true }) : reply({ error: "Not found" }, 404);
}
