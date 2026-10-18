import assert from "node:assert/strict";
import { preparePassword, checkPassword, hashPassword } from "../src/worker/passwordCrypto.ts";
import { adminPasswordError, mailboxPasswordError } from "../src/worker/mailboxPasswordPolicy.ts";

// Exercise the versioned password KDF: scrypt for new hashes and legacy PBKDF2 verification.
// Punctuation and Unicode are legal password characters; they are never
// interpolated into SQL, URLs or regular expressions.
for (const password of [
  "Complex?Password#2026!",
  "P@ssword?+[]{}~LongEnough",
  "Unicode?🌞-Password-Long-2026",
]) {
  assert.equal(mailboxPasswordError(password), null);
  const prepared = await preparePassword(password);
  assert.equal(prepared.iterations, -1);
  assert.equal(prepared.salt.length, 32);
  assert.match(prepared.salt, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(await checkPassword(password, {
    password_salt: prepared.salt,
    password_hash: prepared.hash,
    iterations: prepared.iterations,
  }), true);
  assert.equal(await checkPassword(password + "?", {
    password_salt: prepared.salt,
    password_hash: prepared.hash,
    iterations: prepared.iterations,
  }), false);
  assert.equal(await hashPassword(password, prepared.salt, prepared.iterations), prepared.hash);
}
console.log("PASS: new scrypt hashes accept special characters and verify correctly");

for (const password of ["Abcd?789", "LongAdmin?Password2026!", "𝒜bc?1234"]) {
  assert.equal(adminPasswordError(password), null, "admin password accepted");
  const prepared = await preparePassword(password,"admin");
  assert.equal(prepared.iterations,-1);
  assert.equal(await checkPassword(password,{
    password_salt:prepared.salt,
    password_hash:prepared.hash,
    iterations:prepared.iterations,
  }),true);
}
for (const password of ["abc", "a".repeat(33), "aaaa"]) {
  assert.notEqual(adminPasswordError(password),null);
}
assert.equal(adminPasswordError("Abcd?789"),null);
assert.equal(mailboxPasswordError("Abcd?789"),null);
for (const policy of ["admin", "mailbox"]) {
  const password = "Ab1!";
  const credentials = await preparePassword(password, policy);
  assert.equal(await checkPassword(password, {
    password_salt: credentials.salt, password_hash: credentials.hash, iterations: credentials.iterations,
  }), true, "4-character password verifies");
}
const legacyPassword = "LegacyAccount?Password2026";
const salt = (await preparePassword(legacyPassword)).salt;
const legacyHash = await hashPassword(legacyPassword,salt,310000);
const key = await crypto.subtle.importKey("raw",new TextEncoder().encode(legacyPassword),"PBKDF2",false,["deriveBits"]);
const legacySalt = Uint8Array.from(atob(salt.replace(/-/g,"+").replace(/_/g,"/")),x=>x.charCodeAt(0));
const bits = await crypto.subtle.deriveBits({name:"PBKDF2",salt:legacySalt,hash:"SHA-256",iterations:310000},key,256);
const webCryptoHash = btoa(String.fromCharCode(...new Uint8Array(bits))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
assert.equal(legacyHash,webCryptoHash,"legacy PBKDF2 hashes remain byte-compatible");
assert.equal(await checkPassword(legacyPassword,{
  password_salt:salt,password_hash:legacyHash,iterations:310000,
}),true);
console.log("PASS: Cloudflare-compatible new scrypt hashes, admin/mailbox 4–32 and legacy PBKDF2 verification");
