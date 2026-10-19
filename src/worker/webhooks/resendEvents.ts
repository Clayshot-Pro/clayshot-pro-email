/**
 * Pure Resend webhook helpers: Svix signature verification and event
 * interpretation. Network and D1 work lives in resend.ts.
 */
import { constantTimeEqual } from "../constantTime.ts";

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}


export type SvixHeaders = { id: string | null; timestamp: string | null; signature: string | null };

/** Verify a Svix-signed payload: HMAC-SHA256 over "id.timestamp.body". */
export async function verifySvix(secret: string, headers: SvixHeaders, body: string, nowSeconds: number): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature || id.length > 200 || signature.length > 2000) return false;
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > MAX_TIMESTAMP_SKEW_SECONDS) return false;
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = base64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  } catch {
    return false;
  }
  if (!keyBytes.length) return false;
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  const expected = btoa(String.fromCharCode(...mac));
  return signature.split(" ").some(part => {
    const [version, value] = part.split(",", 2);
    return version === "v1" && typeof value === "string" && constantTimeEqual(value, expected);
  });
}

export type DeliveryStatus = "sent" | "delayed" | "delivered" | "bounced" | "complained" | "failed";
export type EventEffect = { status: DeliveryStatus; suppress: "hard_bounce" | "complaint" | null };

const RANK: Record<string, number> = { sent: 0, delayed: 1, delivered: 2, failed: 3, bounced: 3, complained: 4 };

/** Never let a later, milder event (delayed after delivered) overwrite a worse one. */
export function shouldReplaceStatus(current: string | null, next: DeliveryStatus): boolean {
  return (RANK[next] ?? 0) >= (RANK[current ?? "sent"] ?? 0);
}

export type ResendEvent = {
  type?: unknown;
  data?: { email_id?: unknown; message_id?: unknown; to?: unknown; bounce?: { type?: unknown } | null } | null;
};

export function eventEffect(event: ResendEvent): EventEffect | null {
  switch (event.type) {
    case "email.delivered": return { status: "delivered", suppress: null };
    case "email.delivery_delayed": return { status: "delayed", suppress: null };
    case "email.failed": return { status: "failed", suppress: null };
    case "email.complained": return { status: "complained", suppress: "complaint" };
    case "email.bounced": {
      const kind = typeof event.data?.bounce?.type === "string" ? event.data.bounce.type.toLowerCase() : "";
      // Only permanent bounces suppress; transient ones may succeed later.
      const transient = kind === "transient" || kind === "temporary" || kind === "undetermined";
      return { status: "bounced", suppress: transient ? null : "hard_bounce" };
    }
    default: return null;
  }
}

/** Recipients safe to suppress: only when the event names exactly one recipient. */
export function suppressionTargets(event: ResendEvent): string[] {
  const to = Array.isArray(event.data?.to) ? event.data.to.filter((value): value is string => typeof value === "string") : [];
  const single = to.length === 1 ? to[0].trim().toLowerCase() : "";
  const address = single.match(/<([^>]+)>$/)?.[1] ?? single;
  return address && address.length <= 254 && /^[^\s@<>]+@[^\s@<>]+$/.test(address) ? [address] : [];
}
