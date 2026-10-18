import { appConfig } from "./appConfig";
import { deviceAuthorized } from "./deviceAuth";
import {
  effectiveAppearance, ICON_SIZES, pngDimensions, readPreferences, readSettings, updatePreferences, updateSettings,
  type InstanceSettings,
} from "./customization";

const jsonError = (error: string, status: number) => Response.json({ error }, { status });
const MAX_ICON_BYTES = 1024 * 1024;

export async function instanceSettings(env: Env): Promise<InstanceSettings> {
  const row = await env.DB.prepare("SELECT settings FROM instance_settings WHERE id = 1").first<{ settings: string }>()
    .catch(() => null);
  let raw: unknown = {};
  try { raw = row ? JSON.parse(row.settings) : {}; } catch { raw = {}; }
  return readSettings(raw);
}

/** Name precedence: BRANDING_SOURCE=env > admin settings > .env defaults. */
export function brandNames(env: Env, settings: InstanceSettings): { name: string; shortName: string } {
  const config = appConfig(env);
  if (config.brandingSource === "env") return { name: config.brand.name, shortName: config.brand.shortName };
  const name = settings.brandName ?? config.brand.name;
  return { name, shortName: settings.brandShortName ?? (settings.brandName ? name.slice(0, 20) : config.brand.shortName) };
}

async function storeSettings(env: Env, settings: InstanceSettings): Promise<void> {
  await env.DB.prepare(`INSERT INTO instance_settings (id, settings, updated_at) VALUES (1, ?1, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = CURRENT_TIMESTAMP`)
    .bind(JSON.stringify(settings)).run();
}

export async function adminSettingsResponse(env: Env): Promise<Response> {
  const settings = await instanceSettings(env);
  return Response.json({ settings, brandingSource: appConfig(env).brandingSource, effectiveNames: brandNames(env, settings) });
}

/** PUT /api/admin/instance (admin + step-up). */
export async function saveInstanceSettings(request: Request, env: Env): Promise<Response> {
  const input = await request.json().catch(() => null);
  const current = await instanceSettings(env);
  const result = updateSettings(current, input, appConfig(env).brandingSource === "env");
  if (!result.ok) return jsonError(result.error, result.status);
  await storeSettings(env, result.value);
  return adminSettingsResponse(env);
}

function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_ICON_BYTES / 3) * 4 + 4) return null;
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * PUT /api/admin/instance/logo (admin + step-up). The admin's browser resizes
 * the source image; the Worker only accepts square PNGs of the exact sizes.
 * SVG is never accepted: served from this origin it could carry script.
 */
export async function uploadLogo(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ icons?: Record<string, unknown> }>().catch(() => null);
  if (!body?.icons || typeof body.icons !== "object") return jsonError("Expected generated icons", 400);
  const files: { size: number; bytes: Uint8Array }[] = [];
  for (const size of ICON_SIZES) {
    const bytes = decodeBase64(body.icons[String(size)]);
    if (!bytes || bytes.byteLength > MAX_ICON_BYTES) return jsonError(`Icon ${size}px is missing or larger than 1 MB`, 400);
    const dimensions = pngDimensions(bytes);
    if (!dimensions) return jsonError(`Icon ${size}px is not a PNG`, 400);
    if (dimensions.width !== size || dimensions.height !== size) return jsonError(`Icon ${size}px has the wrong dimensions`, 400);
    files.push({ size, bytes });
  }
  const version = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  await Promise.all(files.map(file => env.MAIL.put(`instance/icon/${file.size}.png`, file.bytes, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { version },
  })));
  const settings = await instanceSettings(env);
  await storeSettings(env, { ...settings, logoVersion: version });
  return Response.json({ logoVersion: version });
}

/** DELETE /api/admin/instance/logo: back to the bundled default icon. */
export async function deleteLogo(env: Env): Promise<Response> {
  await env.MAIL.delete(ICON_SIZES.map(size => `instance/icon/${size}.png`));
  const settings = await instanceSettings(env);
  await storeSettings(env, { ...settings, logoVersion: null });
  return Response.json({ logoVersion: null });
}

/** GET /api/instance/icon/:size.png (public). */
export async function iconResponse(request: Request, env: Env, size: number): Promise<Response> {
  if (!(ICON_SIZES as readonly number[]).includes(size)) return jsonError("Not found", 404);
  const object = await env.MAIL.get(`instance/icon/${size}.png`);
  if (!object) return env.ASSETS.fetch(new Request(new URL("/apple-touch-icon.png", request.url)));
  return new Response(object.body, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

async function preferencesFor(env: Env, accountId: string) {
  const row = await env.DB.prepare("SELECT preferences FROM account_preferences WHERE account_id = ?1")
    .bind(accountId).first<{ preferences: string }>();
  let raw: unknown = {};
  try { raw = row ? JSON.parse(row.preferences) : {}; } catch { raw = {}; }
  return readPreferences(raw);
}

/** Map of account id → stored account colour (native admin colour wins). */
export async function accountColors(env: Env, ids: string[]): Promise<Map<string, string>> {
  const colors = new Map<string, string>();
  if (!ids.length) return colors;
  const marks = ids.map(() => "?").join(",");
  const [prefs, natives] = await Promise.all([
    env.DB.prepare(`SELECT account_id, preferences FROM account_preferences WHERE account_id IN (${marks})`)
      .bind(...ids).all<{ account_id: string; preferences: string }>(),
    env.DB.prepare(`SELECT id, accent_color FROM native_mailboxes WHERE accent_color IS NOT NULL AND id IN (${marks})`)
      .bind(...ids).all<{ id: string; accent_color: string }>(),
  ]).catch(() => [{ results: [] }, { results: [] }] as const);
  const settings = await instanceSettings(env);
  for (const row of prefs.results) {
    let raw: unknown = {};
    try { raw = JSON.parse(row.preferences); } catch { raw = {}; }
    const color = readPreferences(raw).accountColor;
    if (color && !settings.lock.accent) colors.set(row.account_id, color);
  }
  for (const row of natives.results) colors.set(row.id, row.accent_color);
  return colors;
}

async function authorizedAccount(request: Request, env: Env, url: URL): Promise<string | Response> {
  const accountId = url.searchParams.get("accountId")?.trim() ?? "";
  if (!accountId || accountId.length > 150) return jsonError("accountId is required", 400);
  if (!(await deviceAuthorized(request, env, accountId))) return jsonError("Account not signed in on this device", 403);
  return accountId;
}

/** GET /api/preferences?accountId= */
export async function getPreferences(request: Request, env: Env, url: URL): Promise<Response> {
  const accountId = await authorizedAccount(request, env, url);
  if (accountId instanceof Response) return accountId;
  const [settings, preferences] = await Promise.all([instanceSettings(env), preferencesFor(env, accountId)]);
  return Response.json({ preferences, effective: effectiveAppearance(settings, preferences), lock: settings.lock });
}

/** PUT /api/preferences?accountId= — locked fields are rejected with 403. */
export async function savePreferences(request: Request, env: Env, url: URL): Promise<Response> {
  const accountId = await authorizedAccount(request, env, url);
  if (accountId instanceof Response) return accountId;
  const input = await request.json().catch(() => null);
  const [settings, current] = await Promise.all([instanceSettings(env), preferencesFor(env, accountId)]);
  const result = updatePreferences(current, input, settings);
  if (!result.ok) return jsonError(result.error, result.status);
  await env.DB.prepare(`INSERT INTO account_preferences (account_id, preferences, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
    ON CONFLICT(account_id) DO UPDATE SET preferences = excluded.preferences, updated_at = CURRENT_TIMESTAMP`)
    .bind(accountId, JSON.stringify(result.value)).run();
  return Response.json({ preferences: result.value, effective: effectiveAppearance(settings, result.value), lock: settings.lock });
}
