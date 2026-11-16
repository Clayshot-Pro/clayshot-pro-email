import { jsonError } from "./http";
import { randomBase64Url, sha256Hex, toBase64Url } from "./bytes";
import { mailboxPasswordError } from "./mailboxPasswordPolicy";
import { preparePassword, checkPassword } from "./passwordCrypto";
import { isAuthenticated, logout as ownerLogout } from "./auth";
import { normalizeMailboxAddress } from "./mailboxRules";
import { adminLoginAddress, adminMailboxAddress, isAdministratorEmail } from "./config";
import { ADMIN_MAILBOX_ID } from "./mailboxIds";
import { accountRateLimitBucket, authRateLimitBucket, checkAuthRateLimit, clearAccountLoginFailures, countAccountLoginAttempt } from "./security";

import { addressRules, primaryDomain } from "./domains";
import { beginAdminLogin } from "./adminAuth";

const DEVICE_COOKIE = "__Host-ltm_device";
const OAUTH_COOKIE = "__Host-ltm_oauth";
const DEVICE_LIFETIME = 60 * 60 * 24 * 30;

type DeviceSessionRow = { id: string; token_hash: string; main_account_id: string | null };
export type DeviceGrant = { account_id: string; provider: "native" | "gmail" };

export { sha256Hex as tokenHash } from "./bytes";
function readCookie(request: Request, key: string): string | null {
  for (const pair of (request.headers.get("Cookie") ?? "").split(";")) {
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index).trim() === key) return pair.slice(index + 1).trim();
  }
  return null;
}
function cookie(name: string, value: string, age: number, sameSite: "Lax" | "Strict" = "Lax"): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=${age}`;
}
const deviceCookie = (value: string) => cookie(DEVICE_COOKIE, value, DEVICE_LIFETIME);
const clearDeviceCookie = () => cookie(DEVICE_COOKIE, "", 0);
const oauthCookie = (value: string) => cookie(OAUTH_COOKIE, value, 600);
export const clearOAuthCookie = () => cookie(OAUTH_COOKIE, "", 0);
export function prepareOAuthNonce(): { nonce: string; setCookie: string } {
  const nonce = randomBase64Url();
  return { nonce, setCookie: oauthCookie(nonce) };
}
export async function oauthNonceMatches(request: Request, hash: string | null): Promise<boolean> {
  const nonce = readCookie(request, OAUTH_COOKIE);
  return Boolean(hash && nonce && /^[\w-]{30,100}$/.test(nonce) && await sha256Hex(nonce) === hash);
}

export async function credentialForMailbox(_id: string, password: string): Promise<{
  salt: string; hash: string; iterations: number;
}> {
  const invalid = mailboxPasswordError(password);
  if (invalid) throw new Error(invalid);
  return preparePassword(password, "mailbox");
}
/**
 * `keepOwnedLinks`: the person signed in to this mailbox is changing its own
 * password, so the inboxes they linked to it stay. An administrator's reset
 * (the default) also ends them: whoever has the new password has not been
 * given the other inboxes.
 */
export async function setMailboxPassword(env: Env, id: string, password: string, { keepOwnedLinks = false } = {}): Promise<void> {
  const invalid = mailboxPasswordError(password);
  if (invalid) throw new Error(invalid);
  // admin@ signs in with the administrator password and passkey only.
  if (id === ADMIN_MAILBOX_ID) throw new Error("The admin mailbox uses the administrator sign-in");
  const record = await env.DB.prepare(
    "SELECT id FROM native_mailboxes WHERE id=?1 AND status='active' AND deleted_at IS NULL"
  ).bind(id).first();
  if (!record) throw new Error("Mailbox unavailable");
  const value = await credentialForMailbox(id,password);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO native_mailbox_credentials (mailbox_id,password_salt,password_hash,iterations)
      VALUES (?1,?2,?3,?4) ON CONFLICT(mailbox_id) DO UPDATE SET
      password_salt=excluded.password_salt,password_hash=excluded.password_hash,
      iterations=excluded.iterations,updated_at=CURRENT_TIMESTAMP`)
      .bind(id,value.salt,value.hash,value.iterations),
    env.DB.prepare("DELETE FROM device_session_accounts WHERE account_id=?1 AND provider='native'").bind(id),
    forgetLinks(env, id, { keepOwned: keepOwnedLinks }),
  ]);
}
export async function rotateMailboxPassword(env: Env, id: string): Promise<string> {
  // 24 random bytes -> 32 base64url chars (192 bits of entropy).
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const password = toBase64Url(bytes);
  await setMailboxPassword(env,id,password);
  return password; // only displayed once to the verified owner.
}
async function checkNativePassword(env: Env, normalized: string | null, password: string): Promise<string | null> {
  const record = normalized ? await env.DB.prepare(`SELECT m.id, c.password_salt, c.password_hash, c.iterations
    FROM native_mailboxes m JOIN native_mailbox_credentials c ON c.mailbox_id=m.id
    WHERE m.email_address=?1 AND m.status='active' AND m.deleted_at IS NULL`)
    .bind(normalized).first<{id:string;password_salt:string;password_hash:string;iterations:number}>() : null;
  // The saved iterations value versions the hash. Existing positive values
  // continue through the legacy PBKDF2 verification path.
  return await checkPassword(password, record) ? record!.id : null;
}
export async function currentDeviceSession(request: Request, env: Env): Promise<DeviceSessionRow | null> {
  const t = readCookie(request, DEVICE_COOKIE);
  if (!t || !/^[\w-]{30,100}$/.test(t)) return null;
  return env.DB.prepare(`SELECT id,token_hash,main_account_id FROM device_sessions
    WHERE token_hash=?1 AND expires_at>datetime('now')`)
    .bind(await sha256Hex(t)).first<DeviceSessionRow>();
}
/**
 * Signs `accountId` in on this device. The first inbox on a device is its main
 * inbox; every inbox added later is linked to it, so logging out and signing
 * in again with the main inbox's password brings them all back. A new session
 * starts with the inboxes already linked to the inbox that opened it.
 */
async function establishDeviceGrant(request: Request, env: Env, accountId: string, provider: DeviceGrant["provider"]): Promise<string | null> {
  let session = await currentDeviceSession(request, env);
  let issued: string | null = null;
  if (!session) {
    issued = randomBase64Url();
    const id = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO device_sessions (id,token_hash,expires_at,user_agent,main_account_id)
      VALUES (?1,?2,datetime('now','+30 days'),?3,?4)`)
      .bind(id, await sha256Hex(issued), request.headers.get("User-Agent")?.slice(0, 300) ?? null, accountId).run();
    session = { id, token_hash: await sha256Hex(issued), main_account_id: accountId };
  } else if (!session.main_account_id) {
    // A session from before linking: its earliest inbox is the main one.
    const first = await env.DB.prepare("SELECT account_id FROM device_session_accounts WHERE session_id=?1 ORDER BY added_at,rowid LIMIT 1")
      .bind(session.id).first<{ account_id: string }>();
    session.main_account_id = first?.account_id ?? accountId;
    await env.DB.prepare("UPDATE device_sessions SET main_account_id=?2 WHERE id=?1").bind(session.id, session.main_account_id).run();
  }
  await env.DB.prepare(`INSERT OR IGNORE INTO device_session_accounts(session_id,account_id,provider)
    VALUES (?1,?2,?3)`).bind(session.id,accountId,provider).run();
  if (session.main_account_id !== accountId) {
    await env.DB.prepare("INSERT OR IGNORE INTO account_links (owner_account_id,linked_account_id,provider) VALUES (?1,?2,?3)")
      .bind(session.main_account_id, accountId, provider).run();
  } else if (issued) {
    await restoreLinkedAccounts(env, session.id, accountId);
  }
  return issued ? deviceCookie(issued) : null;
}
/** Signs the inboxes linked to a main inbox back in on a new session (only ones still usable). */
async function restoreLinkedAccounts(env: Env, sessionId: string, mainAccountId: string): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO device_session_accounts (session_id,account_id,provider)
    SELECT ?1,l.linked_account_id,l.provider FROM account_links l
    LEFT JOIN native_mailboxes n ON l.provider='native' AND n.id=l.linked_account_id
    LEFT JOIN connected_accounts a ON l.provider='gmail' AND a.id=l.linked_account_id
    WHERE l.owner_account_id=?2 AND (
      (l.provider='native' AND n.status='active' AND n.deleted_at IS NULL) OR
      (l.provider='gmail' AND a.status IN ('active','reauth_required')))`)
    .bind(sessionId, mainAccountId).run();
}
/** Unlink an inbox from this device's main inbox and sign it out here. It no longer returns at the next sign-in. */
export async function deviceUnlinkAccount(request: Request, env: Env, accountId: string): Promise<Response> {
  const session = await currentDeviceSession(request, env);
  if (!session) return jsonError("Session not found", 401);
  if (!session.main_account_id || session.main_account_id === accountId) {
    return jsonError("The main inbox cannot be unlinked; log out instead", 400);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM account_links WHERE owner_account_id=?1 AND linked_account_id=?2").bind(session.main_account_id, accountId),
    env.DB.prepare("DELETE FROM device_session_accounts WHERE session_id=?1 AND account_id=?2").bind(session.id, accountId),
  ]);
  return Response.json({ ok: true });
}
/** Statements that end every link to or from an inbox (disabled, deleted or its password reset). */
export const forgetLinks = (env: Env, id: string, { keepOwned = false } = {}) => keepOwned
  ? env.DB.prepare("DELETE FROM account_links WHERE linked_account_id=?1").bind(id)
  : env.DB.prepare("DELETE FROM account_links WHERE linked_account_id=?1 OR owner_account_id=?1").bind(id);
export async function grantGoogleDeviceSession(request: Request, env: Env, accountId: string): Promise<string | null> {
  return establishDeviceGrant(request, env, accountId, "gmail");
}
/**
 * The active custom-domain mailbox whose address a Google-verified email is, so
 * "Continue with Google" opens the app's own inbox instead of looking for a
 * Gmail one. The administrator's addresses never qualify: they need the
 * administrator password and passkey.
 */
export async function nativeMailboxForGoogleEmail(request: Request, env: Env, email: string): Promise<string | null> {
  const normalized = normalizeMailboxAddress(email, await addressRules(env, "routing"));
  if (!normalized || isAdministratorEmail(request, normalized, await primaryDomain(env))) return null;
  const row = await env.DB.prepare(`SELECT id FROM native_mailboxes
    WHERE email_address=?1 AND status='active' AND deleted_at IS NULL`).bind(normalized).first<{ id: string }>();
  return row?.id ?? null;
}
export async function grantNativeDeviceSession(request: Request, env: Env, mailboxId: string): Promise<string | null> {
  return establishDeviceGrant(request, env, mailboxId, "native");
}
export async function deviceAccountIds(request: Request, env: Env): Promise<string[]> {
  const session = await currentDeviceSession(request, env);
  if (!session) return [];
  const items = await env.DB.prepare(`SELECT g.account_id FROM device_session_accounts g
    LEFT JOIN native_mailboxes n ON g.provider='native' AND n.id=g.account_id
    LEFT JOIN connected_accounts a ON g.provider='gmail' AND a.id=g.account_id
    WHERE g.session_id=?1 AND (
      (g.provider='native' AND n.status='active' AND n.deleted_at IS NULL AND n.email_address NOT IN (?2,?3)) OR
      (g.provider='gmail' AND a.status IN ('active','reauth_required'))
    )`).bind(session.id, adminLoginAddress(request), adminMailboxAddress(await primaryDomain(env)) ?? "").all<{account_id:string}>();
  return items.results.map(i => i.account_id);
}
/**
 * A device stays signed in while it is used: once a session is more than a
 * week old, opening the app renews it for another 30 days with the same token.
 * A fixed lifetime signed phones out silently, and their push alerts stopped.
 */
async function renewDeviceSession(request: Request, env: Env): Promise<string | null> {
  const t = readCookie(request, DEVICE_COOKIE);
  if (!t || !/^[\w-]{30,100}$/.test(t)) return null;
  const renewed = await env.DB.prepare(`UPDATE device_sessions
    SET expires_at=datetime('now','+30 days'), last_seen_at=CURRENT_TIMESTAMP
    WHERE token_hash=?1 AND expires_at>datetime('now') AND expires_at<datetime('now','+23 days')`)
    .bind(await sha256Hex(t)).run();
  return renewed.meta.changes ? deviceCookie(t) : null;
}
export async function deviceStatus(request: Request, env: Env): Promise<Response> {
  const [ids, admin] = await Promise.all([deviceAccountIds(request, env), isAuthenticated(request, env)]);
  // Passkey sessions are privileged admin sessions and may open native mailboxes.
  const native = admin ? await env.DB.prepare("SELECT COUNT(*) AS count FROM native_mailboxes WHERE status='active' AND deleted_at IS NULL")
    .first<{count:number}>() : null;
  const renewal = ids.length ? await renewDeviceSession(request, env) : null;
  const session = await currentDeviceSession(request, env);
  const links = session?.main_account_id
    ? await env.DB.prepare("SELECT linked_account_id FROM account_links WHERE owner_account_id=?1").bind(session.main_account_id).all<{ linked_account_id: string }>()
    : null;
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (renewal) headers.append("Set-Cookie", renewal);
  return Response.json({
    authenticated: admin || ids.length > 0, isAdmin: admin, accountCount: ids.length + (native?.count ?? 0),
    // The inbox the others are linked to, and which inboxes are linked to it.
    mainAccountId: session?.main_account_id ?? null,
    linkedAccountIds: links?.results.map(row => row.linked_account_id) ?? [],
  }, { headers });
}
export async function deviceLogin(request: Request, env: Env): Promise<Response> {
  const input = await request.json<{ email?: unknown; password?: unknown }>().catch(() => null);
  const email = typeof input?.email === "string" ? input.email : "";
  const password = typeof input?.password === "string" ? input.password : "";
  if (!email || password.length > 128) return jsonError("Invalid credentials", 401);
  // The server decides whether this is the administrator sign-in (password +
  // passkey), so a client that posts admin@ here still gets the MFA flow.
  if (isAdministratorEmail(request, email, await primaryDomain(env))) {
    if (!(await checkAuthRateLimit(env, authRateLimitBucket(request, "/api/admin/login/password")))) {
      return jsonError("Too many authentication attempts", 429);
    }
    return beginAdminLogin(new Request(request.url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
    }), env);
  }
  if (!(await checkAuthRateLimit(env, authRateLimitBucket(request, "native-login")))) {
    return jsonError("Too many attempts. Try again later.", 429);
  }
  // One allowance per mailbox, however the address was typed ("work" or
  // "work@domain"). The account counter is incremented before the password
  // check (one atomic upsert), so parallel guesses cannot all pass; a success
  // clears it.
  const normalized = normalizeMailboxAddress(email, await addressRules(env, "routing"));
  const accountBucket = accountRateLimitBucket("native-login", normalized ?? email);
  if (!(await countAccountLoginAttempt(env, accountBucket))) {
    return jsonError("Too many attempts. Try again later.", 429);
  }
  const mailboxId = await checkNativePassword(env,normalized,password);
  if (!mailboxId) return jsonError("Invalid credentials", 401);
  await clearAccountLoginFailures(env, accountBucket);
  const setCookie = await establishDeviceGrant(request, env, mailboxId, "native");
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (setCookie) headers.append("Set-Cookie",setCookie);
  return Response.json({ ok: true, accountId: mailboxId }, { headers });
}
/**
 * POST /api/account/password: someone signed in to a mailbox on this device
 * changes its password with the current one. Other devices using the mailbox
 * are signed out; this device stays signed in. admin@ uses the administrator
 * password (Admin panel); Gmail passwords belong to Google.
 */
export async function changeOwnMailboxPassword(request: Request, env: Env): Promise<Response> {
  const input = await request.json<{ accountId?: unknown; currentPassword?: unknown; newPassword?: unknown }>().catch(() => null);
  const accountId = typeof input?.accountId === "string" ? input.accountId : "";
  const currentPassword = typeof input?.currentPassword === "string" ? input.currentPassword : "";
  if (accountId === ADMIN_MAILBOX_ID) return jsonError("The admin mailbox uses the administrator password. Change it in the admin panel.", 400);
  if (!accountId.startsWith("native:")) return jsonError("Only custom-domain mailboxes have a password here", 400);
  if (!(await deviceAccountIds(request, env)).includes(accountId)) {
    return jsonError("Sign in to this mailbox with its password on this device first", 403);
  }
  if (!(await checkAuthRateLimit(env, authRateLimitBucket(request, "mailbox-change-password")))) {
    return jsonError("Too many attempts. Try again later.", 429);
  }
  const accountBucket = accountRateLimitBucket("mailbox-change-password", accountId);
  if (!(await countAccountLoginAttempt(env, accountBucket))) return jsonError("Too many attempts. Try again later.", 429);
  const invalid = mailboxPasswordError(input?.newPassword);
  if (invalid) return jsonError(invalid, 400);
  const newPassword = input!.newPassword as string;
  const record = await env.DB.prepare(`SELECT c.password_salt, c.password_hash, c.iterations
    FROM native_mailboxes m JOIN native_mailbox_credentials c ON c.mailbox_id=m.id
    WHERE m.id=?1 AND m.status='active' AND m.deleted_at IS NULL`)
    .bind(accountId).first<{ password_salt: string; password_hash: string; iterations: number }>();
  // 400, not 401: the session is fine, only the typed password is wrong.
  if (!currentPassword || !(await checkPassword(currentPassword, record))) return jsonError("The current password is incorrect", 400);
  if (newPassword === currentPassword) return jsonError("Choose a password different from the current one", 400);
  await clearAccountLoginFailures(env, accountBucket);
  // setMailboxPassword removes the mailbox from every device; this one keeps it.
  await setMailboxPassword(env, accountId, newPassword, { keepOwnedLinks: true });
  await establishDeviceGrant(request, env, accountId, "native");
  await env.DB.prepare("INSERT INTO mailbox_audit (id,mailbox_id,operation) VALUES (?1,?2,'password_change_self')")
    .bind(crypto.randomUUID(), accountId).run();
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
export async function deviceRemoveAccount(request: Request, env: Env, accountId: string): Promise<Response> {
  const session = await currentDeviceSession(request, env);
  if (!session) return jsonError("Session not found", 401);
  await env.DB.prepare("DELETE FROM device_session_accounts WHERE session_id=?1 AND account_id=?2")
    .bind(session.id,accountId).run();
  return Response.json({ ok:true });
}
/**
 * POST /api/device/logout. Signs this browser out of everything, or with
 * `{ "only": "admin" }` just out of the administrator session, so mailboxes
 * signed in on the device with their own passwords stay signed in.
 */
export async function deviceLogout(request: Request, env: Env): Promise<Response> {
  const input = await request.json<{ only?: unknown }>().catch(() => null);
  if (input?.only === "admin") {
    const ownerResponse = await ownerLogout(request, env);
    const headers = new Headers(ownerResponse.headers);
    headers.set("Cache-Control", "no-store");
    return Response.json({ ok: true }, { headers });
  }
  const session = await currentDeviceSession(request, env);
  if (session) await env.DB.prepare("DELETE FROM device_sessions WHERE id=?1").bind(session.id).run();
  const ownerResponse = await ownerLogout(request, env);
  const headers = new Headers(ownerResponse.headers);
  headers.append("Set-Cookie",clearDeviceCookie());
  headers.set("Cache-Control","no-store");
  return Response.json({ ok: true }, { headers });
}
export async function deviceAuthorized(request: Request, env: Env, accountId: string): Promise<boolean> {
  if (!accountId || accountId.length > 150) return false;
  const ids = await deviceAccountIds(request, env);
  if (ids.includes(accountId)) return true;
  // Administrative passkey session allows owner to open native addresses only.
  if (accountId.startsWith("native:") && await isAuthenticated(request, env)) {
    const row = await env.DB.prepare("SELECT 1 FROM native_mailboxes WHERE id=?1 AND status='active' AND deleted_at IS NULL")
      .bind(accountId).first();
    return Boolean(row);
  }
  return false;
}
export async function adminAuthorized(request: Request, env: Env): Promise<boolean> {
  return isAuthenticated(request, env);
}
export async function cleanupDeviceSessions(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM device_sessions WHERE expires_at<=datetime('now')").run();
}
