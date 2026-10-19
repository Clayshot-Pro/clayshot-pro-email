import { toBase64Url } from "./providers/crypto";
import { tokenHash } from "./deviceAuth";

/**
 * Short-lived grants for registering the owner passkey after first-run setup
 * was authorized with a Cloudflare API token (v3.12). Stored hashed; all are
 * removed once the passkey exists.
 */
const GRANT_MINUTES = 30;

export async function issueSetupGrant(env: Env): Promise<string> {
  const grant = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM setup_grants WHERE expires_at <= datetime('now')"),
    env.DB.prepare("INSERT INTO setup_grants (token_hash, expires_at) VALUES (?1, datetime('now', ?2))")
      .bind(await tokenHash(grant), `+${GRANT_MINUTES} minutes`),
  ]);
  return grant;
}

export async function validSetupGrant(env: Env, supplied: unknown): Promise<boolean> {
  if (typeof supplied !== "string" || !/^[\w-]{40,64}$/.test(supplied)) return false;
  const row = await env.DB.prepare("SELECT 1 AS ok FROM setup_grants WHERE token_hash = ?1 AND expires_at > datetime('now')")
    .bind(await tokenHash(supplied)).first<{ ok: number }>().catch(() => null);
  return Boolean(row);
}

export async function clearSetupGrants(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM setup_grants").run().catch(() => undefined);
}
