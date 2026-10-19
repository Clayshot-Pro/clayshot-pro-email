import { checkPassword, preparePassword } from "./passwordCrypto";
import { revokeAllMailAlerts } from "./push";
import { isAdministratorEmail } from "./config";
import { tryRecordAdminSecurityEvent } from "./adminSecurityAudit";
async function tokenHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
import { adminPasswordError } from "./mailboxPasswordPolicy";

const COOKIE = "__Host-ltm_admin_pending";
const AGE = 5 * 60;
import { primaryDomain } from "./domains";
function readCookie(request: Request): string | null {
  const match = (request.headers.get("Cookie")??"").split(";").map(x=>x.trim()).find(x=>x.startsWith(COOKIE+"="));
  const result = match?.slice(COOKIE.length+1)??null;
  return result && /^[A-Za-z0-9_-]{40,100}$/.test(result) ? result : null;
}
export const clearPendingCookie = (): string => `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
export async function adminPasswordConfigured(env: Env): Promise<boolean> {
  return Boolean(await env.DB.prepare("SELECT 1 FROM admin_credentials WHERE id=1").first());
}
export async function pendingAdminHash(request: Request, env: Env): Promise<string | null> {
  const value=readCookie(request);
  if (!value) return null;
  const hash=await tokenHash(value);
  const pending=await env.DB.prepare(
    "SELECT 1 FROM admin_login_pending WHERE token_hash=?1 AND expires_at>datetime('now')"
  ).bind(hash).first();
  return pending?hash:null;
}
export async function consumePendingAdmin(request: Request, env: Env, requiredHash: string): Promise<boolean> {
  const pending=await pendingAdminHash(request,env);
  if (!pending || pending!==requiredHash) return false;
  const used=await env.DB.prepare(
    "DELETE FROM admin_login_pending WHERE token_hash=?1 AND expires_at>datetime('now') RETURNING token_hash"
  ).bind(requiredHash).first();
  return Boolean(used);
}
export async function verifyAdminPassword(env: Env, password: string): Promise<boolean> {
  const entry=await env.DB.prepare(
    "SELECT password_salt,password_hash,iterations FROM admin_credentials WHERE id=1"
  ).first<{password_salt:string;password_hash:string;iterations:number}>();
  return checkPassword(password,entry);
}
export async function beginAdminLogin(request: Request, env: Env): Promise<Response> {
  const payload=await request.json<{email?:unknown;password?:unknown}>().catch(()=>null);
  const email=typeof payload?.email==="string"?payload.email.trim().toLowerCase():"";
  const password=typeof payload?.password==="string"?payload.password:"";
  if (!(await adminPasswordConfigured(env))) {
    return Response.json({error:"Administrator password setup required"}, {status:409});
  }
  if (!isAdministratorEmail(request, email, await primaryDomain(env)) || !(await verifyAdminPassword(env,password))) {
    await tryRecordAdminSecurityEvent(env, "admin.login.password", "denied");
    return Response.json({error:"Invalid credentials"},{status:401});
  }
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  const session=btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
  const hash=await tokenHash(session);
  await env.DB.prepare(
    "INSERT INTO admin_login_pending(token_hash,expires_at) VALUES(?1,datetime('now','+5 minutes'))"
  ).bind(hash).run();
  await tryRecordAdminSecurityEvent(env, "admin.login.password", "success");
  return Response.json({passkeyRequired:true},{
    headers:{
      "Cache-Control":"no-store",
      "Set-Cookie":`${COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${AGE}`,
    },
  });
}
/**
 * Set or change the administrator password. `firstRun` (first-run setup,
 * before any owner passkey exists) may replace a password set by an earlier,
 * unfinished setup attempt without the current one.
 */
export async function saveAdminPassword(env: Env,newPassword: unknown,currentPassword?:unknown,firstRun=false): Promise<{error?:string}> {
  const invalid=adminPasswordError(newPassword);
  if (invalid) return {error:invalid};
  const existing=await adminPasswordConfigured(env);
  if (existing && !firstRun) {
    if (typeof currentPassword!=="string" || !(await verifyAdminPassword(env,currentPassword))) {
      return {error:"Current admin password is incorrect"};
    }
    if (currentPassword===newPassword) return {error:"Choose a different new password"};
  }
  // Separate hashing failures from D1 failures. Never log or return passwords,
  // password hashes, salts, or SQL bound values.
  let hash;
  try {
    hash = await preparePassword(newPassword as string, "admin");
  } catch (cause) {
    console.error("admin_password_hash_failure", cause instanceof Error ? cause.name : "unknown");
    return {error:"Password security initialization failed (ADMIN_HASH_UNAVAILABLE). Please try again."};
  }
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO admin_credentials (id,password_salt,password_hash,iterations)
       VALUES(1,?1,?2,?3) ON CONFLICT(id) DO UPDATE SET
       password_salt=excluded.password_salt,password_hash=excluded.password_hash,
       iterations=excluded.iterations,changed_at=CURRENT_TIMESTAMP`).bind(hash.salt,hash.hash,hash.iterations),
      env.DB.prepare("DELETE FROM admin_login_pending"),
      // Invalidate previous passkey-only sessions after a successful password change.
      env.DB.prepare("DELETE FROM auth_sessions"),
      revokeAllMailAlerts(env, "all"),
    ]);
  } catch (cause) {
    console.error("admin_password_storage_failure", cause instanceof Error ? cause.name : "unknown");
    return {error:"Could not save the password (ADMIN_STORAGE_UNAVAILABLE). Please try again."};
  }
  return {};
}
