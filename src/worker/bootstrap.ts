import { ensureDomains } from "./domains";

let ready: Promise<void> | null = null;

/**
 * Align stored instance state once per isolate: keep mailbox domains in sync
 * and, for an install upgraded from v2, adopt its primary mailbox's domain as
 * the primary domain. A fresh install stays uninitialized until first-run
 * setup (POST /api/setup) chooses the primary mailbox address.
 */
export function bootstrapInstance(env: Env): Promise<void> {
  ready ??= ensureDomains(env).catch(error => {
    ready = null;
    console.error("instance_bootstrap_failed", error instanceof Error ? error.name : "unknown");
  });
  return ready;
}
