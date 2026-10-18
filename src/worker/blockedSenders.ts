import { MAX_BLOCKED_SENDERS, blockPattern, senderPatterns } from "./blockedSenderRules";
import { mailboxById } from "./mailboxes";

/**
 * Per-mailbox blocked senders (v3.09). Inbound mail from a blocked address or
 * domain is delivered to Junk; nothing is bounced, so senders are not told.
 * Custom (native) mailboxes only: the Gmail permission in use cannot create
 * Gmail filters. Routes are authorized per account like the mail API.
 */
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** True when any of the sender addresses (header From, envelope) is blocked. */
export async function isBlockedSender(env: Env, mailboxId: string, addresses: Array<string | null | undefined>): Promise<boolean> {
  const patterns = [...new Set(addresses.flatMap(address => address ? senderPatterns(address) : []))];
  if (!patterns.length) return false;
  const row = await env.DB.prepare(`SELECT 1 FROM blocked_senders WHERE mailbox_id = ?1 AND pattern IN (${patterns.map((_, i) => `?${i + 2}`).join(",")}) LIMIT 1`)
    .bind(mailboxId, ...patterns).first().catch(() => null);
  return Boolean(row);
}

async function nativeMailbox(env: Env, url: URL): Promise<string | Response> {
  const id = url.searchParams.get("accountId")?.trim() ?? "";
  if (!id.startsWith("native:")) return reply({ error: "Blocking senders is available for custom mailboxes. Use Gmail's own block for Gmail accounts." }, 400);
  const box = await mailboxById(env, id);
  if (!box || box.status !== "active" || box.deleted_at) return reply({ error: "Mailbox unavailable" }, 404);
  return box.id;
}

async function list(env: Env, mailboxId: string) {
  const { results } = await env.DB.prepare("SELECT pattern, created_at FROM blocked_senders WHERE mailbox_id = ?1 ORDER BY created_at DESC, pattern")
    .bind(mailboxId).all<{ pattern: string; created_at: string }>();
  return results.map(row => ({ pattern: row.pattern, createdAt: row.created_at }));
}

/** GET /api/blocked-senders?accountId= */
export async function listBlockedSenders(env: Env, url: URL): Promise<Response> {
  const mailboxId = await nativeMailbox(env, url);
  if (mailboxId instanceof Response) return mailboxId;
  return reply({ blocked: await list(env, mailboxId) });
}

/** POST /api/blocked-senders?accountId= { sender, moveExisting } */
export async function addBlockedSender(request: Request, env: Env, url: URL): Promise<Response> {
  const mailboxId = await nativeMailbox(env, url);
  if (mailboxId instanceof Response) return mailboxId;
  const body = await request.json<{ sender?: unknown; moveExisting?: unknown }>().catch(() => null);
  const pattern = blockPattern(body?.sender);
  if (!pattern) return reply({ error: "Enter an email address or a domain such as example.com" }, 400);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM blocked_senders WHERE mailbox_id = ?1").bind(mailboxId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_BLOCKED_SENDERS) return reply({ error: `A mailbox can block at most ${MAX_BLOCKED_SENDERS} senders` }, 409);
  await env.DB.prepare("INSERT OR IGNORE INTO blocked_senders (mailbox_id, pattern) VALUES (?1, ?2)").bind(mailboxId, pattern).run();
  let moved = 0;
  if (body?.moveExisting !== false) {
    // Existing inbound mail from the sender moves to Junk too. Domains are
    // validated to [a-z0-9.-], so they are safe inside LIKE.
    const match = pattern.startsWith("@")
      ? "(lower(from_address) LIKE '%' || ?2 OR lower(from_address) LIKE '%.' || ?3)"
      : "lower(from_address) = ?2";
    const statement = env.DB.prepare(`UPDATE messages SET is_junk = 1 WHERE mailbox_id = ?1 AND direction = 'inbound' AND is_junk = 0 AND ${match}`);
    const result = await (pattern.startsWith("@") ? statement.bind(mailboxId, pattern, pattern.slice(1)) : statement.bind(mailboxId, pattern)).run();
    moved = result.meta?.changes ?? 0;
  }
  return reply({ blocked: await list(env, mailboxId), moved }, 201);
}

/** DELETE /api/blocked-senders?accountId=&pattern= */
export async function removeBlockedSender(env: Env, url: URL): Promise<Response> {
  const mailboxId = await nativeMailbox(env, url);
  if (mailboxId instanceof Response) return mailboxId;
  const pattern = blockPattern(url.searchParams.get("pattern"));
  if (!pattern) return reply({ error: "Invalid sender" }, 400);
  await env.DB.prepare("DELETE FROM blocked_senders WHERE mailbox_id = ?1 AND pattern = ?2").bind(mailboxId, pattern).run();
  return reply({ blocked: await list(env, mailboxId) });
}
