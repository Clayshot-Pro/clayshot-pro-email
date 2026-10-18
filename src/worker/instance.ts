import { appConfig, publicInstanceInfo } from "./appConfig";
import { brandNames, instanceSettings } from "./branding";
import { THEME_BACKGROUNDS } from "./customization";

/** Branding the shell, manifest and public instance endpoint render. */
export type InstanceBranding = {
  name: string;
  shortName: string;
  themeColor: string;
  iconVersion: string | null;
};

const DEFAULT_THEME_COLOR = "#0d0c0b";

export async function instanceBranding(env: Env): Promise<InstanceBranding> {
  const settings = await instanceSettings(env);
  const names = brandNames(env, settings);
  return {
    name: names.name,
    shortName: names.shortName,
    // The default dark theme keeps the historical status-bar colour.
    themeColor: THEME_BACKGROUNDS[settings.defaultTheme] ?? DEFAULT_THEME_COLOR,
    iconVersion: settings.logoVersion,
  };
}

export async function instanceResponse(env: Env): Promise<Response> {
  const settings = await instanceSettings(env);
  const names = brandNames(env, settings);
  return Response.json({
    ...publicInstanceInfo(appConfig(env)),
    brandName: names.name,
    brandShortName: names.shortName,
    brandingSource: appConfig(env).brandingSource,
    logoVersion: settings.logoVersion,
    accent: settings.accent,
    defaultTheme: settings.defaultTheme,
    defaultIconSet: settings.defaultIconSet,
    lock: settings.lock,
  });
}

function iconUrl(branding: InstanceBranding, size: number): string {
  return branding.iconVersion
    ? `/api/instance/icon/${size}.png?v=${encodeURIComponent(branding.iconVersion)}`
    : "/apple-touch-icon.png?v=16";
}

export async function manifestResponse(env: Env): Promise<Response> {
  const branding = await instanceBranding(env);
  const icons = branding.iconVersion
    ? [192, 512].map(size => ({ src: iconUrl(branding, size), sizes: `${size}x${size}`, type: "image/png", purpose: "any" }))
    : [{ src: iconUrl(branding, 512), sizes: "1024x1024", type: "image/png", purpose: "any" }];
  return new Response(JSON.stringify({
    name: branding.name,
    short_name: branding.shortName,
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: branding.themeColor,
    theme_color: branding.themeColor,
    description: `${branding.name} webmail`,
    icons,
  }), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Mirrors the "/*" block of public/_headers so the rewritten shell keeps the
// same protections whether or not the asset server applied them.
const SHELL_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

/** Serve index.html with the instance name, so iOS sees it when installing the PWA. */
export async function shellResponse(request: Request, env: Env): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);
  if (!asset.ok || !(asset.headers.get("Content-Type") ?? "").includes("text/html")) return asset;
  let branding: InstanceBranding;
  try {
    branding = await instanceBranding(env);
  } catch {
    return asset;
  }
  const icon180 = iconUrl(branding, 180);
  const icon32 = branding.iconVersion ? iconUrl(branding, 32) : null;
  const rewritten = new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(branding.name); } })
    .on('meta[name="apple-mobile-web-app-title"]', { element(element) { element.setAttribute("content", branding.shortName); } })
    .on('meta[name="theme-color"]', { element(element) { element.setAttribute("content", branding.themeColor); } })
    .on('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]', {
      element(element) { element.setAttribute("href", icon180); },
    })
    .on('link[rel="icon"][type="image/png"]', {
      element(element) { if (icon32) element.setAttribute("href", icon32); },
    })
    .transform(asset);
  const headers = new Headers(rewritten.headers);
  // Vite's dev server injects inline module preambles that script-src 'self'
  // would block; production builds always get the full policy.
  if (!import.meta.env.DEV) {
    for (const [name, value] of Object.entries(SHELL_HEADERS)) {
      if (!headers.has(name)) headers.set(name, value);
    }
  }
  headers.set("Cache-Control", "no-store");
  return new Response(rewritten.body, { status: rewritten.status, headers });
}
