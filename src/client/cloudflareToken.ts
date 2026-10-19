/**
 * One Cloudflare API token does everything: GitHub Actions deploys with it
 * (the fork's CLOUDFLARE_API_TOKEN secret, which each deploy also hands to the
 * app) and the app uses it for setup and domain wiring. `key` is the name
 * Cloudflare's token form takes to pre-select a permission; Cloudflare
 * publishes none for the two email permissions, so those are added by hand.
 */
export const CLOUDFLARE_TOKEN_PERMISSIONS = [
  { scope: "Account", name: "Workers Scripts", access: "Edit", key: "workers_scripts" },
  { scope: "Account", name: "D1", access: "Edit", key: "d1" },
  { scope: "Account", name: "Workers R2 Storage", access: "Edit", key: "workers_r2" },
  { scope: "Account", name: "Account Settings", access: "Read", key: "account_settings" },
  { scope: "Account", name: "Email Sending", access: "Edit", key: null },
  { scope: "Zone", name: "Zone", access: "Read", key: "zone" },
  { scope: "Zone", name: "Zone Settings", access: "Edit", key: "zone_settings" },
  { scope: "Zone", name: "DNS", access: "Edit", key: "dns" },
  { scope: "Zone", name: "Email Routing Rules", access: "Edit", key: null },
] as const;

/** Cloudflare's token form with every permission it can pre-select already selected. */
export const CLOUDFLARE_TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?${new URLSearchParams({
  permissionGroupKeys: JSON.stringify(CLOUDFLARE_TOKEN_PERMISSIONS.flatMap(permission =>
    permission.key ? [{ key: permission.key, type: permission.access.toLowerCase() }] : [])),
  accountId: "*",
  zoneId: "all",
  name: "Mail app",
})}`;

type ConnectStep = { id: string; label: string; status: "done" | "skipped" | "failed" | "action"; detail: string };
export type ConnectReport = {
  domain: string;
  steps: ConnectStep[];
  mxConflict: Array<{ host: string; priority: number }> | null;
  catchAllConflict: string | null;
  routingReady: boolean;
};
