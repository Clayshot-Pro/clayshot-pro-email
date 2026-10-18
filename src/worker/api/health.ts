import { appConfig } from "../appConfig";

export async function healthResponse(env: Env): Promise<Response> {
  const checks = {
    d1: false,
    r2: false,
  };

  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
    checks.d1 = true;
  } catch {
    checks.d1 = false;
  }

  try {
    await env.MAIL.list({ limit: 1 });
    checks.r2 = true;
  } catch {
    checks.r2 = false;
  }

  const ok = checks.d1 && checks.r2;

  return Response.json(
    {
      ok,
      service: "ltm-email-service",
      address: appConfig(env).primaryAddress,
      checks,
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
