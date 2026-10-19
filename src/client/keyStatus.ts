/**
 * Setup status for Admin → Keys (v3.21): what is set up, what is missing and
 * what is optional, so the page can show it at a glance.
 */
type KeyState = "ok" | "missing" | "optional";
export type KeyCheck = { id: string; label: string; state: KeyState; chip: string; essential: boolean; impact: string };

type Source = "worker" | "stored" | "none";
type KeysSnapshot = {
  encryption: boolean;
  keys: Array<{ name: string; source: Source }>;
  push: { source: Source };
  cloudflare?: { connected: boolean };
};

const OPTIONAL: Record<string, { label: string; impact: string }> = {
  GOOGLE_CLIENT_ID: { label: "Google OAuth client ID", impact: "Gmail accounts can't be connected." },
  GOOGLE_CLIENT_SECRET: { label: "Google OAuth client secret", impact: "Gmail accounts can't be connected." },
  RESEND_API_KEY: { label: "Resend API key", impact: "Domains can't send through Resend." },
  RESEND_WEBHOOK_SECRET: { label: "Resend webhook signing secret", impact: "Resend delivery updates aren't received." },
  CF_EMAIL_SENDING_TOKEN: { label: "Cloudflare Email Sending API token", impact: "Sending uses the EMAIL binding." },
};

const check = (id: string, label: string, ok: boolean, essential: boolean, impact: string, chips = ["Set up", essential ? "Missing" : "Not set"]): KeyCheck =>
  ({ id, label, state: ok ? "ok" : essential ? "missing" : "optional", chip: ok ? chips[0] : chips[1], essential, impact });

/** Every key with its state; essential keys first. */
export function keyChecklist(data: KeysSnapshot): KeyCheck[] {
  return [
    check("encryption", "Encryption key", data.encryption, true, "Stored keys can't be saved and notifications can't be sent."),
    check("push", "Push notification keys", data.push.source !== "none", true,
      data.encryption ? "Created on the next request; reload in a minute." : "Created automatically once the encryption key is set."),
    check("cloudflare", "Cloudflare", Boolean(data.cloudflare?.connected), false,
      "Domains need manual setup.", ["Connected", "Not connected"]),
    ...data.keys.filter(key => key.name in OPTIONAL)
      .map(key => check(key.name, OPTIONAL[key.name].label, key.source !== "none", false, OPTIONAL[key.name].impact)),
  ];
}

/** Short summary for the top of the section and the admin page. */
export function keySummary(checks: KeyCheck[]): { tone: KeyState; title: string; missing: KeyCheck[] } {
  const missing = checks.filter(item => item.state === "missing");
  const ready = checks.filter(item => item.state === "ok").length;
  if (missing.length) {
    return { tone: "missing", title: `Setup incomplete: missing ${missing.map(item => item.label.toLowerCase()).join(" and ")}`, missing };
  }
  return { tone: "ok", title: `Essential keys are set up · ${ready} of ${checks.length} configured`, missing };
}
