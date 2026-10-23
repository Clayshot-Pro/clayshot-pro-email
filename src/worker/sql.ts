/** D1 rejects a LIKE or GLOB pattern longer than 50 bytes ("LIKE or GLOB pattern too complex"). */
export const LIKE_PATTERN_MAX_BYTES = 50;

/**
 * LIKE pattern that matches `term` anywhere, as literal text: `%`, `_` and `\`
 * in the term are escaped. Use with `LIKE ? ESCAPE '\'`. The pattern stays
 * within D1's 50-byte limit: a longer term is matched on its first characters
 * (a search used to fail outright from about 48 characters).
 */
export function likeContains(term: string): string {
  const encoder = new TextEncoder();
  let body = "";
  let bytes = 2;
  for (const char of term) {
    const piece = /[\\%_]/.test(char) ? `\\${char}` : char;
    const size = encoder.encode(piece).length;
    if (bytes + size > LIKE_PATTERN_MAX_BYTES) break;
    body += piece;
    bytes += size;
  }
  return `%${body}%`;
}

/** D1 binds at most 100 parameters per statement; long IN-lists are split into slices of this size. */
export const IN_LIST_CHUNK = 90;

/** `values` in consecutive slices of at most `size`. */
export function chunked<T>(values: readonly T[], size = IN_LIST_CHUNK): T[][] {
  const slices: T[][] = [];
  for (let start = 0; start < values.length; start += size) slices.push(values.slice(start, start + size));
  return slices;
}
