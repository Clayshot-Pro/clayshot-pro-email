/** Dependency-free constant-time comparisons shared by auth, setup and webhooks. */
export function constantTimeEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
}

/** Compare a supplied secret with a configured one; false when either is missing. */
export function secretMatches(expected: string | undefined, supplied: unknown): boolean {
  return Boolean(expected) && typeof supplied === "string" && supplied.length > 0 && constantTimeEqual(expected!, supplied);
}
