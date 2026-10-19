// End-to-end harness: the real Worker (`wrangler dev`, local D1 and R2, the
// app's own migrations) driven by Chromium with a virtual passkey device.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";

export const SETUP_SECRET = "e2e-setup-secret";
const ROOT = new URL("../..", import.meta.url).pathname;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}

/** Start the built Worker locally with a fresh database. Returns { origin, stop, logs }. */
export async function startWorker() {
  const port = await freePort();
  const state = mkdtempSync(join(tmpdir(), "ltm-e2e-"));
  const vars = join(state, "vars.env");
  writeFileSync(vars, `AUTH_SETUP_TOKEN=${SETUP_SECRET}\nPROVIDER_CREDENTIAL_KEY=${randomBytes(32).toString("base64url")}\n`);
  const logs = [];
  const child = spawn("npx", ["wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port),
    "--persist-to", join(state, "data"), "--env-file", vars, "--show-interactive-dev-session=false"],
  { cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => logs.push(String(chunk)));
  child.stderr.on("data", chunk => logs.push(String(chunk)));
  const origin = `http://localhost:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${logs.join("")}`);
    const ok = await fetch(`${origin}/api/instance`).then(r => r.ok).catch(() => false);
    if (ok) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (Date.now() >= deadline) throw new Error(`wrangler dev did not start:\n${logs.join("")}`);
  const stop = async () => {
    child.kill("SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 300));
    rmSync(state, { recursive: true, force: true });
  };
  return { origin, stop, logs };
}

export async function launchBrowser() {
  return chromium.launch();
}

/** A browser context with its own virtual passkey device (user verification always succeeds). */
export async function contextWithPasskey(browser, options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true },
  });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  return { context, page, errors };
}

/** JSON API call sharing the context's cookies; mutations send the app's Origin like the browser does. */
export function api(context, origin) {
  return async (path, { method = "GET", body, form, headers = {} } = {}) => {
    const response = await context.request.fetch(`${origin}${path}`, {
      method,
      headers: { ...(method === "GET" ? {} : { Origin: origin }), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      data: body !== undefined ? JSON.stringify(body) : undefined,
      multipart: form,
      failOnStatusCode: false,
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status(), json, text, headers: response.headers() };
  };
}

/** Build a raw MIME message. */
export function mime({ from, to, subject, text = "", html, headers = {}, attachments = [], messageId }) {
  const boundary = `b${randomBytes(8).toString("hex")}`;
  const id = messageId ?? `<${randomBytes(8).toString("hex")}@e2e.test>`;
  const lines = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: ${id}`,
    `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0",
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
  ];
  const alt = `a${boundary}`;
  lines.push(`--${boundary}`, `Content-Type: multipart/alternative; boundary="${alt}"`, "",
    `--${alt}`, "Content-Type: text/plain; charset=utf-8", "", text);
  if (html) lines.push(`--${alt}`, "Content-Type: text/html; charset=utf-8", "", html);
  lines.push(`--${alt}--`);
  for (const file of attachments) {
    lines.push(`--${boundary}`, `Content-Type: ${file.type}; name="${file.name}"`, "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${file.name}"`, "", Buffer.from(file.content).toString("base64"));
  }
  lines.push(`--${boundary}--`, "");
  return { raw: lines.join("\r\n"), messageId: id };
}

/** Deliver a message through the Worker's email() handler, as Email Routing would. */
export async function deliver(origin, message) {
  const { raw, messageId } = mime(message);
  const envelopeFrom = message.from.replace(/^.*<|>.*$/g, "");
  const response = await fetch(`${origin}/cdn-cgi/handler/email?from=${encodeURIComponent(envelopeFrom)}&to=${encodeURIComponent(message.to)}`, {
    method: "POST", body: raw,
  });
  return { status: response.status, body: await response.text(), messageId };
}

/** Minimal step runner with readable output; on failure it saves a screenshot of `page`. */
export async function steps(list, page) {
  let failed = 0;
  for (const [name, fn] of list) {
    const started = Date.now();
    try {
      await fn();
      console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      failed++;
      console.log(`  ✗ ${name}\n    ${String(error?.stack ?? error).split("\n").slice(0, 6).join("\n    ")}`);
      const current = typeof page === "function" ? page() : page;
      if (current) {
        const shot = join(tmpdir(), `ltm-e2e-failure-${Date.now()}.png`);
        await current.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
        const alert = await current.locator("[role=alert]").allInnerTexts().catch(() => []);
        console.log(`    screenshot: ${shot}${alert.length ? `\n    on screen: ${alert.join(" | ")}` : ""}`);
      }
      break;
    }
  }
  return failed;
}
