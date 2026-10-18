import { readFile } from "node:fs/promises";
import { loadConfigValues } from "../config/schema.mjs";
import { PLACEHOLDER_DATABASE_ID, distWorkerDir } from "./config-lib.mjs";

const { values } = loadConfigValues();
const CONFIG_PATH = new URL(`../dist/${distWorkerDir(values.WORKER_NAME)}/wrangler.json`, import.meta.url);

const config = await readFile(CONFIG_PATH, "utf8");

if (config.includes(PLACEHOLDER_DATABASE_ID)) {
  throw new Error("Generated Wrangler config still contains the placeholder D1 database ID.");
}

console.log("Generated Wrangler config contains the resolved production D1 binding.");
