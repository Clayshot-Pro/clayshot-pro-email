import { migrateDatabase } from "./bundledMigrations";
import { ensureDomains } from "./domains";
import { adoptLegacyProfilePhoto } from "./api/profile";

let ready: Promise<void> | null = null;

/**
 * Once per isolate: apply any pending database migrations (v3.12), then
 * align stored instance state: keep mailbox domains in sync,
 * adopt a v2 install's mailbox domain as the main domain, and create the
 * admin@ mailbox on the main domain if it is missing. A fresh install stays
 * uninitialized until first-run setup (POST /api/setup) chooses the domain.
 * Also records the version of admin@'s pre-v3.10 profile photo.
 */
export function bootstrapInstance(env: Env): Promise<void> {
  ready ??= migrateDatabase(env).then(() => ensureDomains(env)).then(() => adoptLegacyProfilePhoto(env)).catch(error => {
    ready = null;
    console.error("instance_bootstrap_failed", error instanceof Error ? (error.name === "MigrationError" ? error.message : error.name) : "unknown");
  });
  return ready;
}
