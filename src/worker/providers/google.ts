import { appOrigin } from "../config";
import { prepareOAuthNonce, oauthNonceMatches, tokenHash, grantGoogleDeviceSession, clearOAuthCookie } from "../deviceAuth";
import { decryptSecret, encryptSecret } from "./crypto";
import {
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_SCOPE,
  GOOGLE_TOKEN_ENDPOINT,
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

function toBase64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function randomBase64Url(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

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

export async function startGoogleOAuth(request: Request, env: Env): Promise<Response> {
  try {
    requireGoogleConfig(env);
  } catch {
    return Response.json({ error: "Gmail connection is not configured" }, { status: 503 });
  }

  const { nonce, setCookie } = prepareOAuthNonce();
  const state = randomBase64Url();
  const verifier = randomBase64Url(48);
  const stateHash = await sha256Hex(state);
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_SECONDS * 1000).toISOString();

  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at <= CURRENT_TIMESTAMP").run();
  await env.DB.prepare(`
    INSERT INTO oauth_states (
      id_hash,
      provider,
      pkce_verifier_encrypted,
      expires_at, device_nonce_hash
    )
    VALUES (?1, 'gmail', ?2, ?3, ?4)
  `)
    .bind(
      stateHash,
      await encryptSecret(env, { verifier, origin: appOrigin(request) }, `oauth:${stateHash}`),
      expiresAt,
      await tokenHash(nonce),
    )
    .run();

  const query = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUri(request),
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    include_granted_scopes: "false",
  });

  return Response.json({
    authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query}`,
  }, { headers: { "Set-Cookie": setCookie, "Cache-Control": "no-store" } });
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
  try {
    const saved = await decryptSecret<{ verifier: string; origin?: string }>(
      env, stateRow.pkce_verifier_encrypted, `oauth:${stateHash}`,
    );
    // The callback must arrive at the same Worker hostname as initiation.
    // Prior in-flight states expire after ten minutes and cannot cross origins.
    if (saved.origin !== appOrigin(request)) return redirectWithStatus(request, "invalid_state");
    verifier = saved.verifier;
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
  if (
    !token.access_token
    || !token.refresh_token
    || !hasRequiredGoogleScopes(grantedScope)
  ) {
    if (token.refresh_token) await revokeGoogleToken(token.refresh_token);
    else if (token.access_token) await revokeGoogleToken(token.access_token);
    return redirectWithStatus(request, "authorization_incomplete");
  }

  let profile: GmailProfile;
  try {
    const response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${token.access_token}` } },
    );
    if (!response.ok) {
      await revokeGoogleToken(token.refresh_token);
      return redirectWithStatus(request, "profile_failed");
    }
    profile = await response.json<GmailProfile>();
  } catch {
    await revokeGoogleToken(token.refresh_token);
    return redirectWithStatus(request, "profile_failed");
  }

  const email = profile.emailAddress?.trim().toLowerCase();
  if (!email) {
    await revokeGoogleToken(token.refresh_token);
    return redirectWithStatus(request, "profile_failed");
  }

  const accountId = `gmail:${await sha256Hex(email)}`;
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

export async function disconnectGoogle(accountId: string, env: Env): Promise<Response> {
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
