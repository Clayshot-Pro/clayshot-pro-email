import { primaryProfilePath, protectedAccountPath, requestedMailAccount } from "./accountAccess";
import { adminProtectedApiPath } from "./adminRoutePolicy";
import { consumeAdminApproval, stepUpOptions, stepUpVerify } from "./adminStepUp";
import { adminMutationNeedsStepUp, isApprovedAdminMutation } from "./adminStepUpPolicy";
import { adminMutationEvent, listAdminSecurityEvents, pruneAdminSecurityEvents, tryRecordAdminSecurityEvent } from "./adminSecurityAudit";
import { readOwnerSessionToken } from "./ownerSessionPolicy";
import { beginAdminLogin, adminPasswordConfigured, saveAdminPassword } from "./adminAuth";
import { reconcileMailboxUsage } from "./usage";
import {
  deviceStatus, deviceLogin, deviceLogout, deviceRemoveAccount, deviceAccountIds,
  deviceAuthorized, adminAuthorized, rotateMailboxPassword, setMailboxPassword, cleanupDeviceSessions,
} from "./deviceAuth";
import { allNativeMailboxes, createNativeMailbox, updateNativeMailbox, scheduleNativeMailboxDeletion, restoreNativeMailbox, purgeNativeMailbox, purgeExpiredNativeMailboxes, ADMIN_MAILBOX_ID } from "./mailboxes";
import { getAccountAvatar } from "./api/accountAvatar";
import { getConnectedAccounts } from "./api/accounts";
import { previewAttachment } from "./api/attachments";
import { getContactAvatar } from "./api/contactAvatar";
import { deleteDraft, getDraft, saveDraft } from "./api/drafts";
import { healthResponse } from "./api/health";
import { downloadAttachment, getMessage, listMessages, patchMessage } from "./api/mail";
import { bulkMailAction, permanentlyDeleteMessage } from "./api/mailActions";
import { deleteProfilePhoto, getProfile, getProfilePhoto, profileMailboxId, saveProfilePhoto } from "./api/profile";
import {
  authenticationOptions,
  authStatus,
  logout,
  registrationOptions,
  resetSessions,
  revokeSession,
  sessionInfo,
  unauthorizedResponse,
  verifyAuthentication,
  verifyRegistration,
} from "./auth";
import { appOrigin } from "./config";
import { instanceResponse, manifestResponse, shellResponse } from "./instance";
import { bootstrapInstance } from "./bootstrap";
import { addBlockedSender, listBlockedSenders, removeBlockedSender } from "./blockedSenders";
import { adminKeysResponse, deleteStoredKey, saveStoredKey, withStoredKeys } from "./storedKeys";
import { setupInstance } from "./setup";
import { versionResponse } from "./version";
import { deleteCloudflareToken, saveCloudflareToken } from "./cloudflare/routes";
import { instanceSettings } from "./branding";
import { checkDomainDns, connectDomainRoute, createDomain, deleteDomain, listDomainsResponse, updateDomain } from "./domains";
import { addSuppression, listSuppressions, pruneWebhookReceipts, removeSuppression, resendWebhook } from "./webhooks/resend";
import {
  adminSettingsResponse, deleteLogo, getPreferences, iconResponse, savePreferences, saveInstanceSettings, uploadLogo,
} from "./branding";
import { receiveEmail } from "./email/receive";
import { sendEmail } from "./email/send";
import { disconnectGoogleIfUnused, googleOAuthCallback, startGoogleOAuth } from "./providers/google";
import { pushConfig, subscribePush, unsubscribePush } from "./push";
import { MAX_API_BODY_BYTES, authRateLimitBucket, checkAuthRateLimit, requestTooLarge } from "./security";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const AUTH_POSTS = new Set([
  "/api/setup",
  "/api/auth/register/options",
  "/api/auth/register/verify",
  "/api/auth/login/options",
  "/api/auth/login/verify",
  "/api/admin/login/password",
  "/api/admin/step-up/options",
  "/api/admin/step-up/verify",
  "/api/accounts/gmail/connect",
]);

const jsonError = (message: string, status: number, headers?: HeadersInit) =>
  Response.json({ error: message }, { status, headers });

const sameOrigin = (request: Request): boolean => {
  try {
    const origin = appOrigin(request);
    return SAFE_METHODS.has(request.method) || request.headers.get("Origin") === origin;
  } catch {
    return false;
  }
};

function secureApiResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  // Public, versioned instance icons are the only cacheable API responses.
  if (headers.get("Cache-Control") !== "public, max-age=31536000, immutable" || headers.get("Content-Type") !== "image/png") {
    headers.set("Cache-Control", "private, no-store");
  }
  // Preserve stricter endpoint-specific CSP directives (e.g. the "sandbox"
  // directive for attachments) instead of overwriting them.
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  }
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function decodedRouteId(match: RegExpMatchArray): string | null {
  return match[1] ? decodePathSegment(match[1]) : null;
}

async function routeApi(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  // Provider webhooks are server-to-server: exempt from the same-origin and
  // session checks for this exact path only, authenticated by signature.
  if (url.pathname === "/api/webhooks/resend" && request.method === "POST") return resendWebhook(request, env);
  if (!sameOrigin(request)) return jsonError("Cross-origin request rejected", 403);
  if (!SAFE_METHODS.has(request.method) && requestTooLarge(request, MAX_API_BODY_BYTES)) {
    return jsonError("Request body too large", 413);
  }

  if (
    request.method === "POST"
    && AUTH_POSTS.has(url.pathname)
    && !(await checkAuthRateLimit(env, authRateLimitBucket(request, url.pathname)))
  ) {
    return jsonError("Too many authentication attempts", 429, { "Retry-After": "60" });
  }

  // Public instance identity for the sign-in screen (no addresses or secrets).
  if (url.pathname === "/api/instance" && request.method === "GET") return instanceResponse(env);
  const iconRoute = url.pathname.match(/^\/api\/instance\/icon\/(\d{2,3})\.png$/);
  if (iconRoute && request.method === "GET") return iconResponse(request, env, Number(iconRoute[1]));

  // Device authentication is independent from the privileged owner passkey.
  if (url.pathname === "/api/device/status" && request.method === "GET") return deviceStatus(request, env);
  if (url.pathname === "/api/device/login" && request.method === "POST") return deviceLogin(request, env);
  if (url.pathname === "/api/admin/login/password" && request.method === "POST") return beginAdminLogin(request, env);
  if (url.pathname === "/api/device/logout" && request.method === "POST") return deviceLogout(request, env);

  // First-run setup (AUTH_SETUP_TOKEN, uninitialized instance only).
  if (url.pathname === "/api/setup" && request.method === "POST") return setupInstance(request, env);

  // Authentication routes that must be reachable before a session exists.
  if (url.pathname === "/api/auth/status" && request.method === "GET") return authStatus(request, env);
  if (url.pathname === "/api/auth/register/options" && request.method === "POST") return registrationOptions(request, env);
  if (url.pathname === "/api/auth/register/verify" && request.method === "POST") return verifyRegistration(request, env);
  if (url.pathname === "/api/auth/login/options" && request.method === "POST") return authenticationOptions(request, env);
  if (url.pathname === "/api/auth/login/verify" && request.method === "POST") return verifyAuthentication(request, env);
  if (url.pathname === "/api/auth/logout" && request.method === "POST") return logout(request, env);
  if (url.pathname === "/api/accounts/gmail/callback" && request.method === "GET") return googleOAuthCallback(request, env);
  if (url.pathname === "/api/accounts/gmail/connect" && request.method === "POST") return startGoogleOAuth(request, env);

  // A valid device login permits only its explicitly signed-in accounts.
  // Passkey-authenticated owner sessions retain administrative privileges.
  const [isAdmin, accountIds] = await Promise.all([
    adminAuthorized(request, env),
    deviceAccountIds(request, env),
  ]);
  if (!isAdmin && accountIds.length === 0) return unauthorizedResponse();
  if (adminProtectedApiPath(url.pathname) && !isAdmin) return jsonError("Administrator passkey required", 403);
  if (url.pathname === "/api/admin/step-up/options" && request.method === "POST") return stepUpOptions(request, env);
  if (url.pathname === "/api/admin/step-up/verify" && request.method === "POST") return stepUpVerify(request, env);
  if (url.pathname === "/api/admin/audit" && request.method === "GET") return listAdminSecurityEvents(env);
  if (adminMutationNeedsStepUp(request.method, url.pathname)) {
    if (!isApprovedAdminMutation(request.method, url.pathname)) return jsonError("Unknown protected operation", 404);
    if (!(await consumeAdminApproval(request, env))) {
      if (isAdmin) await tryRecordAdminSecurityEvent(env, "admin.action.stepup_missing", "denied", "owner", "operation", url.pathname);
      return jsonError("Fresh administrator passkey verification required", 403);
    }
  }
  if (url.pathname === "/api/admin/password" && request.method === "POST") {
    if (!isAdmin) return jsonError("Administrator verification required", 403);
    if (!(await checkAuthRateLimit(env, authRateLimitBucket(request, "admin-change-password"))))
      return jsonError("Too many attempts", 429);
    const payload = await request.json().catch(() => null) as { newPassword?:unknown;currentPassword?:unknown } | null;
    try {
      const outcome = await saveAdminPassword(env,payload?.newPassword,payload?.currentPassword);
      if (outcome.error) return jsonError(outcome.error, 400);
      const response = await logout(request, env);
      return Response.json({ok:true,reloginRequired:true},{headers: response.headers});
    } catch (error) {
      // Never log submitted passwords or D1 parameter values. Return JSON even
      // when storage or password hashing fails so mobile browsers get an
      // actionable message rather than an opaque DOM/SyntaxError.
      console.error("Administrator password save failed", error instanceof Error ? error.name : "unknown");
      return jsonError("Password setup is temporarily unavailable (ADMIN_SETUP_FAILED). Please try again.", 503);
    }
  }
  if (url.pathname === "/api/admin/version" && request.method === "GET") return versionResponse();
  if (url.pathname === "/api/admin/status" && request.method === "GET") {
    return Response.json({ passwordConfigured: await adminPasswordConfigured(env) });
  }
  if (url.pathname === "/api/admin/domains" && request.method === "GET") return listDomainsResponse(request, env);
  if (url.pathname === "/api/admin/domains" && request.method === "POST") return createDomain(request, env);
  const domainRoute = url.pathname.match(/^\/api\/admin\/domains\/([^/]+)(\/dns|\/connect)?$/);
  if (domainRoute) {
    const domain = decodePathSegment(domainRoute[1]);
    if (!domain) return jsonError("Invalid domain", 400);
    if (domainRoute[2] === "/dns" && request.method === "GET") return checkDomainDns(env, domain);
    if (domainRoute[2] === "/connect" && request.method === "POST") return connectDomainRoute(request, env, domain);
    if (!domainRoute[2] && request.method === "PATCH") return updateDomain(request, env, domain);
    if (!domainRoute[2] && request.method === "DELETE") return deleteDomain(env, domain);
    return jsonError("Method not allowed", 405);
  }
  if (url.pathname === "/api/admin/instance" && request.method === "GET") return adminSettingsResponse(env);
  if (url.pathname === "/api/admin/instance" && request.method === "PUT") return saveInstanceSettings(request, env);
  if (url.pathname === "/api/admin/instance/logo" && request.method === "PUT") return uploadLogo(request, env);
  if (url.pathname === "/api/admin/instance/logo" && request.method === "DELETE") return deleteLogo(env);
  if (url.pathname === "/api/admin/keys" && request.method === "GET") return adminKeysResponse(env);
  const keyRoute = url.pathname.match(/^\/api\/admin\/keys\/([A-Z_]+)$/);
  if (keyRoute && request.method === "PUT") return saveStoredKey(request, env, keyRoute[1]);
  if (keyRoute && request.method === "DELETE") return deleteStoredKey(env, keyRoute[1]);
  if (url.pathname === "/api/admin/cloudflare" && request.method === "PUT") return saveCloudflareToken(request, env);
  if (url.pathname === "/api/admin/cloudflare" && request.method === "DELETE") return deleteCloudflareToken(env);
  if (url.pathname === "/api/admin/suppressions" && request.method === "GET") return listSuppressions(env);
  if (url.pathname === "/api/admin/suppressions" && request.method === "POST") return addSuppression(request, env);
  const suppressionRoute = url.pathname.match(/^\/api\/admin\/suppressions\/([^/]+)$/);
  if (suppressionRoute && request.method === "DELETE") {
    const address = decodePathSegment(suppressionRoute[1]);
    return address ? removeSuppression(env, address) : jsonError("Invalid address", 400);
  }

  // Each mailbox owns its profile photo: only that mailbox's session or the
  // owner session may read or change it (admin@ when no accountId is given).
  if (primaryProfilePath(url.pathname) && !(await deviceAuthorized(request, env, profileMailboxId(url)))) {
    return jsonError("Mailbox sign-in required", 403);
  }

  if (url.pathname === "/api/device/accounts" && request.method === "GET") {
    return getConnectedAccounts(request, env);
  }
  const deviceAccountRoute = url.pathname.match(new RegExp("^/api/device/accounts/([^/]+)$"));
  if (deviceAccountRoute && request.method === "DELETE") {
    const id = decodedRouteId(deviceAccountRoute);
    if (!id) return jsonError("Invalid account", 400);
    return deviceRemoveAccount(request, env, id);
  }

  if (url.pathname === "/api/mailboxes" && request.method === "GET") {
    return Response.json({ mailboxes: await allNativeMailboxes(env) });
  }
  const passwordRoute = url.pathname.match(new RegExp("^/api/mailboxes/([^/]+)/reset-password$"));
  if (passwordRoute && request.method === "POST") {
    const id = decodedRouteId(passwordRoute);
    if (!id) return jsonError("Invalid mailbox ID", 400);
    if (!(await checkAuthRateLimit(env, authRateLimitBucket(request, "mailbox-password-reset"))))
      return jsonError("Too many requests", 429);
    const payload = await request.json().catch(() => null) as {password?:unknown} | null;
    const manual = payload && Object.prototype.hasOwnProperty.call(payload,"password");
    if (manual && typeof payload.password !== "string") return jsonError("Invalid password",400);
    try {
      if (manual) {
        await setMailboxPassword(env,id,payload!.password as string);
        return Response.json({ok:true},{headers:{"Cache-Control":"no-store"}});
      }
      return Response.json({password:await rotateMailboxPassword(env,id)},{headers:{"Cache-Control":"no-store"}});
    } catch(error) {
      return jsonError(error instanceof Error?error.message:"Could not update mailbox password",400);
    }
  }

  // Authorization must use the mailbox the handler actually operates on.
  // Previously POST /api/send and /api/drafts could authorize query accountId
  // but act on a different body accountId. Contact photo reads require the
  // same per-device account grant as the rest of the Gmail API.
  if (protectedAccountPath(url.pathname)) {
    const target = await requestedMailAccount(request, url);
    if (target.error) return jsonError(target.error, 400);
    const requested = target.accountId ?? (isAdmin ? ADMIN_MAILBOX_ID : null);
    if (!requested || !(await deviceAuthorized(request, env, requested))) {
      return jsonError("Account not signed in on this device", 403);
    }
  }

  // Appearance preferences of an account signed in on this device.
  if (url.pathname === "/api/preferences" && request.method === "GET") return getPreferences(request, env, url);
  if (url.pathname === "/api/preferences" && request.method === "PUT") return savePreferences(request, env, url);

  // Authenticated account and session management.
  if (url.pathname === "/api/auth/sessions" && request.method === "GET") return sessionInfo(request, env);
  if (url.pathname === "/api/auth/sessions/reset" && request.method === "POST") return resetSessions(request, env);

  const sessionRoute = url.pathname.match(/^\/api\/auth\/sessions\/([^/]+)$/);
  if (sessionRoute && request.method === "DELETE") {
    const sessionId = decodedRouteId(sessionRoute);
    if (!sessionId) return jsonError("Invalid session id", 400);
    return revokeSession(request, env, sessionId);
  }
  if (url.pathname === "/api/contact-avatar" && request.method === "GET") return getContactAvatar(request, env);

  const accountRoute = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (accountRoute && request.method === "DELETE") {
    const accountId = decodedRouteId(accountRoute);
    if (!accountId) return jsonError("Invalid account id", 400);
    if (accountId.startsWith("gmail:")) {
      const removed = await deviceRemoveAccount(request, env, accountId);
      if (removed.ok) {
        await disconnectGoogleIfUnused(accountId, env)
          .catch(error => console.error("gmail_disconnect_failed", error instanceof Error ? error.name : "unknown"));
      }
      return removed;
    }
  }

  const avatarRoute = url.pathname.match(/^\/api\/accounts\/([^/]+)\/avatar$/);
  if (avatarRoute && request.method === "GET") {
    const accountId = decodedRouteId(avatarRoute);
    if (!accountId) return jsonError("Invalid account id", 400);
    if (accountId.startsWith("gmail:") && await deviceAuthorized(request, env, accountId)) return getAccountAvatar(accountId, env);
  }

  // Mail and profile routes.
  if (url.pathname === "/api/health" && request.method === "GET") return healthResponse(env);
  if (url.pathname === "/api/accounts" && request.method === "GET") return getConnectedAccounts(request, env);
  if (url.pathname === "/api/mailboxes" && request.method === "POST") {
    if (!(await checkAuthRateLimit(env, authRateLimitBucket(request, "mailboxes:create"))))
      return jsonError("Too many mailbox operations", 429);
    return createNativeMailbox(request, env);
  }
  const reconcileRoute = url.pathname.match(/^\/api\/mailboxes\/([^/]+)\/reconcile$/);
  if (reconcileRoute && request.method === "POST") {
    const id = decodePathSegment(reconcileRoute[1]);
    return id ? reconcileMailboxUsage(env, id) : jsonError("Invalid mailbox ID", 400);
  }
  const lifecycleRoute = url.pathname.match(/^\/api\/mailboxes\/([^/]+)\/(restore|purge)$/);
  if (lifecycleRoute && request.method === "POST") {
    const id = decodePathSegment(lifecycleRoute[1]);
    if (!id) return jsonError("Invalid mailbox ID", 400);
    // Purge is bounded to 50 messages per call and may need many invocations.
    // Restore is rate-limited; both routes require the owner session.
    if (lifecycleRoute[2] === "restore" && !(await checkAuthRateLimit(env, authRateLimitBucket(request, "mailboxes:restore"))))
      return jsonError("Too many mailbox operations", 429);
    return lifecycleRoute[2] === "restore" ? restoreNativeMailbox(env, id) : purgeNativeMailbox(env, id);
  }
  const mailboxRoute = url.pathname.match(new RegExp("^/api/mailboxes/([^/]+)$"));
  if (mailboxRoute && (request.method === "PATCH" || request.method === "DELETE")) {
    const id = decodedRouteId(mailboxRoute);
    if (!id) return jsonError("Invalid mailbox ID", 400);
    if (!(await checkAuthRateLimit(env, authRateLimitBucket(request, "mailboxes:mutate"))))
      return jsonError("Too many mailbox operations", 429);
    return request.method === "DELETE" ? scheduleNativeMailboxDeletion(env, id) : updateNativeMailbox(request, env, id);
  }
  if (url.pathname === "/api/messages" && request.method === "GET") return listMessages(request, env);
  if (url.pathname === "/api/blocked-senders" && request.method === "GET") return listBlockedSenders(env, url);
  if (url.pathname === "/api/blocked-senders" && request.method === "POST") return addBlockedSender(request, env, url);
  if (url.pathname === "/api/blocked-senders" && request.method === "DELETE") return removeBlockedSender(env, url);
  if (url.pathname === "/api/send" && request.method === "POST") return sendEmail(request, env);
  if (url.pathname === "/api/drafts" && request.method === "POST") return saveDraft(request, env);
  if (url.pathname === "/api/profile" && request.method === "GET") return getProfile(env, url);

  if (url.pathname === "/api/profile/photo") {
    if (request.method === "GET") return getProfilePhoto(env, url);
    if (request.method === "PUT") return saveProfilePhoto(request, env, url);
    if (request.method === "DELETE") return deleteProfilePhoto(env, url);
    return jsonError("Method not allowed", 405);
  }

  // Push notification routes.
  if (url.pathname === "/api/push/config" && request.method === "GET") return pushConfig(env);
  if (url.pathname === "/api/push/subscribe" && request.method === "POST") return subscribePush(request, env);
  if (url.pathname === "/api/push/unsubscribe" && request.method === "POST") return unsubscribePush(request, env);

  const draftMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)$/);
  if (draftMatch) {
    const id = decodedRouteId(draftMatch);
    if (!id) return jsonError("Invalid draft id", 400);
    if (request.method === "GET") return getDraft(id, env, url.searchParams.get("accountId"));
    if (request.method === "DELETE") return deleteDraft(id, env, url.searchParams.get("accountId"));
    return jsonError("Method not allowed", 405);
  }

  if (url.pathname === "/api/messages/bulk" && request.method === "POST") return bulkMailAction(request, env, ctx);

  const messageMatch = url.pathname.match(/^\/api\/messages\/([^/]+)$/);
  if (messageMatch) {
    const id = decodedRouteId(messageMatch);
    if (!id) return jsonError("Invalid message id", 400);
    if (request.method === "GET") return getMessage(request, id, env);
    if (request.method === "PATCH") return patchMessage(request, id, env);
    if (request.method === "DELETE") return permanentlyDeleteMessage(env, url.searchParams.get("accountId") ?? "", id);
    return jsonError("Method not allowed", 405);
  }

  const previewMatch = url.pathname.match(/^\/api\/attachment-previews\/([^/]+)$/);
  if (previewMatch && request.method === "GET") {
    const id = decodedRouteId(previewMatch);
    if (!id) return jsonError("Invalid attachment id", 400);
    return previewAttachment(request, id, env);
  }

  const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
  if (attachmentMatch && request.method === "GET") {
    const id = decodedRouteId(attachmentMatch);
    if (!id) return jsonError("Invalid attachment id", 400);
    return downloadAttachment(request, id, env);
  }

  return jsonError("Not found", 404);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      await bootstrapInstance(env);
      env = await withStoredKeys(env);
      const response = await routeApi(request, env, url, ctx);
      if (isApprovedAdminMutation(request.method, url.pathname)) {
        // Never retain request payload, mailbox passwords, cookies or assertions.
        const token = readOwnerSessionToken(request);
        let actor = "anonymous";
        if (token) {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
          actor = Array.from(new Uint8Array(digest)).slice(0, 8)
            .map(byte => byte.toString(16).padStart(2, "0")).join("");
        }
        const outcome = response.ok ? "success" : response.status === 401 || response.status === 403 ? "denied" : "failure";
        // Paginated operations are one logical action: record completion and
        // failures, not hundreds of indistinguishable intermediate chunks.
        const paginated = url.pathname.endsWith("/purge") || url.pathname.endsWith("/reconcile");
        const page = paginated && response.ok
          ? await response.clone().json().catch(() => null) as { complete?: boolean } | null
          : null;
        if (!paginated || !response.ok || page?.complete === true) {
          await tryRecordAdminSecurityEvent(env, adminMutationEvent(request.method, url.pathname),
            outcome, actor, "operation", url.pathname);
        }
      }
      return secureApiResponse(response);
    }
    if (request.method === "GET" && (url.pathname === "/manifest.webmanifest" || url.pathname === "/" || url.pathname === "/index.html")) {
      await bootstrapInstance(env);
    }
    if (request.method === "GET" && url.pathname === "/manifest.webmanifest") {
      try { return await manifestResponse(env); } catch { return env.ASSETS.fetch(request); }
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return shellResponse(request, env);
    }
    return env.ASSETS.fetch(request);
  },

  async email(message, env, ctx): Promise<void> {
    await bootstrapInstance(env);
    await receiveEmail(message, await withStoredKeys(env), ctx);
  },

  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(cleanupDeviceSessions(env));
    // Retry receipts only exist to prevent duplicate ingestion after transport
    // retries; they are not permanent message records.
    ctx.waitUntil(env.DB.prepare("DELETE FROM inbound_receipts WHERE first_seen_at<datetime('now','-7 days')").run().then(() => undefined));
    if ((await instanceSettings(env)).mail.purgeEnabled) {
      ctx.waitUntil(purgeExpiredNativeMailboxes(env));
    }
    ctx.waitUntil(pruneAdminSecurityEvents(env));
    ctx.waitUntil(pruneWebhookReceipts(env));
  },
} satisfies ExportedHandler<Env>;
