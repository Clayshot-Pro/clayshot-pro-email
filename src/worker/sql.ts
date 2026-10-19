/**
 * LIKE pattern that matches `term` anywhere, as literal text: `%`, `_` and `\`
 * in the term are escaped. Use with `LIKE ? ESCAPE '\'`.
 */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

/** D1 binds at most 100 parameters per statement; long IN-lists are split into slices of this size. */
export const IN_LIST_CHUNK = 90;

/** `values` in consecutive slices of at most `size`. */
export function chunked<T>(values: readonly T[], size = IN_LIST_CHUNK): T[][] {
  const slices: T[][] = [];
  for (let start = 0; start < values.length; start += size) slices.push(values.slice(start, start + size));
  return slices;
}
