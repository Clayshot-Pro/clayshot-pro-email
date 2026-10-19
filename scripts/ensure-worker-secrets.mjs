// After a production deploy: create the PROVIDER_CREDENTIAL_KEY Worker secret
// when the Worker has none (scripts/config-lib.mjs ensureCredentialKeySecret).
// The app then generates its push notification keys by itself. Never fails a
// deploy that already succeeded: problems are reported as warnings.
import { loadConfigValues, missingRequired } from "../config/schema.mjs";
import { ensureCredentialKeySecret, isProductionDeploy } from "./config-lib.mjs";

const warn = message => console.log(process.env.GITHUB_ACTIONS === "true" ? `::warning title=Encryption key::${message}` : `Warning: ${message}`);
const { values } = loadConfigValues();
if (!isProductionDeploy()) {
  console.log("Not a production deploy; Worker secrets are left as they are.");
} else if (missingRequired(values, ["deploy"]).length) {
  warn("No Cloudflare deploy keys here, so the encryption key was not checked. Connect Cloudflare in Admin → Keys to create it.");
} else {
  try {
    const state = await ensureCredentialKeySecret(values);
    console.log(state === "created"
      ? "Created the PROVIDER_CREDENTIAL_KEY Worker secret. Back it up from Admin → Keys → Back up encryption key."
      : "The PROVIDER_CREDENTIAL_KEY Worker secret is set.");
  } catch (error) {
    warn(`${error instanceof Error ? error.message : error} Notifications and stored keys need it: connect Cloudflare in Admin → Keys to create it.`);
  }
}
