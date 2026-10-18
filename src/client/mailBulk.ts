/** Selection is based on the currently visible/filter-matched mail rows.
 * The API accepts at most 50 IDs per bulk request, but the UI can select
 * all visible results and submit them in bounded chunks. */
export const BULK_REQUEST_LIMIT = 50;

export function toggleVisibleSelection(selected: string[], visibleIds: string[]): string[] {
  const visible = [...new Set(visibleIds)];
  if (!visible.length) return selected;
  const allVisibleSelected = visible.every(id => selected.includes(id));
  if (allVisibleSelected) {
    const visibleSet = new Set(visible);
    return selected.filter(id => !visibleSet.has(id));
  }
  return [...new Set([...selected, ...visible])];
}

export function chunkBulkMessageIds(ids: string[]): string[][] {
  const unique = [...new Set(ids)];
  const result: string[][] = [];
  for (let index = 0; index < unique.length; index += BULK_REQUEST_LIMIT) {
    result.push(unique.slice(index, index + BULK_REQUEST_LIMIT));
  }
  return result;
}
