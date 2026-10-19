import { pbkdf2Sync, scryptSync } from "node:crypto";
import { adminPasswordError, mailboxPasswordError } from "./mailboxPasswordPolicy.ts";

const encoder = new TextEncoder();
// Legacy 310k-iteration PBKDF2 passwords are still verifiable. New records use
// scrypt, which does not invoke Workers' 100k PBKDF2 iteration limit.
const SCRYPT_V1 = -1;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 32 * 1024 * 1024;

function encode(bytes: Uint8Array): string {
  let result = "";
  for (const value of bytes) result += String.fromCharCode(value);
  return btoa(result).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** KDF version is stored in the pre-existing integer "iterations" column.
 * -1 = scrypt v1 (N=2^14, r=8, p=1, 32-byte hash).
 * Positive values = legacy PBKDF2-SHA256 with that iteration count.
 */
export async function hashPassword(password: string, salt: string, iterations = SCRYPT_V1): Promise<string> {
  if (iterations !== SCRYPT_V1 &&
    (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1_000_000)) {
    throw new Error("Unsupported password hash parameters");
  }
  const saltBytes = decode(salt);
  if (saltBytes.length < 16 || saltBytes.length > 64) {
    throw new Error("Invalid password salt");
  }
  if (iterations === SCRYPT_V1) {
    return encode(scryptSync(encoder.encode(password), saltBytes, 32, {
      N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
    }));
  }
  return encode(pbkdf2Sync(encoder.encode(password), saltBytes, iterations, 32, "sha256"));
}
import { constantTimeEqual } from "./constantTime.ts";
export type PasswordHash = { salt: string; hash: string; iterations: number };
export async function preparePassword(
  password: string,
  policy: "admin" | "mailbox" = "mailbox",
): Promise<PasswordHash> {
  const invalid = policy === "admin" ? adminPasswordError(password) : mailboxPasswordError(password);
  if (invalid) throw new Error(invalid);
  const salt = encode(crypto.getRandomValues(new Uint8Array(24)));
  return { salt, hash: await hashPassword(password, salt, SCRYPT_V1), iterations: SCRYPT_V1 };
}
export async function checkPassword(
  password: string,
  row: { password_salt: string; password_hash: string; iterations: number } | null,
): Promise<boolean> {
  if (password.length > 128) return false;
  // Perform a comparable derivation even if the account doesn't exist.
  const computed = await hashPassword(
    password,
    row?.password_salt ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    row?.iterations ?? SCRYPT_V1,
  );
  return Boolean(row && constantTimeEqual(row.password_hash, computed));
}
