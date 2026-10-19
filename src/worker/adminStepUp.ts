import { randomBase64Url, sha256Hex } from "./bytes";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { appOrigin, passkeyRpId } from "./config";
import { ownerSessionHash, parseTransports } from "./auth";
import { tryRecordAdminSecurityEvent } from "./adminSecurityAudit";
import { hashMutationBody, isApprovedAdminMutation } from "./adminStepUpPolicy";

const HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const APPROVAL_HEADER = "X-Admin-Step-Up";


export async function stepUpOptions(request: Request, env: Env): Promise<Response> {
  const sessionHash = await ownerSessionHash(request, env);
  if (!sessionHash) return Response.json({ error: "Administrator login required" }, { status: 403 });
  const body = await request.json<{method?:unknown;pathname?:unknown;bodyHash?:unknown}>().catch(() => null);
  const method = body?.method, pathname = body?.pathname, bodyHash = body?.bodyHash;
  if (typeof method !== "string" || typeof pathname !== "string" || typeof bodyHash !== "string"
    || !HASH.test(bodyHash) || !isApprovedAdminMutation(method, pathname)) {
    return Response.json({ error: "Invalid protected operation" }, { status: 400 });
  }
  const credentials = await env.DB.prepare(
    "SELECT id,transports FROM auth_credentials ORDER BY created_at ASC",
  ).all<{id:string;transports:string|null}>();
  if (!credentials.results.length) return Response.json({error:"Passkey required"},{status:409});
  const options = await generateAuthenticationOptions({
    rpID: passkeyRpId(request), userVerification: "required",
    allowCredentials: credentials.results.map(item => ({id:item.id,transports:parseTransports(item.transports)})),
  });
  const challengeId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO admin_stepup_challenges(id,session_hash,challenge,method,pathname,body_hash,expires_at) VALUES(?1,?2,?3,?4,?5,?6,datetime('now','+3 minutes'))",
  ).bind(challengeId,sessionHash,options.challenge,method,pathname,bodyHash).run();
  return Response.json({ challengeId, options });
}

export async function stepUpVerify(request: Request, env: Env): Promise<Response> {
  const sessionHash = await ownerSessionHash(request, env);
  if (!sessionHash) return Response.json({ error: "Administrator login required" }, { status: 403 });
  const payload = await request.json<{challengeId?:unknown;response?:AuthenticationResponseJSON}>().catch(() => null);
  if (typeof payload?.challengeId !== "string" || payload.challengeId.length > 80
    || !payload.response || typeof payload.response.id !== "string") {
    return Response.json({ error: "Invalid passkey response" }, { status: 400 });
  }
  const row = await env.DB.prepare(
    `DELETE FROM admin_stepup_challenges
      WHERE id=?1 AND session_hash=?2 AND expires_at>datetime('now')
      RETURNING challenge,method,pathname,body_hash`,
  ).bind(payload.challengeId,sessionHash).first<{
    challenge:string;method:string;pathname:string;body_hash:string;
  }>();
  if (!row) {
    await tryRecordAdminSecurityEvent(env,"admin.stepup.verify","denied",sessionHash.slice(0,16));
    return Response.json({ error: "Passkey challenge expired or used" }, { status: 403 });
  }
  const stored = await env.DB.prepare(
    "SELECT id,public_key,counter,transports FROM auth_credentials WHERE id=?1 LIMIT 1",
  ).bind(payload.response.id).first<{
    id:string;public_key:ArrayBuffer;counter:number;transports:string|null;
  }>();
  if (!stored) {
    await tryRecordAdminSecurityEvent(env,"admin.stepup.verify","denied",sessionHash.slice(0,16));
    return Response.json({error:"Passkey verification failed"},{status:403});
  }
  try {
    const result = await verifyAuthenticationResponse({
      response: payload.response,
      expectedChallenge: row.challenge,
      expectedOrigin: appOrigin(request),
      expectedRPID: passkeyRpId(request),
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(stored.public_key),
        counter: stored.counter,
        transports: parseTransports(stored.transports),
      },
      requireUserVerification: true,
    });
    if (!result.verified) throw new Error("Unverified WebAuthn assertion");
    // Authentication assertions are one-time and counter updates are monotonic.
    await env.DB.prepare(
      "UPDATE auth_credentials SET counter=?1,last_used_at=datetime('now') WHERE id=?2 AND counter<=?1",
    ).bind(result.authenticationInfo.newCounter,stored.id).run();
    const token = randomBase64Url();
    const batch = /\/(purge|reconcile)$/.test(row.pathname);
    await env.DB.prepare(
      `INSERT INTO admin_stepup_approvals(token_hash,session_hash,method,pathname,body_hash,max_uses,expires_at)
       VALUES(?1,?2,?3,?4,?5,?6,datetime('now',?7))`,
    ).bind(await sha256Hex(token),sessionHash,row.method,row.pathname,row.body_hash,
      batch ? 500 : 1,batch ? "+5 minutes" : "+2 minutes").run();
    await tryRecordAdminSecurityEvent(env,"admin.stepup.verify","success",sessionHash.slice(0,16),"operation",row.pathname);
    return Response.json({approval:token});
  } catch {
    await tryRecordAdminSecurityEvent(env,"admin.stepup.verify","denied",sessionHash.slice(0,16));
    return Response.json({ error: "Passkey verification failed" }, { status: 403 });
  }
}

/** Atomic single-use proof; batch proofs have strict action-specific usage limits. */
export async function consumeAdminApproval(request: Request, env: Env): Promise<boolean> {
  const sessionHash = await ownerSessionHash(request, env);
  if (!sessionHash) return false;
  const token = request.headers.get(APPROVAL_HEADER) ?? "";
  if (!TOKEN.test(token)) return false;
  const bodyHash = await hashMutationBody(request);
  if (!bodyHash) return false;
  const url = new URL(request.url);
  const result = await env.DB.prepare(
    `UPDATE admin_stepup_approvals SET uses=uses+1
     WHERE token_hash=?1 AND session_hash=?2 AND method=?3 AND pathname=?4
       AND body_hash=?5 AND expires_at>datetime('now') AND uses<max_uses
     RETURNING uses`,
  ).bind(await sha256Hex(token),sessionHash,request.method,url.pathname,bodyHash).first();
  return Boolean(result);
}
