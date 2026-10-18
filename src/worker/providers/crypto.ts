const VERSION = "v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

async function credentialKey(env: Env): Promise<CryptoKey> {
  if (!env.PROVIDER_CREDENTIAL_KEY) {
    throw new Error("Provider credential encryption is not configured");
  }

  let raw: Uint8Array;
  try {
    raw = fromBase64Url(env.PROVIDER_CREDENTIAL_KEY);
  } catch {
    throw new Error("Provider credential encryption key is invalid");
  }

  if (raw.byteLength !== 32) {
    throw new Error("Provider credential encryption key is invalid");
  }

  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** True when PROVIDER_CREDENTIAL_KEY is set and is a valid 32-byte key. */
export async function credentialEncryptionAvailable(env: Env): Promise<boolean> {
  return credentialKey(env).then(() => true, () => false);
}

export async function encryptSecret(env: Env, value: unknown, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(encoder.encode(aad)),
    },
    await credentialKey(env),
    toArrayBuffer(encoder.encode(JSON.stringify(value))),
  );

  return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret<T>(env: Env, envelope: string, aad: string): Promise<T> {
  const [version, iv, ciphertext, ...rest] = envelope.split(".");
  if (version !== VERSION || !iv || !ciphertext || rest.length) {
    throw new Error("Encrypted credential envelope is invalid");
  }

  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(fromBase64Url(iv)),
      additionalData: toArrayBuffer(encoder.encode(aad)),
    },
    await credentialKey(env),
    toArrayBuffer(fromBase64Url(ciphertext)),
  );

  return JSON.parse(decoder.decode(plaintext)) as T;
}
