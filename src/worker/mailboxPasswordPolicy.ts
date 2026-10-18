/** Creation/update limits only; historical password hashes remain valid on login. */
function passwordError(password: unknown, role: "mailbox" | "administrator"): string | null {
  if (typeof password !== "string") {
    return role === "administrator" ? "Enter an administrator password" : "Enter a password";
  }
  if (password.length < 4) return "Use at least 4 characters";
  if (password.length > 32) return "Use at most 32 characters";
  if (password !== password.trim()) return "Remove leading or trailing spaces";
  if (/[\u0000-\u001f\u007f]/.test(password)) return "Remove control characters";
  if (new Set(password).size < 2) return "Use a less repetitive password";
  return null;
}
export const mailboxPasswordError = (password: unknown): string | null => passwordError(password, "mailbox");
export const adminPasswordError = (password: unknown): string | null => passwordError(password, "administrator");
