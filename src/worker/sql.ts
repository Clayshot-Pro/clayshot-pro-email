/**
 * LIKE pattern that matches `term` anywhere, as literal text: `%`, `_` and `\`
 * in the term are escaped. Use with `LIKE ? ESCAPE '\'`.
 */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}
