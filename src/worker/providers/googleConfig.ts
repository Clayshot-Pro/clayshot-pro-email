export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GOOGLE_PROFILE_SCOPE = "https://www.googleapis.com/auth/userinfo.profile";
// openid + email: proves which address signed in, so an address that is one of
// this app's own mailboxes opens that mailbox instead of a Gmail inbox.
export const GOOGLE_SCOPE = ["openid", "email", GMAIL_SCOPE, GOOGLE_PROFILE_SCOPE].join(" ");
export const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

type ConfiguredGoogleEnv = Env & {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  PROVIDER_CREDENTIAL_KEY: string;
};

export function isGoogleConfigured(env: Env): env is ConfiguredGoogleEnv {
  return Boolean(
    env.GOOGLE_CLIENT_ID
    && env.GOOGLE_CLIENT_SECRET
    && env.PROVIDER_CREDENTIAL_KEY,
  );
}

export function requireGoogleConfig(env: Env): asserts env is ConfiguredGoogleEnv {
  if (!isGoogleConfigured(env)) {
    throw new Error("Gmail connection is not configured");
  }
}

function hasGoogleScope(scope: string, required: string): boolean {
  return new Set(scope.split(/\s+/).filter(Boolean)).has(required);
}

export function hasRequiredGoogleScopes(scope: string): boolean {
  return hasGoogleScope(scope, GMAIL_SCOPE);
}
