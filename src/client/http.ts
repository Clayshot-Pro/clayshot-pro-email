/** Reads a JSON body (an unreadable body reads as {}) and throws the server's `error`, or `fallback`, when the response failed. */
export async function readJson<T extends object = Record<string, unknown>>(response: Response, fallback: string): Promise<T & { error?: unknown }> {
  const data = await response.json().catch(() => ({})) as T & { error?: unknown };
  if (!response.ok) throw new Error(typeof data.error === "string" && data.error ? data.error : fallback);
  return data;
}
