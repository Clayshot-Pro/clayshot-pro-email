import { ensureDomains } from "./domains";

let ready: Promise<void> | null = null;

/**
 * Align stored instance state once per isolate: keep mailbox domains in sync,
 * adopt a v2 install's mailbox domain as the main domain, and create the
 * admin@ mailbox on the main domain if it is missing. A fresh install stays
 * uninitialized until first-run setup (POST /api/setup) chooses the domain.
 */
export function bootstrapInstance(env: Env): Promise<void> {
  ready ??= ensureDomains(env).catch(error => {
    ready = null;
    console.error("instance_bootstrap_failed", error instanceof Error ? error.name : "unknown");
  });
  return ready;
}
