import { ADMIN_MAILBOX_ID } from "../mailboxIds";

/**
 * Per-mailbox profile photos (v3.10). The image is in R2; its version is in
 * native_mailboxes.photo_version. admin@ keeps the original object key.
 * Routes take ?accountId= and are authorized per mailbox by the router.
 */
const LEGACY_KEY = "profile/avatar.jpg";
const MAX_PROFILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_PROFILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export const profilePhotoKey = (mailboxId: string) =>
  mailboxId === ADMIN_MAILBOX_ID ? LEGACY_KEY : `profile/mailbox/${encodeURIComponent(mailboxId)}.jpg`;

/** The mailbox a profile request is about: ?accountId=, admin@ when omitted. */
export const profileMailboxId = (url: URL) => url.searchParams.get("accountId")?.trim() || ADMIN_MAILBOX_ID;

const noStore = { "Cache-Control": "private, no-store" };

async function mailbox(env: Env, url: URL): Promise<{ id: string; photo_version: string | null } | Response> {
  const id = profileMailboxId(url);
  if (!id.startsWith("native:")) return Response.json({ error: "Profile photos are for custom mailboxes" }, { status: 400 });
  const row = await env.DB.prepare("SELECT id, photo_version FROM native_mailboxes WHERE id = ?1 AND status = 'active' AND deleted_at IS NULL")
    .bind(id).first<{ id: string; photo_version: string | null }>();
  return row ?? Response.json({ error: "Mailbox unavailable" }, { status: 404 });
}

export async function getProfilePhoto(env: Env, url: URL): Promise<Response> {
  const box = await mailbox(env, url);
  if (box instanceof Response) return box;
  const object = box.photo_version ? await env.MAIL.get(profilePhotoKey(box.id)) : null;
  if (!object) return Response.json({ error: "Profile photo not found" }, { status: 404 });
  return new Response(object.body, {
    headers: { ...noStore, "Content-Type": object.httpMetadata?.contentType || "image/jpeg", "X-Content-Type-Options": "nosniff" },
  });
}

export async function saveProfilePhoto(request: Request, env: Env, url: URL): Promise<Response> {
  const box = await mailbox(env, url);
  if (box instanceof Response) return box;
  const form = await request.formData();
  const photo = form.get("photo");
  if (!(photo instanceof File)) return Response.json({ error: "Photo is required" }, { status: 400 });
  if (!ALLOWED_PROFILE_TYPES.has(photo.type)) return Response.json({ error: "Use a JPEG, PNG, or WebP image" }, { status: 415 });
  if (photo.size <= 0 || photo.size > MAX_PROFILE_BYTES) return Response.json({ error: "Profile photo must be 5 MB or smaller" }, { status: 413 });

  const uploadedAt = new Date().toISOString();
  await env.MAIL.put(profilePhotoKey(box.id), await photo.arrayBuffer(), {
    httpMetadata: { contentType: photo.type },
    customMetadata: { uploadedAt },
  });
  await env.DB.prepare("UPDATE native_mailboxes SET photo_version = ?2 WHERE id = ?1").bind(box.id, uploadedAt).run();
  return Response.json({ ok: true, version: uploadedAt });
}

export async function deleteProfilePhoto(env: Env, url: URL): Promise<Response> {
  const box = await mailbox(env, url);
  if (box instanceof Response) return box;
  await env.MAIL.delete(profilePhotoKey(box.id));
  await env.DB.prepare("UPDATE native_mailboxes SET photo_version = NULL WHERE id = ?1").bind(box.id).run();
  return Response.json({ ok: true });
}

/** Upgrade: admin@'s photo predates photo_version; record its version once. */
export async function adoptLegacyProfilePhoto(env: Env): Promise<void> {
  const row = await env.DB.prepare("SELECT photo_version FROM native_mailboxes WHERE id = ?1")
    .bind(ADMIN_MAILBOX_ID).first<{ photo_version: string | null }>();
  if (!row || row.photo_version) return;
  const object = await env.MAIL.head(LEGACY_KEY);
  if (!object) return;
  await env.DB.prepare("UPDATE native_mailboxes SET photo_version = ?2 WHERE id = ?1 AND photo_version IS NULL")
    .bind(ADMIN_MAILBOX_ID, object.customMetadata?.uploadedAt ?? object.etag ?? "1").run();
}
