// `npm run test:e2e`: build, then run the end-to-end suites against the real
// Worker. E2E_SKIP_BUILD=1 reuses dist/; E2E_SHOW_LOGS=1 prints the Worker log.
import { spawnSync } from "node:child_process";

if (!process.env.E2E_SKIP_BUILD) {
  const build = spawnSync("npm", ["run", "build"], { stdio: "inherit", shell: process.platform === "win32" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

let failed = 0;
for (const suite of ["./sanitizer.e2e.mjs", "./mail-app.e2e.mjs"]) {
  console.log(`\n${suite}`);
  const { run } = await import(suite);
  failed += await run();
}
console.log(failed ? `\n${failed} end-to-end suite(s) failed.` : "\nAll end-to-end suites passed.");
process.exit(failed ? 1 : 0);
