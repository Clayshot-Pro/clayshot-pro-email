// v3.13: the admin panel says when the project repository has a newer
// version, so instances deployed from a fork know when to "Sync fork".
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "package.json carries the release version");
assert.equal(lock.version, pkg.version, "package-lock.json matches");
assert.equal(lock.packages[""].version, pkg.version);

const out = mkdtempSync(join(tmpdir(), "ltm-version-"));
try {
  await build({ entryPoints: [new URL("../src/worker/version.ts", import.meta.url).pathname], bundle: true, format: "esm",
    platform: "neutral", outfile: join(out, "version.mjs"), logLevel: "error" });
  const m = await import(pathToFileURL(join(out, "version.mjs")).href);
  assert.equal(m.APP_VERSION, pkg.version);
  assert.equal(m.compareVersions("3.14.0", "3.13.0"), 1);
  assert.equal(m.compareVersions("3.13.0", "3.13.0"), 0);
  assert.equal(m.compareVersions("3.9.0", "3.13.0"), -1, "numeric, not alphabetical");
  assert.equal(m.compareVersions("4.0.0", "3.99.9"), 1);

  // Newer upstream: update available. The check is cached per isolate.
  let calls = 0;
  const upstream = version => async url => {
    calls++;
    assert.equal(url, "https://raw.githubusercontent.com/LiamTheMo/LTM-Email-Service/main/package.json");
    return new Response(JSON.stringify({ version }));
  };
  const newer = await (await m.versionResponse(upstream("99.0.0"))).json();
  assert.deepEqual(newer, { current: pkg.version, latest: "99.0.0", updateAvailable: true, repository: "https://github.com/LiamTheMo/LTM-Email-Service" });
  await m.versionResponse(upstream("100.0.0"));
  assert.equal(calls, 1, "cached for six hours");
} finally {
  rmSync(out, { recursive: true, force: true });
}

// Fresh isolates: same version, unreachable upstream, junk.
for (const [answer, expected] of [[{ version: pkg.version }, false], [null, false], [{ version: "<script>" }, false]]) {
  const dir = mkdtempSync(join(tmpdir(), "ltm-version-"));
  try {
    await build({ entryPoints: [new URL("../src/worker/version.ts", import.meta.url).pathname], bundle: true, format: "esm",
      platform: "neutral", outfile: join(dir, "version.mjs"), logLevel: "error" });
    const m = await import(pathToFileURL(join(dir, "version.mjs")).href);
    const fetcher = async () => answer ? new Response(JSON.stringify(answer)) : new Response("down", { status: 503 });
    const result = await (await m.versionResponse(fetcher)).json();
    assert.equal(result.updateAvailable, expected);
    if (!answer || answer.version === "<script>") assert.equal(result.latest, null, "only a real version is reported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const admin = readFileSync(new URL("../src/client/components/AdminPanel.tsx", import.meta.url), "utf8");
assert.match(admin, /Sync fork → Update branch/);
assert.match(readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8"), /"\/api\/admin\/version" && request\.method === "GET"\) return versionResponse\(\)/);

console.log("PASS: app version, upstream update check and admin notice");
