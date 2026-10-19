import { version } from "../../package.json";

/**
 * The running version and the latest release of the project repository
 * (v3.13). Instances deployed from a GitHub fork update with "Sync fork";
 * the admin panel says when there is something to sync.
 */
export const APP_VERSION: string = version;
const PROJECT_URL = "https://github.com/LiamTheMo/LTM-Email-Service";
const LATEST_URL = `https://raw.githubusercontent.com${new URL(PROJECT_URL).pathname}/main/package.json`;
const CHECK_MS = 6 * 60 * 60 * 1000;

/** Numeric comparison of dotted versions: 1 if a is newer, -1 if older, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split(/[.-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

let latest: { value: string | null; at: number } | null = null;

/** The version on the project's main branch; cached per isolate, null when unreachable. */
async function latestVersion(fetcher: typeof fetch = fetch): Promise<string | null> {
  if (latest && Date.now() - latest.at < CHECK_MS) return latest.value;
  const response = await fetcher(LATEST_URL, { headers: { Accept: "application/json" } }).catch(() => null);
  const body = response?.ok ? await response.json().catch(() => null) as { version?: unknown } | null : null;
  const value = typeof body?.version === "string" && /^\d+\.\d+\.\d+/.test(body.version) ? body.version : null;
  latest = { value, at: Date.now() };
  return value;
}

/** GET /api/admin/version */
export async function versionResponse(fetcher?: typeof fetch): Promise<Response> {
  const newest = await latestVersion(fetcher);
  return Response.json({
    current: APP_VERSION,
    latest: newest,
    updateAvailable: newest !== null && compareVersions(newest, APP_VERSION) > 0,
    repository: PROJECT_URL,
  }, { headers: { "Cache-Control": "no-store" } });
}
