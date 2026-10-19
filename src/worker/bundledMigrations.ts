/// <reference types="vite/client" />
import { applyMigrations, type Migration } from "./migrationRunner";

// Every file in /migrations, bundled into the Worker at build time.
const files = import.meta.glob<string>("../../migrations/*.sql", { query: "?raw", import: "default", eager: true });

export const BUNDLED_MIGRATIONS: Migration[] = Object.entries(files)
  .map(([path, sql]) => ({ name: path.slice(path.lastIndexOf("/") + 1), sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** Bring the database up to date with the code that is running. */
export async function migrateDatabase(env: Env): Promise<void> {
  const applied = await applyMigrations(env.DB, BUNDLED_MIGRATIONS);
  if (applied.length) console.log("d1_migrations_applied", applied.join(","));
}
