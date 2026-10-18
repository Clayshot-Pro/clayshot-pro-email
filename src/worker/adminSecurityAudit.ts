export type AdminSecurityOutcome = "success" | "denied" | "failure";

export function adminMutationEvent(method: string, path: string): string {
  if (path === "/api/admin/password") return "admin.password.changed";
  if (path === "/api/admin/domains") return "admin.domain.created";
  if (path.startsWith("/api/admin/domains/")) return method === "DELETE" ? "admin.domain.deleted" : "admin.domain.updated";
  if (path === "/api/admin/instance") return "admin.branding.updated";
  if (path === "/api/admin/instance/logo") return method === "DELETE" ? "admin.branding.logo_removed" : "admin.branding.logo_uploaded";
  if (path === "/api/admin/suppressions") return "admin.suppression.added";
  if (path.startsWith("/api/admin/suppressions/")) return "admin.suppression.removed";
  if (path === "/api/mailboxes") return "admin.mailbox.created";
  if (path === "/api/auth/sessions/reset") return "admin.sessions.reset";
  if (path.startsWith("/api/auth/sessions/")) return "admin.session.revoked";
  if (path.endsWith("/reset-password")) return "admin.mailbox.password_reset";
  if (path.endsWith("/reconcile")) return "admin.mailbox.reconciled";
  if (path.endsWith("/restore")) return "admin.mailbox.restored";
  if (path.endsWith("/purge")) return "admin.mailbox.purged";
  if (method === "DELETE") return "admin.mailbox.deletion_scheduled";
  return "admin.mailbox.updated";
}



const SAFE_EVENT = /^[a-z][a-z0-9_.-]{0,79}$/;
const MAX_AGE_DAYS = 90;

/** Event names and outcomes are predefined codes, never user-supplied content. */
export async function recordAdminSecurityEvent(
  env: Env,
  event: string,
  outcome: AdminSecurityOutcome,
  actor = "anonymous",
  targetType = "",
  target = "",
): Promise<void> {
  if (!SAFE_EVENT.test(event) || !SAFE_EVENT.test(targetType || "none")) {
    throw new Error("Invalid security event");
  }
  const digest = target
    ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(target))
    : null;
  const fingerprint = digest
    ? Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, "0")).join("").slice(0, 16)
    : "";
  await env.DB.prepare(
    `INSERT INTO admin_security_events(id,event_type,outcome,actor,target_type,target_fingerprint)
     VALUES(?1,?2,?3,?4,?5,?6)`,
  ).bind(crypto.randomUUID(), event, outcome, actor.slice(0, 24), targetType, fingerprint).run();
}

export async function tryRecordAdminSecurityEvent(
  env: Env, event: string, outcome: AdminSecurityOutcome, actor = "anonymous",
  targetType = "", target = "",
): Promise<void> {
  try {
    await recordAdminSecurityEvent(env, event, outcome, actor, targetType, target);
  } catch {
    console.error("admin_security_audit_write_failed", event);
  }
}

export async function listAdminSecurityEvents(env: Env): Promise<Response> {
  const records = await env.DB.prepare(
    `SELECT id,event_type,outcome,actor,target_type,target_fingerprint,created_at
     FROM admin_security_events ORDER BY created_at DESC LIMIT 100`,
  ).all<{
    id:string;event_type:string;outcome:AdminSecurityOutcome;actor:string;
    target_type:string;target_fingerprint:string;created_at:string;
  }>();
  return Response.json({ events: records.results });
}

export async function pruneAdminSecurityEvents(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM admin_security_events WHERE created_at < datetime('now', '-${MAX_AGE_DAYS} days')`),
    env.DB.prepare("DELETE FROM admin_stepup_challenges WHERE expires_at <= datetime('now')"),
    env.DB.prepare("DELETE FROM admin_stepup_approvals WHERE expires_at <= datetime('now')"),
  ]);
}
