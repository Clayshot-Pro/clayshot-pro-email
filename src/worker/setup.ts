import { initializeInstance, isInitialized } from "./domains";
import { brandNames, instanceSettings } from "./branding";

const encoder = new TextEncoder();

function tokenMatches(expected: string | undefined, supplied: unknown): boolean {
  if (!expected || typeof supplied !== "string") return false;
  const a = encoder.encode(expected);
  const b = encoder.encode(supplied);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index];
  return diff === 0;
}

/**
 * POST /api/setup — first-run instance setup, before the owner passkey exists.
 * Requires AUTH_SETUP_TOKEN and only works while the instance has no primary
 * domain, so it can never rename an established install.
 */
export async function setupInstance(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ setupToken?: unknown; primaryAddress?: unknown; displayName?: unknown }>().catch(() => null);
  if (!tokenMatches(env.AUTH_SETUP_TOKEN, body?.setupToken)) {
    return Response.json({ error: "Invalid setup token" }, { status: 401 });
  }
  if (await isInitialized(env)) return Response.json({ error: "This instance is already set up" }, { status: 409 });
  const address = typeof body?.primaryAddress === "string" ? body.primaryAddress : "";
  const displayName = typeof body?.displayName === "string" && body.displayName.trim()
    ? body.displayName.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)
    : brandNames(await instanceSettings(env)).name;
  const problem = await initializeInstance(env, address, displayName);
  if (problem) return Response.json({ error: problem }, { status: 400 });
  return Response.json({ ok: true });
}
