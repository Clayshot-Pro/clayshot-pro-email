import { mailboxPasswordError } from "./mailboxPasswordPolicy";
import { preparePassword, checkPassword } from "./passwordCrypto";
import { isAuthenticated, logout as ownerLogout } from "./auth";
import { normalizeMailboxAddress } from "./mailboxRules";
import { adminLoginAddress, adminMailboxAddress, isAdministratorEmail } from "./config";
import { ADMIN_MAILBOX_ID } from "./mailboxIds";
import { accountLoginBlocked, accountRateLimitBucket, authRateLimitBucket, checkAuthRateLimit, clearAccountLoginFailures, recordAccountLoginFailure } from "./security";

import { addressRules, primaryDomain } from "./domains";
import { beginAdminLogin } from "./adminAuth";

const DEVICE_COOKIE = "__Host-ltm_device";
const OAUTH_COOKIE = "__Host-ltm_oauth";
const DEVICE_LIFETIME = 60 * 60 * 24 * 30;
const utf8 = new TextEncoder();
const jsonError = (error: string, status: number) => Response.json({ error }, { status });

type DeviceSessionRow = { id: string; token_hash: string };
export type DeviceGrant = { account_id: string; provider: "native" | "gmail" };

function b64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function token(bytes = 32): string { return b64url(crypto.getRandomValues(new Uint8Array(bytes))); }
export async function tokenHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
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
  const nonce = token();
  return { nonce, setCookie: oauthCookie(nonce) };
}
export async function oauthNonceMatches(request: Request, hash: string | null): Promise<boolean> {
  const nonce = readCookie(request, OAUTH_COOKIE);
  return Boolean(hash && nonce && /^[\w-]{30,100}$/.test(nonce) && await tokenHash(nonce) === hash);
}

export async function credentialForMailbox(_id: string, password: string): Promise<{
  salt: string; hash: string; iterations: number;
}> {
  const invalid = mailboxPasswordError(password);
  if (invalid) throw new Error(invalid);
  return preparePassword(password, "mailbox");
}
export async function setMailboxPassword(env: Env, id: string, password: string): Promise<void> {
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
  ]);
}
export async function rotateMailboxPassword(env: Env, id: string): Promise<string> {
  // 24 random bytes -> 32 base64url chars (192 bits of entropy).
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const password = b64url(bytes);
  await setMailboxPassword(env,id,password);
  return password; // only displayed once to the verified owner.
}
async function checkNativePassword(env: Env, address: string, password: string): Promise<string | null> {
  const normalized = normalizeMailboxAddress(address, await addressRules(env, "routing"));
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
  return env.DB.prepare(`SELECT id,token_hash FROM device_sessions
    WHERE token_hash=?1 AND expires_at>datetime('now')`)
    .bind(await tokenHash(t)).first<DeviceSessionRow>();
}
async function establishDeviceGrant(request: Request, env: Env, accountId: string, provider: DeviceGrant["provider"]): Promise<string | null> {
  let session = await currentDeviceSession(request, env);
  let issued: string | null = null;
  if (!session) {
    issued = token();
    const id = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO device_sessions (id,token_hash,expires_at,user_agent)
      VALUES (?1,?2,datetime('now','+30 days'),?3)`)
      .bind(id, await tokenHash(issued), request.headers.get("User-Agent")?.slice(0, 300) ?? null).run();
    session = { id, token_hash: await tokenHash(issued) };
  }
  await env.DB.prepare(`INSERT OR IGNORE INTO device_session_accounts(session_id,account_id,provider)
    VALUES (?1,?2,?3)`).bind(session.id,accountId,provider).run();
  return issued ? deviceCookie(issued) : null;
}
export async function grantGoogleDeviceSession(request: Request, env: Env, accountId: string): Promise<string | null> {
  return establishDeviceGrant(request, env, accountId, "gmail");
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
export async function deviceStatus(request: Request, env: Env): Promise<Response> {
  const [ids, admin] = await Promise.all([deviceAccountIds(request, env), isAuthenticated(request, env)]);
  // Passkey sessions are privileged admin sessions and may open native mailboxes.
  const native = admin ? await env.DB.prepare("SELECT COUNT(*) AS count FROM native_mailboxes WHERE status='active' AND deleted_at IS NULL")
    .first<{count:number}>() : null;
  return Response.json({ authenticated: admin || ids.length > 0, isAdmin: admin, accountCount: ids.length + (native?.count ?? 0) });
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
  const accountBucket = accountRateLimitBucket("native-login", email);
  if (!(await checkAuthRateLimit(env, authRateLimitBucket(request, "native-login")))
    || await accountLoginBlocked(env, accountBucket)) {
    return jsonError("Too many attempts. Try again later.", 429);
  }
  const mailboxId = await checkNativePassword(env,email,password);
  if (!mailboxId) {
    await recordAccountLoginFailure(env, accountBucket);
    return jsonError("Invalid credentials", 401);
  }
  await clearAccountLoginFailures(env, accountBucket);
  const setCookie = await establishDeviceGrant(request, env, mailboxId, "native");
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (setCookie) headers.append("Set-Cookie",setCookie);
  return Response.json({ ok: true, accountId: mailboxId }, { headers });
}
export async function deviceRemoveAccount(request: Request, env: Env, accountId: string): Promise<Response> {
  const session = await currentDeviceSession(request, env);
  if (!session) return jsonError("Session not found", 401);
  await env.DB.prepare("DELETE FROM device_session_accounts WHERE session_id=?1 AND account_id=?2")
    .bind(session.id,accountId).run();
  return Response.json({ ok:true });
}
export async function deviceLogout(request: Request, env: Env): Promise<Response> {
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
