/** Client-side routing only. The Worker authenticates the exact admin identity. */
export function isAdminLoginEmail(email: string): boolean {
  return /^admin@[^\s@]+$/i.test(email.trim());
}
