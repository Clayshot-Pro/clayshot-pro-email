/**
 * The Cloudflare API token the app uses for setup and domain wiring (v3.12).
 * The link opens Cloudflare's token form with the documented permissions
 * already selected; Cloudflare publishes no template keys for the two email
 * permissions, so those are added by hand.
 */
const PREFILLED = [
  { key: "workers_scripts", type: "edit" },
  { key: "zone", type: "read" },
  { key: "zone_settings", type: "edit" },
  { key: "dns", type: "edit" },
];

export const CLOUDFLARE_TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?${new URLSearchParams({
  permissionGroupKeys: JSON.stringify(PREFILLED),
  accountId: "*",
  zoneId: "all",
  name: "Mail app",
})}`;

/** Every permission the token needs, as Cloudflare's token form names them. */
export const CLOUDFLARE_TOKEN_PERMISSIONS = [
  { scope: "Account", name: "Workers Scripts", access: "Edit", prefilled: true },
  { scope: "Account", name: "Email Sending", access: "Edit", prefilled: false },
  { scope: "Zone", name: "Zone", access: "Read", prefilled: true },
  { scope: "Zone", name: "Zone Settings", access: "Edit", prefilled: true },
  { scope: "Zone", name: "DNS", access: "Edit", prefilled: true },
  { scope: "Zone", name: "Email Routing Rules", access: "Edit", prefilled: false },
] as const;

export type ConnectStep = { id: string; label: string; status: "done" | "skipped" | "failed" | "action"; detail: string };
export type ConnectReport = {
  domain: string;
  steps: ConnectStep[];
  mxConflict: Array<{ host: string; priority: number }> | null;
  catchAllConflict: string | null;
  routingReady: boolean;
};
