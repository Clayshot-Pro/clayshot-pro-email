import { adminPasswordConfigured, pendingAdminHash, consumePendingAdmin, clearPendingCookie } from "./adminAuth";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { adminLoginAddress, appOrigin, passkeyRpId } from "./config";
import { brandNames, instanceSettings } from "./branding";
import { tryRecordAdminSecurityEvent } from "./adminSecurityAudit";
import { OWNER_IDLE_TTL_SECONDS, OWNER_SESSION_COOKIE, OWNER_SESSION_TTL_SECONDS, readOwnerSessionToken } from "./ownerSessionPolicy";

const CHALLENGE_TTL_SECONDS = 5 * 60;
const MAX_ACTIVE_SESSIONS = 5;
const ownerIdleModifier = `-${OWNER_IDLE_TTL_SECONDS} seconds`;
const OWNER_USER_ID = new TextEncoder().encode("ltm-mail-owner");

type Ceremony = "registration" | "authentication";

type CredentialRow = {
  id: string;
  public_key: ArrayBuffer;
  counter: number;
  transports: string | null;
};

type ChallengeRow = {
  challenge: string;
  admin_pending_hash: string | null;
};

type SessionRow = {
  session_id: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string | null;
};

const jsonError = (message: string, status: number) =>
  Response.json({ error: message }, { status });

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function sessionCookie(token: string, maxAge = OWNER_SESSION_TTL_SECONDS): string {
  return `${OWNER_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function expiredSessionCookie(): string {
  return `${OWNER_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function parseTransports(value: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is AuthenticatorTransportFuture => typeof item === "string")
      : undefined;
  } catch {
    return undefined;
  }
}

async function hasCredential(env: Env): Promise<boolean> {
  return Boolean(await env.DB.prepare("SELECT 1 FROM auth_credentials LIMIT 1").first());
}

async function cleanup(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= datetime('now')"),
    env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at <= datetime('now') OR last_seen_at <= datetime('now', ?)").bind(ownerIdleModifier),
  ]);
}

async function createSession(env: Env, request: Request): Promise<string> {
  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO auth_sessions (session_id, token_hash, expires_at, user_agent) VALUES (?, ?, datetime('now', ?), ?)",
  )
    .bind(
      crypto.randomUUID(),
      await sha256Hex(token),
      `+${OWNER_SESSION_TTL_SECONDS} seconds`,
      request.headers.get("User-Agent")?.slice(0, 512) ?? null,
    )
    .run();

  await env.DB.prepare(`
    DELETE FROM auth_sessions
    WHERE token_hash NOT IN (
      SELECT token_hash
      FROM auth_sessions
      ORDER BY last_seen_at DESC, created_at DESC
      LIMIT ${MAX_ACTIVE_SESSIONS}
    )
  `).run();

  return token;
}

export async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const token = readOwnerSessionToken(request);
  if (!token) return false;

  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT 1 FROM auth_sessions WHERE token_hash = ? AND expires_at > datetime('now') AND last_seen_at > datetime('now', ?) LIMIT 1",
  )
    .bind(hash, ownerIdleModifier)
    .first();
  if (!row) return false;

  await env.DB.prepare(
    "UPDATE auth_sessions SET last_seen_at = datetime('now') WHERE token_hash = ?",
  )
    .bind(hash)
    .run();
  return true;
}

async function setupAuthorized(request: Request, env: Env, supplied?: string): Promise<boolean> {
  if (await hasCredential(env)) return isAuthenticated(request, env);
  if (!env.AUTH_SETUP_TOKEN || !supplied) return false;

  const expected = new TextEncoder().encode(env.AUTH_SETUP_TOKEN);
  const actual = new TextEncoder().encode(supplied);
  if (expected.length !== actual.length) return false;

  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected[index] ^ actual[index];
  }
  return diff === 0;
}

async function saveChallenge(env: Env, ceremony: Ceremony, challenge: string, adminPendingHash: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO auth_challenges (id, challenge, ceremony, expires_at, admin_pending_hash) VALUES (?, ?, ?, datetime('now', ?), ?)",
  )
    .bind(id, challenge, ceremony, `+${CHALLENGE_TTL_SECONDS} seconds`, adminPendingHash)
    .run();
  return id;
}

async function takeChallenge(
  env: Env,
  id: string,
  ceremony: Ceremony,
): Promise<ChallengeRow | null> {
  return env.DB.prepare(`
    DELETE FROM auth_challenges
    WHERE id = ? AND ceremony = ? AND expires_at > datetime('now')
    RETURNING challenge,admin_pending_hash
  `)
    .bind(id, ceremony)
    .first<ChallengeRow>();
}

export async function authStatus(request: Request, env: Env): Promise<Response> {
  await cleanup(env);
  const configured = await hasCredential(env);
  return Response.json({
    configured,
    authenticated: configured ? await isAuthenticated(request, env) : false,
    setupAvailable: !configured && Boolean(env.AUTH_SETUP_TOKEN),
    adminPasswordConfigured: await adminPasswordConfigured(env),
  });
}

export async function registrationOptions(request: Request, env: Env): Promise<Response> {
  if (await hasCredential(env)) {
    return jsonError("Passkey registration is disabled", 403);
  }

  const body = await request.json<{ setupToken?: string }>().catch(() => null);
  if (!(await setupAuthorized(request, env, body?.setupToken))) {
    return jsonError(
      (await hasCredential(env)) ? "Authentication required" : "Invalid setup token",
      401,
    );
  }

  await cleanup(env);
  const existing = await env.DB.prepare(
    "SELECT id, transports FROM auth_credentials ORDER BY created_at ASC",
  ).all<{ id: string; transports: string | null }>();

  const options = await generateRegistrationOptions({
    rpName: brandNames(await instanceSettings(env)).name,
    rpID: passkeyRpId(request),
    userID: OWNER_USER_ID,
    userName: adminLoginAddress(request),
    userDisplayName: `${brandNames(await instanceSettings(env)).name} owner`,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    excludeCredentials: existing.results.map((credential) => ({
      id: credential.id,
      transports: parseTransports(credential.transports),
    })),
  });

  return Response.json({
    challengeId: await saveChallenge(env, "registration", options.challenge),
    options,
  });
}

export async function verifyRegistration(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    challengeId?: string;
    response?: RegistrationResponseJSON;
    setupToken?: string;
  }>().catch(() => null);

  if (!body?.challengeId || !body.response) {
    return jsonError("Invalid registration payload", 400);
  }
  if (await hasCredential(env)) {
    return jsonError("Passkey registration is disabled", 403);
  }
  if (!(await setupAuthorized(request, env, body.setupToken))) {
    return jsonError(
      (await hasCredential(env)) ? "Authentication required" : "Invalid setup token",
      401,
    );
  }

  const challenge = await takeChallenge(env, body.challengeId, "registration");
  if (!challenge) return jsonError("Registration challenge expired or invalid", 400);

  try {
    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: appOrigin(request),
      expectedRPID: passkeyRpId(request),
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return jsonError("Passkey registration could not be verified", 400);
    }

    const { credential } = verification.registrationInfo;
    await env.DB.prepare(`
      INSERT OR REPLACE INTO auth_credentials (
        id,
        public_key,
        counter,
        transports,
        created_at
      )
      VALUES (?, ?, ?, ?, datetime('now'))
    `)
      .bind(
        credential.id,
        credential.publicKey,
        credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null,
      )
      .run();

    const token = await createSession(env, request);
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": sessionCookie(token),
      },
    });
  } catch {
    return jsonError("Passkey registration failed", 400);
  }
}

export async function authenticationOptions(request: Request, env: Env): Promise<Response> {
  await cleanup(env);
  const requiresPassword = await adminPasswordConfigured(env);
  const pending = requiresPassword ? await pendingAdminHash(request, env) : null;
  if (requiresPassword && !pending) return jsonError("Administrator password verification required", 403);
  const credentials = await env.DB.prepare(
    "SELECT id, transports FROM auth_credentials ORDER BY created_at ASC",
  ).all<{ id: string; transports: string | null }>();
  if (!credentials.results.length) return jsonError("Passkey setup required", 409);

  const options = await generateAuthenticationOptions({
    rpID: passkeyRpId(request),
    userVerification: "required",
    allowCredentials: credentials.results.map((credential) => ({
      id: credential.id,
      transports: parseTransports(credential.transports),
    })),
  });

  return Response.json({
    challengeId: await saveChallenge(env, "authentication", options.challenge, pending),
    options,
  });
}

export async function verifyAuthentication(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    challengeId?: string;
    response?: AuthenticationResponseJSON;
  }>().catch(() => null);
  if (!body?.challengeId || !body.response) {
    return jsonError("Invalid authentication payload", 400);
  }

  const requiresPassword = await adminPasswordConfigured(env);
  const challenge = await takeChallenge(env, body.challengeId, "authentication");
  if (!challenge) {
    await tryRecordAdminSecurityEvent(env, "admin.login.passkey", "denied");
    return jsonError("Authentication challenge expired or invalid", 400);
  }
  if (requiresPassword && (!challenge.admin_pending_hash || await pendingAdminHash(request,env)!==challenge.admin_pending_hash)) {
    return jsonError("Administrator password verification required", 403);
  }

  const stored = await env.DB.prepare(`
    SELECT id, public_key, counter, transports
    FROM auth_credentials
    WHERE id = ?
    LIMIT 1
  `)
    .bind(body.response.id)
    .first<CredentialRow>();
  if (!stored) {
    await tryRecordAdminSecurityEvent(env, "admin.login.passkey", "denied");
    return jsonError("Passkey authentication failed", 401);
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: appOrigin(request),
      expectedRPID: passkeyRpId(request),
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(stored.public_key),
        counter: stored.counter,
        transports: parseTransports(stored.transports),
      },
      requireUserVerification: true,
    });
    if (!verification.verified) {
      await tryRecordAdminSecurityEvent(env, "admin.login.passkey", "denied");
      return jsonError("Passkey authentication failed", 401);
    }

    await env.DB.prepare(`
      UPDATE auth_credentials
      SET counter = ?, last_used_at = datetime('now')
      WHERE id = ?
    `)
      .bind(verification.authenticationInfo.newCounter, stored.id)
      .run();

    if (requiresPassword && (!challenge.admin_pending_hash || !(await consumePendingAdmin(request, env, challenge.admin_pending_hash)))) {
      return jsonError("Administrator verification expired", 403);
    }
    const token = await createSession(env, request);
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("Set-Cookie", sessionCookie(token));
    if (requiresPassword) headers.append("Set-Cookie", clearPendingCookie());
    await tryRecordAdminSecurityEvent(env, "admin.login.passkey", "success");
    return new Response(JSON.stringify({ ok: true }), { headers });
  } catch {
    await tryRecordAdminSecurityEvent(env, "admin.login.passkey", "denied");
    return jsonError("Passkey authentication failed", 401);
  }
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const token = readOwnerSessionToken(request);
  if (token) {
    await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
      .bind(await sha256Hex(token))
      .run();
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": expiredSessionCookie(),
    },
  });
}

export async function sessionInfo(request: Request, env: Env): Promise<Response> {
  await cleanup(env);
  const token = readOwnerSessionToken(request);
  const current = token ? await sha256Hex(token) : null;
  const rows = await env.DB.prepare(`
    SELECT session_id, token_hash, created_at, last_seen_at, expires_at, user_agent
    FROM auth_sessions
    ORDER BY last_seen_at DESC, created_at DESC
  `).all<SessionRow>();

  return Response.json({
    sessions: rows.results.map((session) => ({
      id: session.session_id,
      current: session.token_hash === current,
      createdAt: session.created_at,
      lastSeenAt: session.last_seen_at,
      expiresAt: session.expires_at,
      userAgent: session.user_agent,
    })),
  });
}

export async function resetSessions(request: Request, env: Env): Promise<Response> {
  const token = readOwnerSessionToken(request);
  if (!token) return unauthorizedResponse();

  const current = await sha256Hex(token);
  await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash != ?")
    .bind(current)
    .run();
  return Response.json({ ok: true });
}

export async function revokeSession(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  const token = readOwnerSessionToken(request);
  if (!token) return unauthorizedResponse();

  const current = await sha256Hex(token);
  const result = await env.DB.prepare(
    "DELETE FROM auth_sessions WHERE session_id = ? AND token_hash != ?",
  )
    .bind(sessionId, current)
    .run();

  if (!result.meta.changes) {
    return jsonError("Session not found or current session cannot be removed", 404);
  }

  return Response.json({ ok: true });
}

export const unauthorizedResponse = (): Response =>
  jsonError("Authentication required", 401);


/** A hashed, verified owner cookie reference for scoped push subscriptions. */
export async function ownerSessionHash(request: Request, env: Env): Promise<string | null> {
  const t = readOwnerSessionToken(request);
  if (!t) return null;
  const hash = await sha256Hex(t);
  const current = await env.DB.prepare(
    "SELECT 1 FROM auth_sessions WHERE token_hash=?1 AND expires_at>datetime('now') AND last_seen_at>datetime('now', ?)"
  ).bind(hash, ownerIdleModifier).first();
  return current ? hash : null;
}
