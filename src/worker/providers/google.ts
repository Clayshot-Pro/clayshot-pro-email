import { randomBase64Url, sha256Hex, toBase64Url } from "../bytes";
import { appOrigin } from "../config";
import { prepareOAuthNonce, oauthNonceMatches, tokenHash, grantGoogleDeviceSession, grantNativeDeviceSession, nativeMailboxForGoogleEmail, clearOAuthCookie } from "../deviceAuth";
import { decryptSecret, encryptSecret } from "./crypto";
import {
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_SCOPE,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  hasRequiredGoogleScopes,
  requireGoogleConfig,
} from "./googleConfig";

const callbackUri = (request: Request) => `${appOrigin(request)}/api/accounts/gmail/callback`;
const OAUTH_STATE_TTL_SECONDS = 600;
const encoder = new TextEncoder();

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

type GmailProfile = {
  emailAddress?: string;
  historyId?: string;
};

type OAuthStateRow = {
  pkce_verifier_encrypted: string;
  device_nonce_hash: string | null;
};


async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // Best-effort revocation. Local credential removal still proceeds.
  }
}

function redirectWithStatus(request: Request, status: string): Response {
  // Construct a writable response so the OAuth callback can issue the
  // per-device HttpOnly session cookie and clear its one-time nonce.
  return new Response(null, {
    status: 303,
    headers: { Location: `${appOrigin(request)}/?gmail=${encodeURIComponent(status)}`, "Cache-Control": "no-store" },
  });
}

/**
 * Google's consent screen is shown only when the account has not accepted this
 * app's access before. `consent` forces it, which is the only way Google hands
 * out a refresh token again: used when a Gmail account has to be (re)connected.
 */
async function beginAuthorization(request: Request, env: Env & { GOOGLE_CLIENT_ID: string }, consent: boolean): Promise<{ authorizationUrl: string; setCookie: string }> {
  const { nonce, setCookie } = prepareOAuthNonce();
  const state = randomBase64Url();
  const verifier = randomBase64Url(48);
  const stateHash = await sha256Hex(state);

  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at <= CURRENT_TIMESTAMP").run();
  await env.DB.prepare(`
    INSERT INTO oauth_states (
      id_hash,
      provider,
      pkce_verifier_encrypted,
      expires_at, device_nonce_hash
    )
    VALUES (?1, 'gmail', ?2, datetime('now', ?3), ?4)
  `)
    .bind(
      stateHash,
      await encryptSecret(env, { verifier, origin: appOrigin(request), consent }, `oauth:${stateHash}`),
      // SQLite's own format, so the CURRENT_TIMESTAMP comparisons below are exact.
      `+${OAUTH_STATE_TTL_SECONDS} seconds`,
      await tokenHash(nonce),
    )
    .run();

  const query = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUri(request),
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    ...(consent ? { prompt: "consent" } : {}),
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    include_granted_scopes: "false",
  });

  return { authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query}`, setCookie };
}

export async function startGoogleOAuth(request: Request, env: Env): Promise<Response> {
  try {
    requireGoogleConfig(env);
  } catch {
    return Response.json({ error: "Gmail connection is not configured" }, { status: 503 });
  }
  const { authorizationUrl, setCookie } = await beginAuthorization(request, env, false);
  return Response.json({ authorizationUrl }, { headers: { "Set-Cookie": setCookie, "Cache-Control": "no-store" } });
}

/** Google's verified email for this sign-in, or null (no email scope, unverified, or an error). */
async function googleVerifiedEmail(accessToken: string | undefined): Promise<string | null> {
  if (!accessToken) return null;
  try {
    const response = await fetch(GOOGLE_USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) return null;
    const info = await response.json<{ email?: unknown; email_verified?: unknown }>();
    return info.email_verified === true && typeof info.email === "string" && info.email.length <= 320
      ? info.email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

async function nativeMailboxSignedIn(request: Request, env: Env, mailboxId: string): Promise<Response> {
  // Nothing from Google is stored: the app's own inbox needs no Google access.
  // The grant is not revoked either, or Google would show its consent screen again at the next sign-in.
  const sessionCookie = await grantNativeDeviceSession(request, env, mailboxId);
  const response = redirectWithStatus(request, "connected");
  if (sessionCookie) response.headers.append("Set-Cookie", sessionCookie);
  response.headers.append("Set-Cookie", clearOAuthCookie());
  return response;
}

export async function googleOAuthCallback(request: Request, env: Env): Promise<Response> {
  try {
    requireGoogleConfig(env);
  } catch {
    return redirectWithStatus(request, "configuration_error");
  }

  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const oauthError = url.searchParams.get("error");

  if (oauthError) return redirectWithStatus(request, "cancelled");
  if (!state || !code) return redirectWithStatus(request, "invalid_callback");

  const stateHash = await sha256Hex(state);
  const stateRow = await env.DB.prepare(`
    DELETE FROM oauth_states
    WHERE id_hash = ?1
      AND provider = 'gmail'
      AND expires_at > CURRENT_TIMESTAMP
    RETURNING pkce_verifier_encrypted,device_nonce_hash
  `)
    .bind(stateHash)
    .first<OAuthStateRow>();
  if (!stateRow) return redirectWithStatus(request, "expired");
  if (!(await oauthNonceMatches(request, stateRow.device_nonce_hash))) return redirectWithStatus(request, "invalid_state");

  let verifier: string;
  let consented = false;
  try {
    const saved = await decryptSecret<{ verifier: string; origin?: string; consent?: boolean }>(
      env, stateRow.pkce_verifier_encrypted, `oauth:${stateHash}`,
    );
    // The callback must arrive at the same Worker hostname as initiation.
    // Prior in-flight states expire after ten minutes and cannot cross origins.
    if (saved.origin !== appOrigin(request)) return redirectWithStatus(request, "invalid_state");
    verifier = saved.verifier;
    consented = saved.consent === true;
  } catch {
    return redirectWithStatus(request, "invalid_state");
  }

  const tokenRequest = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: callbackUri(request),
    grant_type: "authorization_code",
    code_verifier: verifier,
  });

  let token: TokenResponse;
  try {
    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenRequest,
    });
    if (!response.ok) return redirectWithStatus(request, "exchange_failed");
    token = await response.json<TokenResponse>();
  } catch {
    return redirectWithStatus(request, "exchange_failed");
  }

  const grantedScope = token.scope ?? "";

  // An address that is one of this app's own mailboxes opens that mailbox: no
  // Gmail inbox is connected.
  const verified = await googleVerifiedEmail(token.access_token);
  const nativeId = verified ? await nativeMailboxForGoogleEmail(request, env, verified) : null;
  if (nativeId) return nativeMailboxSignedIn(request, env, nativeId);

  // Whatever Google gave, for revoking it when the sign-in is not completed.
  const revocable = token.refresh_token ?? token.access_token;
  if (!token.access_token || !hasRequiredGoogleScopes(grantedScope)) {
    if (revocable) await revokeGoogleToken(revocable);
    return redirectWithStatus(request, "authorization_incomplete");
  }

  let profile: GmailProfile;
  try {
    const response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${token.access_token}` } },
    );
    if (!response.ok) {
      if (revocable) await revokeGoogleToken(revocable);
      return redirectWithStatus(request, "profile_failed");
    }
    profile = await response.json<GmailProfile>();
  } catch {
    if (revocable) await revokeGoogleToken(revocable);
    return redirectWithStatus(request, "profile_failed");
  }

  const email = profile.emailAddress?.trim().toLowerCase();
  if (!email) {
    if (revocable) await revokeGoogleToken(revocable);
    return redirectWithStatus(request, "profile_failed");
  }

  // Gmail confirms the address too (when the sign-in above gave no verified email).
  const nativeFromProfile = await nativeMailboxForGoogleEmail(request, env, email);
  if (nativeFromProfile) return nativeMailboxSignedIn(request, env, nativeFromProfile);

  const accountId = `gmail:${await sha256Hex(email)}`;

  // Google skips the consent screen for an account that accepted before, and
  // then sends no refresh token. An account already connected here keeps its
  // stored credential and the device is signed in to it. Otherwise the
  // consent screen is asked for once (never twice in a row) to get a token.
  if (!token.refresh_token) {
    const connected = await env.DB.prepare(`SELECT 1 FROM connected_accounts a
      JOIN provider_credentials c ON c.account_id = a.id WHERE a.id = ?1 AND a.status = 'active'`)
      .bind(accountId).first();
    if (connected) {
      const sessionCookie = await grantGoogleDeviceSession(request, env, accountId);
      const response = redirectWithStatus(request, "connected");
      if (sessionCookie) response.headers.append("Set-Cookie", sessionCookie);
      response.headers.append("Set-Cookie", clearOAuthCookie());
      return response;
    }
    if (consented) {
      await revokeGoogleToken(token.access_token);
      return redirectWithStatus(request, "authorization_incomplete");
    }
    const retry = await beginAuthorization(request, env, true);
    const response = new Response(null, { status: 303, headers: { Location: retry.authorizationUrl, "Cache-Control": "no-store" } });
    response.headers.append("Set-Cookie", retry.setCookie);
    return response;
  }
  const expiresAt = new Date(
    Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000,
  ).toISOString();
  const credential = {
    refreshToken: token.refresh_token,
    accessToken: token.access_token,
    accessTokenExpiresAt: expiresAt,
    scope: grantedScope,
  };

  let encryptedCredential: string;
  try {
    encryptedCredential = await encryptSecret(
      env,
      credential,
      `credential:${accountId}`,
    );
  } catch {
    await revokeGoogleToken(token.refresh_token);
    return redirectWithStatus(request, "storage_failed");
  }

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO connected_accounts (
          id,
          provider,
          provider_account_id,
          email_address,
          display_name,
          status,
          sync_cursor,
          last_synced_at,
          updated_at
        )
        VALUES (?1, 'gmail', ?2, ?3, NULL, 'active', ?4, NULL, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          email_address = excluded.email_address,
          status = 'active',
          sync_cursor = COALESCE(excluded.sync_cursor, connected_accounts.sync_cursor),
          updated_at = CURRENT_TIMESTAMP
      `).bind(accountId, email, email, profile.historyId ?? null),
      env.DB.prepare(`
        INSERT INTO provider_credentials (
          account_id,
          encrypted_blob,
          key_version,
          expires_at,
          updated_at
        )
        VALUES (?1, ?2, 1, ?3, CURRENT_TIMESTAMP)
        ON CONFLICT(account_id) DO UPDATE SET
          encrypted_blob = excluded.encrypted_blob,
          key_version = excluded.key_version,
          expires_at = excluded.expires_at,
          updated_at = CURRENT_TIMESTAMP
      `).bind(accountId, encryptedCredential, expiresAt),
    ]);
  } catch {
    await revokeGoogleToken(token.refresh_token);
    return redirectWithStatus(request, "storage_failed");
  }

  const sessionCookie = await grantGoogleDeviceSession(request, env, accountId);
  const response = redirectWithStatus(request, "connected");
  if (sessionCookie) response.headers.append("Set-Cookie", sessionCookie);
  response.headers.append("Set-Cookie", clearOAuthCookie());
  return response;
}

/**
 * Disconnect a Gmail account no device uses any more: its refresh token is
 * revoked and deleted instead of staying in D1 indefinitely.
 */
export async function disconnectGoogleIfUnused(accountId: string, env: Env): Promise<void> {
  if (!accountId.startsWith("gmail:")) return;
  const inUse = await env.DB.prepare("SELECT 1 AS yes FROM device_session_accounts WHERE account_id=?1 LIMIT 1").bind(accountId).first();
  if (!inUse) await disconnectGoogle(accountId, env);
}

async function disconnectGoogle(accountId: string, env: Env): Promise<Response> {
  if (!accountId.startsWith("gmail:")) {
    return Response.json({ error: "Gmail account not found" }, { status: 404 });
  }

  const account = await env.DB.prepare(`
    SELECT id
    FROM connected_accounts
    WHERE id = ?1 AND provider = 'gmail'
  `)
    .bind(accountId)
    .first<{ id: string }>();
  if (!account) return Response.json({ ok: true });

  const credentialRow = await env.DB.prepare(`
    SELECT encrypted_blob
    FROM provider_credentials
    WHERE account_id = ?1
  `)
    .bind(accountId)
    .first<{ encrypted_blob: string }>();

  if (credentialRow) {
    try {
      const credential = await decryptSecret<{ refreshToken: string }>(
        env,
        credentialRow.encrypted_blob,
        `credential:${accountId}`,
      );
      if (credential.refreshToken) await revokeGoogleToken(credential.refreshToken);
    } catch {
      // A corrupt credential should not prevent local account removal.
    }
  }

  try {
    await env.DB.prepare(
      "DELETE FROM connected_accounts WHERE id = ?1 AND provider = 'gmail'",
    )
      .bind(accountId)
      .run();
  } catch {
    return Response.json({ error: "Could not remove Gmail account" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
