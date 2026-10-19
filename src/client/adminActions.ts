import { readJson } from "./http";
import { startAuthentication } from "@simplewebauthn/browser";

export type AdminApproval = {
  token: string;
  pathname: string;
  method: string;
  body: string | undefined;
};

const jsonResult = (response: Response) => readJson(response, "Administrator passkey verification failed");
function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2,"0")).join("");
}

export async function approveAdminAction(pathname: string, method: string, body?: string): Promise<AdminApproval> {
  // Hash, rather than retransmit, sensitive request bodies (including passwords).
  const bytes = new TextEncoder().encode(body ?? "");
  const bodyHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  const options = await jsonResult(await fetch("/api/admin/step-up/options", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pathname, method, bodyHash }),
  }));
  if (typeof options.challengeId !== "string" || !options.options) throw new Error("Passkey challenge unavailable");
  const signed = await startAuthentication({
    optionsJSON: options.options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
  });
  const verified = await jsonResult(await fetch("/api/admin/step-up/verify", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId: options.challengeId, response: signed }),
  }));
  if (typeof verified.approval !== "string") throw new Error("Passkey approval unavailable");
  return { token: verified.approval, pathname, method, body };
}

export async function adminActionFetch(
  pathname: string, method: string, body?: string, reusableApproval?: AdminApproval,
): Promise<Response> {
  if (reusableApproval && (reusableApproval.pathname !== pathname || reusableApproval.method !== method
    || reusableApproval.body !== body)) throw new Error("Passkey approval does not match the operation");
  const approval = reusableApproval ?? await approveAdminAction(pathname, method, body);
  return fetch(pathname, {
    method, cache: "no-store",
    headers: {
      "X-Admin-Step-Up": approval.token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body,
  });
}

/** GET, or an administrator mutation behind a passkey approval (reused when given), returning the JSON body. */
export async function adminJson(path: string, method: string, body: unknown, fallback: string, approval?: AdminApproval): Promise<Record<string, unknown>> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const response = method === "GET"
    ? await fetch(path, { cache: "no-store" })
    : await adminActionFetch(path, method, payload, approval);
  return readJson(response, fallback);
}
