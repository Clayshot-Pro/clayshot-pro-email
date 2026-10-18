import { initializeInstance, isInitialized } from "./domains";
import { secretMatches } from "./constantTime";

/**
 * POST /api/setup — first-run instance setup, before the owner passkey exists:
 * records the main mail domain and creates admin@ on it. Requires
 * AUTH_SETUP_TOKEN and only works while the instance has no main domain, so it
 * can never rename an established install.
 */
export async function setupInstance(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ setupToken?: unknown; domain?: unknown }>().catch(() => null);
  if (!secretMatches(env.AUTH_SETUP_TOKEN, body?.setupToken)) {
    return Response.json({ error: "Invalid setup token" }, { status: 401 });
  }
  if (await isInitialized(env)) return Response.json({ error: "This instance is already set up" }, { status: 409 });
  const problem = await initializeInstance(env, typeof body?.domain === "string" ? body.domain : "");
  if (problem) return Response.json({ error: problem }, { status: 400 });
  return Response.json({ ok: true });
}
