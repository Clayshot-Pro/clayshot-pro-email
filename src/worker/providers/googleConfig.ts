export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GOOGLE_PROFILE_SCOPE = "https://www.googleapis.com/auth/userinfo.profile";
export const GOOGLE_SCOPE = [GMAIL_SCOPE, GOOGLE_PROFILE_SCOPE].join(" ");

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
