// Render the gitignored wrangler.jsonc from wrangler.template.jsonc and .env /
// build variables. Strict mode (Workers Builds on main, or --strict) requires
// real values and a resolved D1 database; otherwise example values are used so
// CI can typecheck and bundle without instance configuration.
import { readFile, writeFile } from "node:fs/promises";
import { loadConfigValues, missingRequired } from "../config/schema.mjs";
import {
  PLACEHOLDER_DATABASE_ID, renderWrangler, withPlaceholders,
  databaseIdFromDeployedWorker, databaseIdByName, isWorkersBuildOnMain,
} from "./config-lib.mjs";

const TEMPLATE = new URL("../wrangler.template.jsonc", import.meta.url);
const OUTPUT = new URL("../wrangler.jsonc", import.meta.url);

const strict = process.argv.includes("--strict") || isWorkersBuildOnMain();
let { values } = loadConfigValues();

const missing = missingRequired(values, strict ? ["var", "deploy"] : ["var"]);
if (missing.length) {
  if (strict) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}. Set them in .env or as build variables.`);
  }
  const filled = withPlaceholders(values);
  values = filled.values;
  console.warn(`config:render using example values for ${filled.used.join(", ")} (not deployable).`);
}

let databaseId = values.D1_DATABASE_ID?.trim() || "";
if (!databaseId && strict) {
  databaseId = (isWorkersBuildOnMain() ? await databaseIdFromDeployedWorker(values) : null)
    ?? await databaseIdByName(values)
    ?? "";
  if (!databaseId) {
    throw new Error("Could not resolve the D1 database. Run `npm run setup`, or set D1_DATABASE_ID, and check the API token has D1 and Workers Scripts access.");
  }
}

const template = await readFile(TEMPLATE, "utf8");
await writeFile(OUTPUT, renderWrangler(template, values, databaseId || PLACEHOLDER_DATABASE_ID), "utf8");
console.log(`Rendered wrangler.jsonc for worker ${values.WORKER_NAME}${strict ? " (deployable)" : ""}.`);
