import { isValidDomain } from "./appConfig";
import { saveAdminPassword } from "./adminAuth";
import { hasCredential } from "./auth";
import { normalizeToken } from "./cloudflare/api";
import { connectCloudflare, type CloudflareConnection } from "./cloudflare/connection";
import { connectDomain, type ConnectReport } from "./cloudflare/domainConnect";
import { secretMatches } from "./constantTime";
import { activateIfReady, domainRow, initializeInstance, isInitialized, primaryDomain } from "./domains";
import { adminPasswordError } from "./mailboxPasswordPolicy";
import { issueSetupGrant } from "./setupGrants";

const jsonError = (error: string, status: number) => Response.json({ error }, { status });

/**
 * POST /api/setup — first-run setup, before the owner passkey exists (v3.12):
 * { domain, adminPassword, cloudflareToken } or, for installs without a
 * token, { …, setupToken } matching AUTH_SETUP_TOKEN.
 *
 * A Cloudflare token proves ownership (it must see this exact Worker
 * version), creates PROVIDER_CREDENTIAL_KEY if the Worker has none, is stored
 * encrypted, and wires the main mail domain. Setup then records the main
 * domain (creating admin@) and the administrator password, and returns a
 * short-lived grant for registering the owner passkey. It can be repeated
 * until the passkey exists; the main domain, once chosen, never changes.
 */
export async function setupInstance(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ setupToken?: unknown; cloudflareToken?: unknown; domain?: unknown; adminPassword?: unknown }>()
    .catch(() => null);
  if (await hasCredential(env)) return jsonError("This instance is already set up", 409);
  const initialized = await isInitialized(env);
  const domain = typeof body?.domain === "string" ? body.domain.trim().toLowerCase().replace(/^.*@/, "") : "";
  if (!initialized && !isValidDomain(domain)) return jsonError("Enter your mail domain, for example example.com", 400);
  const passwordProblem = adminPasswordError(body?.adminPassword);
  if (passwordProblem) return jsonError(passwordProblem, 400);

  let connection: CloudflareConnection | null = null;
  let generatedKey: string | null = null;
  if (!secretMatches(env.AUTH_SETUP_TOKEN, body?.setupToken)) {
    const token = normalizeToken(body?.cloudflareToken);
    if (!token) {
      return jsonError(body?.setupToken ? "Invalid setup token" : "Paste your Cloudflare API token", 401);
    }
    const result = await connectCloudflare(env, token);
    if ("error" in result) return jsonError(result.error, result.status === 400 ? 401 : result.status);
    ({ connection, generatedKey } = result);
  }

  if (!initialized) {
    const problem = await initializeInstance(env, domain);
    if (problem) return jsonError(problem, 400);
  }
  const saved = await saveAdminPassword(env, body?.adminPassword, undefined, true);
  if (saved.error) return jsonError(saved.error, 400);

  let domainReport: ConnectReport | null = null;
  const main = await primaryDomain(env, true);
  const row = main ? await domainRow(env, main) : null;
  if (connection && row) {
    domainReport = await connectDomain(connection, row.domain, { sending: row.outbound_transport === "cloudflare" });
    await activateIfReady(env, row, domainReport.routingReady);
  }
  return Response.json({ ok: true, grant: await issueSetupGrant(env), generatedKey, domain: main, domainReport },
    { headers: { "Cache-Control": "no-store" } });
}
