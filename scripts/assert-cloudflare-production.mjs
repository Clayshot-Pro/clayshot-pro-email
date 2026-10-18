import { isProductionDeploy } from "./config-lib.mjs";

if (!isProductionDeploy()) {
  throw new Error("Production deployment is allowed only from the main branch in Cloudflare Workers Builds or the GitHub Actions deploy workflow.");
}

console.log("Cloudflare production deployment target verified: main.");
