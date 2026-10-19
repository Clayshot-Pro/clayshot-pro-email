import { readFile } from "node:fs/promises";
import { loadConfigValues } from "../config/schema.mjs";
import { PLACEHOLDER_DATABASE_ID, distWorkerDir, isWorkersBuildOnMain } from "./config-lib.mjs";

const { values } = loadConfigValues();
const CONFIG_PATH = new URL(`../dist/${distWorkerDir(values.WORKER_NAME)}/wrangler.json`, import.meta.url);

const config = await readFile(CONFIG_PATH, "utf8");

const db = JSON.parse(config).d1_databases?.find(binding => binding.binding === "DB");
if (db?.database_id === PLACEHOLDER_DATABASE_ID) {
  throw new Error("The built Wrangler config has the placeholder D1 database ID.");
}
if (!db?.database_id) {
  // Allowed only for a fork deployed by Workers Builds: Wrangler links the database by name.
  if (!isWorkersBuildOnMain()) {
    throw new Error("The built Wrangler config has no D1 database ID. Production deploys run scripts/config-render.mjs first.");
  }
  console.log(`No D1 database ID: Wrangler finds or creates "${db?.database_name}" by name and keeps it linked.`);
} else {
  console.log("Generated Wrangler config contains the resolved production D1 binding.");
}
