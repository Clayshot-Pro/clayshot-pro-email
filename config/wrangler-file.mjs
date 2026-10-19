// The committed wrangler.jsonc: the Deploy to Cloudflare button's source and
// the defaults for every deploy (Worker, D1 and R2 names).
import { existsSync, readFileSync } from "node:fs";

export const WRANGLER_FILE = new URL("../wrangler.jsonc", import.meta.url);

/** JSON with // and /* comments and trailing commas, as Wrangler accepts. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\"") {
      let end = i + 1;
      while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += char;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function readWranglerConfig(file = WRANGLER_FILE) {
  return existsSync(file) ? parseJsonc(readFileSync(file, "utf8")) : null;
}

/** Names from the committed config; .env and CI variables may override them. */
export function wranglerDefaults(config = readWranglerConfig()) {
  const db = config?.d1_databases?.find(binding => binding.binding === "DB");
  const bucket = config?.r2_buckets?.find(binding => binding.binding === "MAIL");
  return {
    WORKER_NAME: config?.name || "ltm-email-service",
    D1_DATABASE_NAME: db?.database_name || "ltm-email-service",
    R2_BUCKET_NAME: bucket?.bucket_name || "ltm-email-service-mail",
    D1_DATABASE_ID: db?.database_id || "",
  };
}
