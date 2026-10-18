// Run every Node regression script. `npm test`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const TESTS = [
  "test-app-config",
  "test-config-render",
  "test-instance-identity",
  "test-account-access",
  "test-admin-auth-boundary",
  "test-admin-stepup",
  "test-mailbox-rules",
  "test-mail-mutation-shields",
  "test-password-crypto",
  "test-admin-layout",
  "test-add-inbox-ui",
  "test-domains",
  "test-transport-selection",
  "test-resend-webhook",
  "test-resend-errors",
  "test-customization",
  "test-css-tokens",
  "verify-css-equivalence",
];

let failed = 0;
for (const name of TESTS) {
  const path = `scripts/${name}.mjs`;
  if (!existsSync(path)) continue;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", path], { stdio: "inherit" });
  if (result.status !== 0) {
    failed++;
    console.error(`FAIL: ${name}`);
  }
}
if (failed) {
  console.error(`${failed} test script(s) failed.`);
  process.exit(1);
}
console.log("All test scripts passed.");
