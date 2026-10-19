import { jsonError } from "../http";
import { adminKeysResponse, removeCloudflareConnection } from "../storedKeys";
import { normalizeToken } from "./api";
import { connectCloudflare } from "./connection";


/** PUT /api/admin/cloudflare { token } (administrator step-up): connect or replace the token. */
export async function saveCloudflareToken(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ token?: unknown }>().catch(() => null);
  const token = normalizeToken(body?.token);
  if (!token) return jsonError("Paste the Cloudflare API token value.", 400);
  const result = await connectCloudflare(env, token);
  if ("error" in result) return jsonError(result.error, result.status);
  const keys = await (await adminKeysResponse(env)).json<Record<string, unknown>>();
  return Response.json({ ...keys, generatedKey: result.generatedKey }, { headers: { "Cache-Control": "no-store" } });
}

/** DELETE /api/admin/cloudflare (administrator step-up). */
export async function deleteCloudflareToken(env: Env): Promise<Response> {
  await removeCloudflareConnection(env);
  return adminKeysResponse(env);
}
