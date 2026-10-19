export const jsonError = (message: string, status: number, headers?: HeadersInit) =>
  Response.json({ error: message }, { status, headers });
