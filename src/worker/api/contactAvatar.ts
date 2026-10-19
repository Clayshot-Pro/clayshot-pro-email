import { deviceAuthorized } from "../deviceAuth";
import { googleContactPhotoSources } from "../providers/googleContacts";
import { getGoogleAccessToken } from "../providers/googleCredentials";
import {
  googleImageResponse,
  isAllowedGoogleImageUrl,
  readValidatedGoogleImage,
} from "../providers/googleImages";

const notFound = () => new Response(null, { status: 404 });

export async function getContactAvatar(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId") ?? "";
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!accountId.startsWith("gmail:") || !email || email.length > 320) return notFound();
  if (!(await deviceAuthorized(request, env, accountId))) return notFound();

  try {
    const sources = await googleContactPhotoSources(env, accountId, [email]);
    const rawPhotoUrl = sources.get(email);
    if (!rawPhotoUrl) return notFound();

    const photoUrl = new URL(rawPhotoUrl);
    if (!isAllowedGoogleImageUrl(photoUrl)) return notFound();

    // The access token goes only to the allowlisted host; a redirect is
    // checked before it is followed and never receives the token.
    const token = await getGoogleAccessToken(env, accountId);
    let response = await fetch(photoUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      const next = location ? new URL(location, photoUrl) : null;
      if (!next || !isAllowedGoogleImageUrl(next)) return notFound();
      response = await fetch(next.toString(), { redirect: "manual" });
    }
    if (!response.ok) return notFound();

    const image = await readValidatedGoogleImage(response);
    return image ? googleImageResponse(image) : notFound();
  } catch {
    return notFound();
  }
}
