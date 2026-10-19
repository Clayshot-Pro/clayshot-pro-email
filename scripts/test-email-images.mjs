// v3.19: images in mail. Remote image addresses are kept (never loaded
// directly), shown through the authenticated image proxy; embedded (cid:)
// images point at their stored attachment; older mail is rebuilt once from
// its raw message. Runs the Worker code on node:sqlite with the migrations.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

function d1(db) {
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...values) => statement(sql, values),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(row => ({ ...row })) }),
    first: async () => { const row = db.prepare(sql).get(...args); return row ? { ...row } : null; },
  });
  return { prepare: sql => statement(sql), batch: async list => Promise.all(list.map(item => item.run())) };
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const RAW = [
  "From: Shop <news@shop.test>", "To: work@example.org", "Subject: Your order", "Message-ID: <order@shop.test>",
  "MIME-Version: 1.0", 'Content-Type: multipart/related; boundary="rel"', "",
  "--rel", "Content-Type: text/html; charset=utf-8", "",
  '<p>Thanks!</p><img src="cid:logo@shop.test" alt="Shop"><img src="https://cdn.shop.test/banner.jpg" width="600">',
  "--rel", 'Content-Type: image/png; name="logo.png"', "Content-Transfer-Encoding: base64", "Content-ID: <logo@shop.test>",
  'Content-Disposition: inline; filename="logo.png"', "", PNG.toString("base64"),
  "--rel--", "",
].join("\r\n");

async function run(m) {
  // Sanitizer: the remote address moves to data-remote-src, whatever the quoting.
  for (const [html, kept] of [
    ['<img src="https://cdn.test/a.png">', '"https://cdn.test/a.png"'],
    ["<img src='https://cdn.test/a\"b.png'>", "'https://cdn.test/a\"b.png'"],
    ["<img src=https://cdn.test/a.png alt=x>", "https://cdn.test/a.png"],
  ]) {
    const clean = m.sanitizeEmailHtml(html);
    assert.ok(clean.includes(`data-remote-src=${kept}`), clean);
    assert.doesNotMatch(clean, /[\s/]src\s*=\s*["']?https?:/i, "never loadable by itself");
  }
  assert.equal(m.sanitizeEmailHtml('<img src="cid:logo">'), '<img src="cid:logo">', "embedded references stay for the server to resolve");

  // Image proxy: only public http(s) addresses on standard ports.
  for (const bad of ["", "javascript:alert(1)", "file:///etc/passwd", "ftp://a.test/x.png", "https://user:pw@a.test/x.png", "https://a.test:8443/x.png",
    "http://localhost/x.png", "http://127.0.0.1/x.png", "http://10.0.0.5/x.png", "http://192.168.1.1/x.png", "http://172.20.0.1/x.png",
    "http://169.254.169.254/latest", "http://[::1]/x.png", "http://metadata.internal/x"]) {
    assert.equal(m.proxiedImageUrl(bad), null, bad);
  }
  assert.equal(m.proxiedImageUrl("https://cdn.test/a.png?x=1")?.toString(), "https://cdn.test/a.png?x=1");
  const proxy = (url, reply) => m.imageProxy(new Request(`https://mail.example.org/api/image-proxy?url=${encodeURIComponent(url)}`), reply);
  const image = (body = PNG, headers = {}) => new Response(body, { status: 200, headers: { "Content-Type": "image/png", ...headers } });
  {
    const calls = [];
    const ok = await proxy("https://cdn.test/a.png", async (url, init) => { calls.push({ url, init }); return image(); });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.match(ok.headers.get("content-security-policy"), /sandbox/, "an SVG opened directly cannot run scripts");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG);
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.headers.Cookie, undefined, "no cookies or reader details are forwarded");
  }
  assert.equal((await proxy("https://cdn.test/page", async () => new Response("<html>", { headers: { "Content-Type": "text/html" } }))).status, 415);
  assert.equal((await proxy("https://cdn.test/big.png", async () => image(PNG, { "Content-Length": String(11 * 1024 * 1024) }))).status, 413);
  assert.equal((await proxy("https://cdn.test/r", async () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/admin" } }))).status, 502,
    "a redirect to a private address is refused");
  {
    let hops = 0;
    const followed = await proxy("https://cdn.test/r", async url => hops++ === 0
      ? new Response(null, { status: 301, headers: { Location: "/real.png" } })
      : (assert.equal(url, "https://cdn.test/real.png"), image()));
    assert.equal(followed.status, 200, "public redirects are followed");
  }
  {
    const endless = await proxy("https://cdn.test/r", async () => new Response(null, { status: 302, headers: { Location: "https://cdn.test/r" } }));
    assert.equal(endless.status, 502);
  }
  {
    const huge = new ReadableStream({ start(controller) { for (let i = 0; i < 12; i++) controller.enqueue(new Uint8Array(1024 * 1024)); controller.close(); } });
    const streamed = await proxy("https://cdn.test/liar.png", async () => image(huge));
    await assert.rejects(streamed.arrayBuffer(), /too large/i, "an undeclared oversized image is cut off");
  }
  assert.equal((await proxy("http://127.0.0.1/x.png", async () => { throw new Error("must not fetch"); })).status, 400);

  // Older mail is rebuilt once from its raw message: remote addresses return,
  // the embedded logo points at its attachment and leaves the attachment list.
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter(file => file.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, dir), "utf8"));
  db.exec("INSERT INTO native_mailboxes (id, email_address, display_name) VALUES ('native:work', 'work@example.org', 'Work')");
  db.exec("INSERT INTO threads (id, mailbox_id, latest_message_at) VALUES ('t1', 'native:work', '2026-10-01T00:00:00Z')");
  db.prepare(`INSERT INTO messages (id, mailbox_id, thread_id, direction, from_address, to_addresses, subject, preview, received_at, body_html, raw_r2_key, has_attachments)
    VALUES ('m1', 'native:work', 't1', 'inbound', 'news@shop.test', '[]', 'Your order', '', '2026-10-01T00:00:00Z', ?, 'raw/m1', 1)`)
    .run('<p>Thanks!</p><img src="cid:logo@shop.test" alt="Shop"><img data-remote-image-blocked="true" width="600">');
  db.prepare("INSERT INTO attachments (id, message_id, filename, content_type, size, r2_key) VALUES ('a1', 'm1', 'logo.png', 'image/png', ?, 'raw/m1/a1')").run(PNG.byteLength);
  db.prepare("INSERT INTO attachments (id, message_id, filename, content_type, size, r2_key) VALUES ('a2', 'm1', 'invoice.pdf', 'application/pdf', 10, 'raw/m1/a2')").run();
  let rawReads = 0;
  // Full reads only: the unsubscribe lookup reads a small header range on every open.
  const env = { DB: d1(db), MAIL: { get: async (key, options) => key === "raw/m1"
    ? (options?.range ? null : rawReads++, { arrayBuffer: async () => new TextEncoder().encode(RAW).buffer })
    : null } };
  const open = async () => (await (await m.getMessage(new Request("https://mail.example.org/api/messages/m1?accountId=native:work"), "m1", env)).json()).message;

  const message = await open();
  assert.match(message.bodyHtml, /<img data-remote-src="https:\/\/cdn\.shop\.test\/banner\.jpg" width="600">/, "the remote address is back");
  assert.match(message.bodyHtml, /src="https:\/\/mail\.example\.org\/api\/attachment-previews\/a1\?accountId=native%3Awork"/, "the embedded logo is the stored attachment");
  assert.deepEqual(message.attachments.map(attachment => attachment.id), ["a2"], "embedded images are not listed as attachments");
  assert.equal(db.prepare("SELECT content_id FROM attachments WHERE id = 'a1'").get().content_id, "logo@shop.test", "the Content-ID is filled in");
  assert.equal(db.prepare("SELECT html_version FROM messages WHERE id = 'm1'").get().html_version, m.HTML_VERSION);
  await open();
  assert.equal(rawReads, 1, "the raw message is read once, not on every open");

  // New mail is stored in the current format with Content-IDs.
  const receive = readFileSync(new URL("../src/worker/email/receive.ts", import.meta.url), "utf8");
  assert.match(receive, /INSERT INTO attachments \(id,message_id,filename,content_type,size,r2_key,content_id\)/);
  assert.match(receive, /html_version\) VALUES[^`]*\$\{HTML_VERSION\}\)/);

  console.log("PASS: remote images kept and proxied safely; embedded images shown from attachments; older mail rebuilt once");
}

const out = mkdtempSync(join(tmpdir(), "ltm-images-"));
try {
  const entry = join(out, "entry.ts");
  const file = path => new URL(`../src/worker/${path}`, import.meta.url).pathname;
  writeFileSync(entry, [
    `export { HTML_VERSION, sanitizeEmailHtml } from "${file("email/html.ts")}";`,
    `export { imageProxy, proxiedImageUrl } from "${file("api/imageProxy.ts")}";`,
    `export { getMessage } from "${file("api/mail.ts")}";`,
  ].join("\n"));
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"],
    outfile: join(out, "bundle.mjs"), logLevel: "error", mainFields: ["module", "main"], conditions: ["worker", "browser", "import"] });
  await run(await import(pathToFileURL(join(out, "bundle.mjs")).href));
} finally {
  rmSync(out, { recursive: true, force: true });
}
