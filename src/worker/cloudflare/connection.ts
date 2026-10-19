import { credentialEncryptionAvailable, toBase64Url } from "../providers/crypto";
import { storeCloudflareConnection } from "../storedKeys";
import { cloudflareClient, CloudflareApiError, type CloudflareClient, type Fetcher } from "./api";

/**
 * The Cloudflare connection (v3.12): one API token, stored encrypted in D1,
 * that lets the app finish its own setup and wire mail domains.
 *
 * A token is accepted only if it can see the exact Worker version that is
 * answering the request (CF_VERSION_METADATA): version IDs are unique, so that
 * proves the token belongs to the account running this app, not merely to an
 * account with a Worker of the same name.
 */
export type CloudflareConnection = { token: string; accountId: string; scriptName: string };
export type Located = { accountId: string; scriptName: string };

// Keeps setup within the Workers free plan's 50 subrequests per request.
const MAX_SCRIPTS_SCANNED = 20;

const NOT_THIS_ACCOUNT = "This token cannot see the Worker that runs this app. Create it in the Cloudflare account that runs this app, with Workers Scripts: Edit.";

async function hasVersion(api: CloudflareClient, accountId: string, scriptName: string, versionId: string): Promise<boolean> {
  try {
    await api(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/versions/${versionId}`);
    return true;
  } catch (error) {
    if (error instanceof CloudflareApiError && (error.status === 404 || error.status === 400)) return false;
    throw error;
  }
}

/** Find the account and Worker script this request is served by, as seen through the token. */
export async function locateWorker(env: Env, token: string, fetcher?: Fetcher): Promise<Located | { error: string }> {
  const versionId = env.CF_VERSION_METADATA?.id;
  if (!versionId || !/^[0-9a-f-]{36}$/i.test(versionId)) {
    return { error: "This check works only on the deployed app (its version is unknown here)." };
  }
  const api = cloudflareClient(token, fetcher);
  let accounts: Array<{ id: string }>;
  try {
    accounts = await api<Array<{ id: string }>>("/accounts?per_page=50");
  } catch (error) {
    if (error instanceof CloudflareApiError && (error.status === 400 || error.status === 401 || error.status === 403)) {
      return { error: "Cloudflare did not accept this token. Copy the token value itself (not its ID), and check it is active." };
    }
    throw error;
  }
  const hint = env.LTM_WORKER_NAME?.trim();
  try {
    for (const { id } of accounts) {
      if (!/^[0-9a-f]{32}$/i.test(id)) continue;
      if (hint && await hasVersion(api, id, hint, versionId)) return { accountId: id, scriptName: hint };
      // A Worker renamed in the Deploy button may not match the hint: check each script.
      const scripts = await api<Array<{ id: string }>>(`/accounts/${id}/workers/scripts`).catch(() => []);
      for (const script of scripts.slice(0, MAX_SCRIPTS_SCANNED)) {
        if (script.id !== hint && await hasVersion(api, id, script.id, versionId)) return { accountId: id, scriptName: script.id };
      }
    }
  } catch (error) {
    if (error instanceof CloudflareApiError && (error.status === 401 || error.status === 403)) return { error: NOT_THIS_ACCOUNT };
    throw error;
  }
  return { error: NOT_THIS_ACCOUNT };
}

/**
 * Create the PROVIDER_CREDENTIAL_KEY Worker secret when it is entirely absent,
 * and return it so the administrator can keep a copy. A key that is set but
 * invalid is never replaced: data encrypted with it would become unreadable.
 */
export async function ensureCredentialKey(env: Env, connection: CloudflareConnection, fetcher?: Fetcher): Promise<{ key: string | null } | { error: string }> {
  if (await credentialEncryptionAvailable(env)) return { key: null };
  if (env.PROVIDER_CREDENTIAL_KEY) {
    return { error: "PROVIDER_CREDENTIAL_KEY is set but is not a valid key. Fix or remove it under Worker → Settings → Variables & Secrets, then try again." };
  }
  const key = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const api = cloudflareClient(connection.token, fetcher);
  await api(`/accounts/${connection.accountId}/workers/scripts/${encodeURIComponent(connection.scriptName)}/secrets`, {
    method: "PUT",
    body: { name: "PROVIDER_CREDENTIAL_KEY", text: key, type: "secret_text" },
  });
  return { key };
}

/**
 * Verify a token, create the encryption key if the Worker has none, and store
 * the connection encrypted. Returns the new key (shown once) when one was created.
 */
export async function connectCloudflare(env: Env, token: string, fetcher?: Fetcher):
  Promise<{ connection: CloudflareConnection; generatedKey: string | null } | { error: string; status: number }> {
  let located: Located | { error: string };
  try {
    located = await locateWorker(env, token, fetcher);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not check the token", status: 502 };
  }
  if ("error" in located) return { error: located.error, status: 400 };
  const connection: CloudflareConnection = { token, ...located };
  let key: { key: string | null } | { error: string };
  try {
    key = await ensureCredentialKey(env, connection, fetcher);
  } catch (error) {
    return { error: `Could not create the encryption key: ${error instanceof Error ? error.message : "unknown error"}`, status: 502 };
  }
  if ("error" in key) return { error: key.error, status: 409 };
  // A key created just now reaches new isolates with the next version; encrypt with it directly.
  await storeCloudflareConnection(key.key ? { ...env, PROVIDER_CREDENTIAL_KEY: key.key } : env, connection);
  return { connection, generatedKey: key.key };
}
