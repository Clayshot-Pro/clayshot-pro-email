/** Dependency-free byte encoding and hashing helpers shared by the Worker. */
const utf8 = new TextEncoder();

/** Standard base64. Encodes in 32 KiB chunks so large buffers never overflow the call stack. */
export function toBase64(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function toBase64Url(input: Uint8Array | ArrayBuffer): string {
  return toBase64(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Decodes base64url (or standard base64), padded or not. Throws on invalid input. */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function toHex(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of a UTF-8 string or of raw bytes, as lowercase hex. */
export async function sha256Hex(value: string | BufferSource): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", typeof value === "string" ? utf8.encode(value) : value));
}

export function randomBase64Url(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}
