// End-to-end: first-run setup, administration, receiving, reading, sending,
// junk and blocking, All inboxes and access control, against the real Worker.
import assert from "node:assert/strict";
import { SETUP_SECRET, api, contextWithPasskey, copyPasskeys, deliver, launchBrowser, mime, startWorker, steps } from "./harness.mjs";

const DOMAIN = "e2e.test";
const navItem = (page, name) => page.locator(".desktop-sidebar .nav-item", { hasText: name });
const ADMIN_PASSWORD = "correct horse";

export async function run() {
  const worker = await startWorker();
  const browser = await launchBrowser();
  const state = {};
  let admin, alice;
  try {
    admin = await contextWithPasskey(browser);
    const adminApi = api(admin.context, worker.origin);

    const failed = await steps([
      ["first-run setup: domain, password, setup secret, passkey", async () => {
        const { page } = admin;
        await page.goto(worker.origin);
        await page.getByRole("button", { name: "Use the setup secret instead" }).click();
        await page.fill("#setup-domain", DOMAIN);
        await page.fill("#setup-password", ADMIN_PASSWORD);
        await page.fill("#setup-token", SETUP_SECRET);
        await page.getByRole("button", { name: "Continue" }).click();
        await page.getByRole("button", { name: "Create administrator passkey" }).click();
        await page.waitForSelector(".mail-list-pane, .admin-home", { timeout: 20_000 });
        const status = await adminApi("/api/device/status");
        assert.equal(status.json.isAdmin, true, "the administrator is signed in after setup");
        const instance = await adminApi("/api/instance");
        assert.equal(instance.json.primaryDomain, DOMAIN);
        assert.equal((await adminApi("/api/auth/status")).json.setupAvailable, false, "setup closes once a passkey exists");
      }],

      ["setup cannot run again", async () => {
        const again = await fetch(`${worker.origin}/api/setup`, { method: "POST", headers: { Origin: worker.origin, "Content-Type": "application/json" },
          body: JSON.stringify({ domain: "evil.test", adminPassword: "pw12345", setupToken: SETUP_SECRET }) });
        assert.equal(again.status, 409);
      }],

      ["admin creates a mailbox in the admin panel (passkey approval)", async () => {
        const { page } = admin;
        await page.goto(`${worker.origin}/#admin`);
        await page.reload();
        await page.waitForSelector("#new-mailbox-address");
        // Keys status: the encryption key is set, so push keys exist and nothing essential is missing.
        await page.locator("#admin-keys .key-summary-ok").waitFor({ timeout: 20_000 });
        assert.equal(await page.locator(".admin-keys-notice").count(), 0, "no setup warning when the keys are set up");
        const chip = label => page.locator("#admin-keys .key-row", { hasText: label }).locator(".key-chip");
        assert.match(await chip("Encryption key").innerText(), /set up/i);
        assert.match(await chip("Push notification keys").innerText(), /set up/i);
        assert.match(await chip("Resend API key").innerText(), /not set/i);
        assert.equal(await page.locator("#admin-keys .key-chip-missing").count(), 0);
        await page.fill("#new-mailbox-address", "alice");
        await page.fill("#new-mailbox-name", "Alice");
        await page.getByRole("button", { name: "Create mailbox" }).click();
        const code = page.locator(".mailbox-generated-password code");
        await code.waitFor({ timeout: 20_000 });
        state.alicePassword = (await code.innerText()).trim();
        assert.ok(state.alicePassword.length >= 12, "a strong one-time password is shown");
        const boxes = await adminApi("/api/mailboxes");
        state.aliceId = boxes.json.mailboxes.find(box => box.email_address === `alice@${DOMAIN}`).id;
        assert.ok(state.aliceId);
      }],

      ["the administrator signs other sessions out from Settings (passkey approval)", async () => {
        // Two more administrator sessions, signed in with a copy of the passkey. The copy's
        // signature counter goes back to the original device, as one physical passkey would.
        const others = [];
        try {
          for (let i = 0; i < 2; i++) {
            const other = await contextWithPasskey(browser);
            others.push(other);
            await copyPasskeys(admin, other);
            await other.page.goto(worker.origin);
            await other.page.fill("#device-email", `admin@${DOMAIN}`);
            await other.page.fill("#device-password", ADMIN_PASSWORD);
            await other.page.locator("button.signin-submit").click();
            await other.page.waitForSelector(".mail-list-pane, .admin-home", { timeout: 20_000 });
            await copyPasskeys(other, admin);
          }
          const count = async () => (await adminApi("/api/auth/sessions")).json.sessions.length;
          assert.equal(await count(), 3);

          const { page } = admin;
          state.page = page;
          const confirmAll = dialog => void dialog.accept();
          page.on("dialog", confirmAll);
          try {
            await page.goto(worker.origin);
            await page.waitForSelector(".mail-list-pane, .admin-home", { timeout: 20_000 });
            await page.getByRole("button", { name: /settings/i }).first().click();
            await page.getByRole("button", { name: "View all" }).click();
            await page.locator(".sessions-modal .session-card").nth(2).waitFor({ timeout: 15_000 });
            await page.locator(".sessions-modal button.session-remove").first().click();
            await page.waitForFunction(() => document.querySelectorAll(".sessions-modal .session-card").length === 2, null, { timeout: 20_000 });
            assert.equal(await count(), 2, "Remove signs that session out");
            await page.locator(".sessions-modal button.sessions-danger").click();
            await page.waitForFunction(() => document.querySelectorAll(".sessions-modal .session-card").length === 1, null, { timeout: 20_000 });
            assert.equal(await count(), 1, "Reset other sessions leaves only this one");
            assert.deepEqual(await page.locator("[role=alert]").allInnerTexts(), [], "no error is shown");
            await page.getByRole("button", { name: "Done" }).click();
          } finally {
            page.off("dialog", confirmAll);
          }
          for (const other of others) {
            assert.ok([401, 403].includes((await api(other.context, worker.origin)("/api/auth/sessions")).status), "the other sessions are signed out");
          }
        } finally {
          for (const other of others) await other.context.close();
        }
      }],

      ["inbound mail is delivered, unknown recipients are rejected", async () => {
        const hostile = `<div><p id="greeting">Hello Alice, the quarterly numbers are attached.</p>
          <script>window.__xss = "script"</script>
          <img src="x" onerror="window.__xss='onerror'">
          <a id="bad" href="javascript:window.__xss='link'">click</a>
          <a id="good" href="https://example.com/report">Open the report</a>
          <form action="https://evil.test/steal"><input name="password"></form>
          <iframe src="https://evil.test/frame"></iframe>
          <img id="tracker" src="https://tracker.test/pixel.png"></div>`;
        const report = await deliver(worker.origin, { from: "Bob <bob@partner.test>", to: `alice@${DOMAIN}`, subject: "Quarterly report",
          text: "Hello Alice, the quarterly numbers are attached.", html: hostile,
          attachments: [{ name: "numbers.csv", type: "text/csv", content: "q,revenue\n1,100\n" },
            { name: "page.html", type: "text/html", content: "<script>alert(1)</script>" }] });
        assert.equal(report.status, 200, report.body);
        const plus = await deliver(worker.origin, { from: "news@partner.test", to: `alice+news@${DOMAIN}`, subject: "Plus address", text: "via plus" });
        assert.equal(plus.status, 200, plus.body);
        const unknown = await deliver(worker.origin, { from: "bob@partner.test", to: `nobody@${DOMAIN}`, subject: "Nobody", text: "x" });
        assert.notEqual(unknown.status, 200, "mail to an address without a mailbox is rejected");
        const foreign = await deliver(worker.origin, { from: "bob@partner.test", to: "alice@other.test", subject: "Other domain", text: "x" });
        assert.notEqual(foreign.status, 200, "mail for a domain this instance does not serve is rejected");
        const inbox = await adminApi(`/api/messages?accountId=${encodeURIComponent(state.aliceId)}&folder=inbox`);
        assert.deepEqual(inbox.json.messages.map(m => m.subject).sort(), ["Plus address", "Quarterly report"]);
      }],

      ["the sign-in form takes a name and offers every active domain", async () => {
        const visitor = await contextWithPasskey(browser);
        try {
          const { page } = visitor;
          state.page = page;
          // A second active domain, as an instance serving two would report it.
          await page.route("**/api/instance", async route => {
            const response = await route.fetch();
            const json = await response.json();
            await route.fulfill({ response, json: { ...json, domains: [DOMAIN, "second.test"] } });
          });
          const posted = [];
          await page.route("**/api/device/login", async route => {
            posted.push(JSON.parse(route.request().postData()).email);
            await route.continue();
          });
          await page.goto(worker.origin);
          const picker = page.locator("select.signin-domain");
          await picker.waitFor({ timeout: 15_000 });
          assert.deepEqual(await picker.locator("option").allInnerTexts(), [`@${DOMAIN}`, "@second.test"]);
          assert.equal(await picker.inputValue(), DOMAIN, "the main domain is chosen first");
          const box = await page.locator(".signin-address-field").boundingBox();
          const list = await picker.boundingBox();
          assert.ok(Math.abs(list.x + list.width - (box.x + box.width)) < 2, "the domain list sits at the right end of the one field");
          await page.fill("#device-email", "Nobody");
          await picker.selectOption("second.test");
          await page.fill("#device-password", "wrong-password");
          await page.locator("button.signin-submit").click();
          await page.locator(".auth-error").waitFor({ timeout: 15_000 });
          assert.deepEqual(posted, ["Nobody@second.test"]);
          // A full address is used as typed, and the picker steps aside.
          await page.fill("#device-email", `nobody@${DOMAIN}`);
          assert.equal(await picker.count(), 0);
        } finally {
          await visitor.context.close();
        }
      }],

      ["alice signs in with her mailbox password and reads the message safely", async () => {
        alice = await contextWithPasskey(browser);
        state.page = alice.page;
        const { page } = alice;
        await page.goto(worker.origin);
        // One domain: the form shows it after the name, so the name is enough.
        await page.locator(".signin-domain-fixed").filter({ hasText: `@${DOMAIN}` }).waitFor({ timeout: 15_000 });
        await page.fill("#device-email", "alice");
        await page.fill("#device-password", state.alicePassword);
        await page.locator("button.signin-submit").click();
        await page.waitForSelector(".mail-list-pane", { timeout: 20_000 });
        await page.locator(".mail-row").filter({ hasText: "Quarterly report" }).first().click();
        const frame = page.frameLocator(".rich-email-frame");
        await frame.locator("#greeting").waitFor({ timeout: 15_000 });
        assert.match(await frame.locator("#greeting").innerText(), /quarterly numbers/);
        const results = await page.evaluate(() => {
          const doc = document.querySelector(".rich-email-frame").contentDocument;
          return {
            parent: window.__xss ?? null,
            frame: doc.defaultView.__xss ?? null,
            scripts: doc.querySelectorAll("script").length,
            handlers: [...doc.querySelectorAll("*")].filter(el => [...el.attributes].some(a => a.name.startsWith("on"))).length,
            badHref: doc.querySelector("#bad")?.getAttribute("href") ?? null,
            goodTarget: doc.querySelector("#good")?.getAttribute("target") ?? null,
            forms: doc.querySelectorAll("form").length,
            iframes: doc.querySelectorAll("iframe").length,
            tracker: doc.querySelector("#tracker")?.getAttribute("src") ?? null,
            sandbox: document.querySelector(".rich-email-frame").getAttribute("sandbox"),
          };
        });
        await page.waitForTimeout(500);
        assert.equal(results.parent, null, "no script ran in the app");
        assert.equal(results.frame, null, "no script ran in the email");
        assert.equal(results.scripts, 0);
        assert.equal(results.handlers, 0, "event handler attributes are removed");
        assert.ok(!results.badHref || !/^javascript:/i.test(results.badHref), "javascript: links are removed");
        assert.equal(results.goodTarget, "_blank", "safe links open in a new tab");
        assert.equal(results.forms, 0);
        assert.equal(results.iframes, 0);
        assert.ok(!results.tracker || results.tracker.startsWith(`${worker.origin}/api/image-proxy?url=`),
          "remote images (trackers) never load from the sender's server, only through the app's proxy");
        assert.doesNotMatch(results.sandbox, /allow-scripts/);
        assert.deepEqual(alice.errors, [], "no page errors");
      }],

      ["embedded images show from the mail; remote images load through the image proxy", async () => {
        const { page } = alice;
        state.page = page;
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
        const delivered = await deliver(worker.origin, { from: "Shop <news@shop.test>", to: `alice@${DOMAIN}`, subject: "Order with pictures",
          text: "Your order", html: '<p>Your order</p><img id="logo" src="cid:logo@shop.test" width="40"><img id="banner" src="https://images.shop.test/banner.png" width="200">',
          attachments: [{ name: "logo.png", type: "image/png", content: png, contentId: "logo@shop.test" }, { name: "receipt.csv", type: "text/csv", content: "a,b\n1,2\n" }] });
        assert.equal(delivered.status, 200, delivered.body);
        const openOrder = async () => {
          await page.reload();
          await page.waitForSelector(".mail-list-pane", { timeout: 20_000 });
          await page.locator(".mail-row").filter({ hasText: "Order with pictures" }).first().click();
          const frame = page.frameLocator(".rich-email-frame");
          await frame.locator("#logo").waitFor({ timeout: 15_000 });
          return frame;
        };
        const frame = await openOrder();
        await page.waitForFunction(() => {
          const logo = document.querySelector(".rich-email-frame")?.contentDocument?.querySelector("#logo");
          return logo?.complete && logo.naturalWidth > 0;
        }, null, { timeout: 15_000 });
        const banner = await frame.locator("#banner").getAttribute("src");
        assert.equal(banner, `${worker.origin}/api/image-proxy?url=${encodeURIComponent("https://images.shop.test/banner.png")}`, "remote images go through the proxy");
        const listed = await page.locator(".reader-attachments .attachment-card").allInnerTexts();
        assert.ok(listed.some(text => text.includes("receipt.csv")) && !listed.some(text => text.includes("logo.png")), "the embedded logo is not listed as an attachment");

        // "Ask first": remote images stay hidden until Show images; embedded ones still show.
        await page.evaluate(() => localStorage.setItem("ltm.remoteImages", "ask"));
        const asked = await openOrder();
        assert.equal(await asked.locator("#banner").getAttribute("src"), null, "hidden until asked");
        await page.waitForFunction(() => {
          const logo = document.querySelector(".rich-email-frame")?.contentDocument?.querySelector("#logo");
          return logo?.complete && logo.naturalWidth > 0;
        }, null, { timeout: 15_000 });
        // The browser really requests the proxy (the frame's CSP allows it once images are shown).
        const proxied = page.waitForRequest(request => request.url().startsWith(`${worker.origin}/api/image-proxy?url=`), { timeout: 15_000 });
        await page.getByRole("button", { name: "Show images" }).click();
        await proxied;
        await page.waitForFunction(() => document.querySelector(".rich-email-frame")?.contentDocument?.querySelector("#banner")?.getAttribute("src")?.includes("/api/image-proxy?url="),
          null, { timeout: 15_000 });
        await page.evaluate(() => localStorage.removeItem("ltm.remoteImages"));

        // The proxy is for signed-in readers only.
        const anonymous = await fetch(`${worker.origin}/api/image-proxy?url=${encodeURIComponent("https://images.shop.test/banner.png")}`);
        assert.equal(anonymous.status, 401);
      }],

      ["Add inbox signs in with a name and the domain too", async () => {
        const { page } = alice;
        state.page = page;
        await page.locator(".desktop-add-account").click();
        await page.locator(".add-inbox-option").first().click();
        const modal = page.locator(".settings-backdrop");
        await modal.locator(".signin-domain-fixed").filter({ hasText: `@${DOMAIN}` }).waitFor({ timeout: 15_000 });
        // One continuous box: the border belongs to the field, not to the name input.
        const borders = await modal.locator(".signin-address-field").evaluate(field => ({
          field: getComputedStyle(field).borderTopWidth,
          input: getComputedStyle(field.querySelector("input")).borderTopWidth,
        }));
        assert.deepEqual(borders, { field: "1px", input: "0px" });
        await modal.getByRole("button", { name: "Close Add Inbox" }).click();
        await modal.waitFor({ state: "detached", timeout: 15_000 });
      }],

      ["a reload shows the mailbox's own look from the first paint (no flash)", async () => {
        const { page } = alice;
        state.page = page;
        // Alice chooses the light theme and a custom accent; one load caches them.
        const status = await page.evaluate(async id => (await fetch(`/api/preferences?accountId=${encodeURIComponent(id)}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: "light", accent: "#0b7a75" }),
        })).status, state.aliceId);
        assert.equal(status, 200);
        await page.reload();
        await page.waitForSelector(".mail-list-pane", { timeout: 20_000 });
        await page.waitForFunction(() => document.documentElement.dataset.theme === "light", null, { timeout: 15_000 });
        // Record every theme and accent the page shows while it starts again.
        await page.addInitScript(() => {
          const seen = window.__appearanceSeen = [];
          const record = () => {
            const root = document.documentElement;
            if (!root?.hasAttribute("data-theme")) return;
            const value = `${root.getAttribute("data-theme")}|${root.style.getPropertyValue("--user-accent")}`;
            if (seen[seen.length - 1] !== value) seen.push(value);
          };
          // The page's <html> does not exist yet when this runs: watch the whole document.
          new MutationObserver(record).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-theme", "style"] });
        });
        await page.reload();
        await page.waitForSelector(".mail-list-pane", { timeout: 20_000 });
        await page.waitForLoadState("networkidle");
        assert.deepEqual(await page.evaluate(() => window.__appearanceSeen), ["light|#0b7a75"], "the cached look is the only one shown");
        // Back to the defaults for the steps that follow.
        await page.evaluate(async id => fetch(`/api/preferences?accountId=${encodeURIComponent(id)}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: null, accent: null }),
        }), state.aliceId);
        await page.reload();
        await page.waitForSelector(".mail-list-pane", { timeout: 20_000 });
      }],

      ["attachments download as attachments with safe headers", async () => {
        const aliceApi = api(alice.context, worker.origin);
        const list = await aliceApi(`/api/messages?accountId=${encodeURIComponent(state.aliceId)}&folder=inbox`);
        const message = list.json.messages.find(m => m.subject === "Quarterly report");
        const detail = await aliceApi(`/api/messages/${encodeURIComponent(message.id)}?accountId=${encodeURIComponent(state.aliceId)}`);
        assert.equal(detail.status, 200);
        const files = detail.json.message.attachments;
        assert.deepEqual(files.map(f => f.filename).sort(), ["numbers.csv", "page.html"]);
        for (const file of files) {
          const download = await aliceApi(`/api/attachments/${encodeURIComponent(file.id)}?accountId=${encodeURIComponent(state.aliceId)}`);
          assert.equal(download.status, 200);
          assert.match(download.headers["content-disposition"] ?? "", /^attachment/, `${file.filename} is never shown inline`);
          assert.equal(download.headers["x-content-type-options"], "nosniff");
        }
        state.messageId = message.id;
      }],

      ["access control: a mailbox session cannot reach other accounts or administration", async () => {
        const aliceApi = api(alice.context, worker.origin);
        assert.equal((await aliceApi("/api/admin/keys")).status, 403);
        assert.equal((await aliceApi("/api/mailboxes")).status, 403);
        assert.equal((await aliceApi("/api/messages?accountId=native%3Aadmin&folder=inbox")).status, 403, "another mailbox's mail is refused");
        assert.equal((await aliceApi(`/api/messages/${encodeURIComponent(state.messageId)}?accountId=native%3Aadmin`)).status, 403);
        const crossSite = await aliceApi(`/api/blocked-senders?accountId=${encodeURIComponent(state.aliceId)}`, {
          method: "POST", body: { sender: "x@y.test" }, headers: { Origin: "https://evil.test" } });
        assert.equal(crossSite.status, 403, "cross-origin writes are refused");
        const anonymous = await fetch(`${worker.origin}/api/messages?folder=inbox`);
        assert.equal(anonymous.status, 401);
      }],

      ["blocked senders and spam go to Junk", async () => {
        const aliceApi = api(alice.context, worker.origin);
        const blocked = await aliceApi(`/api/blocked-senders?accountId=${encodeURIComponent(state.aliceId)}`, {
          method: "POST", body: { sender: "spam.test", moveExisting: true } });
        assert.equal(blocked.status, 201, blocked.text);
        assert.equal((await deliver(worker.origin, { from: "deals@mail.spam.test", to: `alice@${DOMAIN}`, subject: "Blocked offer", text: "buy" })).status, 200);
        assert.equal((await deliver(worker.origin, { from: "x@partner.test", to: `alice@${DOMAIN}`, subject: "Flagged upstream", text: "hi",
          headers: { "X-Spam-Flag": "YES" } })).status, 200);
        const junk = await aliceApi(`/api/messages?accountId=${encodeURIComponent(state.aliceId)}&folder=junk`);
        assert.deepEqual(junk.json.messages.map(m => m.subject).sort(), ["Blocked offer", "Flagged upstream"]);
        const inbox = await aliceApi(`/api/messages?accountId=${encodeURIComponent(state.aliceId)}&folder=inbox`);
        assert.ok(!inbox.json.messages.some(m => /Blocked offer|Flagged upstream/.test(m.subject)));
      }],

      ["alice sends a message from the compose window", async () => {
        const { page } = alice;
        await page.getByRole("button", { name: "New message" }).first().click();
        await page.fill(".compose-modal input[placeholder='name@example.com']", "bob@partner.test");
        await page.fill(".compose-modal input[placeholder='What’s this about?']", "Re: numbers");
        await page.fill(".compose-modal textarea[aria-label='Message']", "Thanks Bob, received.\nSee you Friday.");
        await page.locator(".compose-modal button[type=submit]").click();
        await page.waitForFunction(() => !document.querySelector(".compose-modal") || document.querySelector(".compose-send-error"), null, { timeout: 20_000 });
        const error = await page.locator(".compose-send-error").allInnerTexts();
        state.sendError = error.join(" ");
        const aliceApi = api(alice.context, worker.origin);
        const sent = await aliceApi(`/api/messages?accountId=${encodeURIComponent(state.aliceId)}&folder=sent`);
        if (!state.sendError) {
          const message = sent.json.messages.find(m => m.subject === "Re: numbers");
          assert.ok(message, "the sent message is in Sent");
          // The form arrives with CRLF line breaks; each must stay one line break, not two.
          const detail = (await aliceApi(`/api/messages/${encodeURIComponent(message.id)}?accountId=${encodeURIComponent(state.aliceId)}`)).json.message;
          assert.equal(detail.bodyText, "Thanks Bob, received.\nSee you Friday.");
          assert.doesNotMatch(detail.bodyHtml, /\r/, "no carriage return reaches the HTML part");
          assert.match(detail.bodyHtml, /received\.<br>See you Friday\./);
        } else {
          // Local wrangler may not support outbound sending; the app must fail cleanly and keep nothing half-sent.
          assert.ok(!sent.json.messages.some(m => m.subject === "Re: numbers" && m.deliveryStatus === "sent"));
          console.log(`    note: local sending unavailable (${state.sendError})`);
        }
      }],

      ["a conversation is read, archived and moved to Junk as a whole", async () => {
        const aliceApi = api(alice.context, worker.origin);
        const account = `accountId=${encodeURIComponent(state.aliceId)}`;
        const first = await deliver(worker.origin, { from: "carol@partner.test", to: `alice@${DOMAIN}`, subject: "Planning", text: "Shall we plan?" });
        assert.equal(first.status, 200, first.body);
        const reply = await deliver(worker.origin, { from: "carol@partner.test", to: `alice@${DOMAIN}`, subject: "Re: Planning", text: "Any news?",
          headers: { "In-Reply-To": first.messageId, References: first.messageId } });
        assert.equal(reply.status, 200, reply.body);
        const before = await aliceApi(`/api/messages?${account}&folder=inbox`);
        const thread = before.json.messages.filter(m => /Planning/.test(m.subject));
        assert.equal(thread.length, 2);
        assert.equal(new Set(thread.map(m => m.threadId)).size, 1, "the reply joins the conversation");
        const opened = await aliceApi(`/api/messages/${encodeURIComponent(thread[0].id)}?${account}`);
        assert.equal(opened.json.newlyReadCount, 2, "opening reads every unread message of the conversation");
        const after = await aliceApi(`/api/messages?${account}&folder=inbox`);
        assert.equal(after.json.unreadCount, before.json.unreadCount - 2, "the unread count drops by the whole conversation");

        const patch = body => aliceApi(`/api/messages/${encodeURIComponent(thread[0].id)}?${account}`, { method: "PATCH", body: { ...body, scope: "thread" } });
        const subjects = async folder => (await aliceApi(`/api/messages?${account}&folder=${folder}`)).json.messages
          .filter(m => /Planning/.test(m.subject)).length;
        assert.equal((await patch({ isArchived: true })).status, 200);
        assert.deepEqual([await subjects("inbox"), await subjects("archive")], [0, 2], "archiving moves the whole conversation");
        assert.equal((await patch({ isArchived: false })).status, 200);
        assert.equal((await patch({ isJunk: true })).status, 200);
        assert.deepEqual([await subjects("inbox"), await subjects("junk")], [0, 2], "junk moves the whole conversation");
        assert.equal((await patch({ isJunk: false })).status, 200);
        assert.equal(await subjects("inbox"), 2);
        assert.equal((await patch({ isStarred: true })).status, 400, "other changes stay per message");
      }],

      ["a redelivered message is stored once", async () => {
        const aliceApi = api(alice.context, worker.origin);
        // Email Routing retries with the identical message (same bytes).
        const fields = { from: "dave@partner.test", to: `alice@${DOMAIN}`, subject: "Delivered twice", text: "once" };
        const message = { ...fields, ...mime(fields) };
        assert.equal((await deliver(worker.origin, message)).status, 200);
        assert.equal((await deliver(worker.origin, message)).status, 200, "a retry of an accepted delivery succeeds quietly");
        const inbox = await aliceApi(`/api/messages?accountId=${encodeURIComponent(state.aliceId)}&folder=inbox`);
        assert.equal(inbox.json.messages.filter(m => m.subject === "Delivered twice").length, 1);
      }],

      ["drafts reject malformed ids and oversized recipients", async () => {
        const aliceApi = api(alice.context, worker.origin);
        const save = body => aliceApi("/api/drafts", { method: "POST", body: { accountId: state.aliceId, ...body } });
        assert.equal((await save({ id: "../../etc", subject: "x" })).status, 400);
        const saved = await save({ subject: "Draft", to: `bob@partner.test, ${"a".repeat(400)}@partner.test` });
        assert.ok([200, 201].includes(saved.status), saved.text);
        const draft = await aliceApi(`/api/drafts/${encodeURIComponent(saved.json.draft.id)}?accountId=${encodeURIComponent(state.aliceId)}`);
        const to = JSON.stringify(draft.json);
        assert.ok(!to.includes("a".repeat(400)), "an address over 320 characters is not kept");
      }],

      ["a slow autosave never brings back a discarded or sent draft", async () => {
        const { page } = alice;
        state.page = page;
        const aliceApi = api(alice.context, worker.origin);
        const drafts = async () => (await aliceApi(`/api/messages?accountId=${encodeURIComponent(state.aliceId)}&folder=drafts`)).json.messages
          .map(m => m.subject);
        // Every draft save takes 1.5 s, so one is still in flight when the draft is discarded or sent.
        const slow = async route => {
          if (route.request().method() === "POST") await new Promise(resolve => setTimeout(resolve, 1500));
          await route.continue();
        };
        await page.route("**/api/drafts", slow);
        try {
          const compose = async (subject, to = "") => {
            await page.getByRole("button", { name: "New message" }).first().click();
            if (to) await page.fill(".compose-modal input[placeholder='name@example.com']", to);
            await page.fill(".compose-modal input[placeholder='What’s this about?']", subject);
            await page.fill(".compose-modal textarea[aria-label='Message']", `${subject} body`);
            await page.waitForRequest(request => request.url().endsWith("/api/drafts") && request.method() === "POST", { timeout: 5_000 });
          };
          await compose("Slow discard");
          await page.locator(".compose-discard").click();
          await page.locator(".compose-modal").waitFor({ state: "detached", timeout: 10_000 });
          await compose("Slow send", "bob@partner.test");
          await page.locator(".compose-modal button[type=submit]").click();
          await page.waitForFunction(() => !document.querySelector(".compose-modal") || document.querySelector(".compose-send-error"), null, { timeout: 20_000 });
          await page.waitForTimeout(2500);
          const left = await drafts();
          assert.ok(!left.includes("Slow discard"), "a discarded draft stays deleted");
          if (!state.sendError) assert.ok(!left.includes("Slow send"), "a sent draft stays deleted");
        } finally {
          await page.unroute("**/api/drafts", slow);
        }
        // The server also refuses to recreate a draft that was sent.
        const sentDraft = await aliceApi("/api/drafts", { method: "POST", body: { accountId: state.aliceId, id: "sent-draft-1", subject: "x", to: "bob@partner.test" } });
        assert.equal(sentDraft.status, 200);
        const form = new FormData();
        for (const [key, value] of Object.entries({ accountId: state.aliceId, draftId: "sent-draft-1", to: "bob@partner.test", subject: "Sent draft", text: "x" })) form.set(key, value);
        const sent = await page.evaluate(async entries => {
          const body = new FormData();
          for (const [key, value] of entries) body.set(key, value);
          const response = await fetch("/api/send", { method: "POST", body });
          return response.status;
        }, [...form.entries()]);
        if (sent === 201) {
          const late = await aliceApi("/api/drafts", { method: "POST", body: { accountId: state.aliceId, id: "sent-draft-1", subject: "late" } });
          assert.equal(late.status, 409, "a late save of a sent draft is refused");
          assert.ok(!(await drafts()).includes("late"));
        }
      }],

      ["opening unread Junk mail leaves the Inbox badge alone", async () => {
        const { page } = alice;
        state.page = page;
        const aliceApi = api(alice.context, worker.origin);
        const account = `accountId=${encodeURIComponent(state.aliceId)}`;
        const inbox = (await aliceApi(`/api/messages?${account}&folder=inbox`)).json.messages.map(m => m.id);
        assert.equal((await aliceApi(`/api/messages/bulk?${account}`, { method: "POST", body: { ids: inbox, action: "read" } })).status, 200);
        assert.equal((await aliceApi(`/api/messages?${account}&folder=inbox`)).json.unreadCount, 0);
        assert.equal((await deliver(worker.origin, { from: "y@partner.test", to: `alice@${DOMAIN}`, subject: "Unread spam", text: "x",
          headers: { "X-Spam-Flag": "YES" } })).status, 200);
        await page.reload();
        await page.waitForSelector(".mail-list-pane");
        await navItem(page, "Junk").click();
        await page.locator(".mail-row", { hasText: "Unread spam" }).click();
        await page.locator(".reader-pane h2", { hasText: "Unread spam" }).waitFor();
        await page.waitForTimeout(500);
        assert.equal((await aliceApi(`/api/messages?${account}&folder=inbox`)).json.unreadCount, 0);
        assert.deepEqual(await navItem(page, "Inbox").locator(".nav-count").allInnerTexts(), [], "no unread badge on an empty Inbox");
      }],

      ["the list never stays on \"Loading mail…\" after a refresh overlaps a load", async () => {
        const { page } = alice;
        const spinner = page.locator(".mail-list-state", { hasText: "Loading mail" });
        const slowOnce = folder => {
          let delayed = false;
          return async route => {
            if (!delayed && route.request().url().includes(`folder=${folder}`)) {
              delayed = true;
              await new Promise(resolve => setTimeout(resolve, 1500));
            }
            await route.continue().catch(() => undefined);
          };
        };
        // The window regains focus while a folder is loading.
        const archive = slowOnce("archive");
        await page.route("**/api/messages?*", archive);
        try {
          await navItem(page, "Archive").click();
          await spinner.waitFor();
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await spinner.waitFor({ state: "detached", timeout: 6_000 });
        } finally {
          await page.unroute("**/api/messages?*", archive);
        }
        // A reader action fails while the list is refreshing.
        await navItem(page, "Inbox").click();
        await page.locator(".mail-row").first().click();
        await page.locator(".reader-pane h2").waitFor();
        const inbox = slowOnce("inbox");
        const failPatch = route => route.request().method() === "PATCH"
          ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"unavailable"}' })
          : route.continue();
        await page.route("**/api/messages?*", inbox);
        await page.route("**/api/messages/*", failPatch);
        try {
          await page.getByRole("button", { name: "Refresh mailbox" }).first().click();
          await spinner.waitFor();
          await page.getByRole("button", { name: "Star message" }).click();
          await spinner.waitFor({ state: "detached", timeout: 6_000 });
        } finally {
          await page.unroute("**/api/messages?*", inbox);
          await page.unroute("**/api/messages/*", failPatch);
        }
      }],

      ["attachments never carry into another message", async () => {
        const { page } = alice;
        const chips = () => page.locator(".compose-modal .file-chips").count();
        const attach = name => page.locator(".compose-modal input[type=file]").setInputFiles({ name, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 x") });
        const close = async () => {
          await page.locator(".compose-close").dispatchEvent("click");
          await page.locator(".compose-modal").waitFor({ state: "detached" });
        };
        await page.getByRole("button", { name: "New message" }).first().click();
        await page.fill(".compose-modal input[placeholder='name@example.com']", "carry@else.test");
        await attach("first.pdf");
        await close();
        // Reopening the saved draft (drafts keep no attachments).
        await navItem(page, "Drafts").click();
        await page.locator(".mail-row", { hasText: "carry@else.test" }).click();
        await page.locator(".compose-modal").waitFor();
        assert.equal(await chips(), 0, "a reopened draft has no attachments from another message");
        await attach("second.pdf");
        await close();
        await navItem(page, "Inbox").click();
        await page.locator(".mail-row").first().click();
        await page.locator(".reader-pane h2").waitFor();
        await page.locator(".reply-primary").click();
        await page.locator(".compose-modal").waitFor();
        assert.equal(await chips(), 0, "a reply starts without attachments");
        await attach("third.pdf");
        await close();
        await page.locator(".reader-reply-bar button", { hasText: "Forward" }).click();
        await page.locator(".compose-modal").waitFor();
        assert.equal(await chips(), 0, "a forward starts without attachments");
        await close();
      }],

      ["discarding an autosaved draft updates the Drafts count", async () => {
        const { page } = alice;
        const aliceApi = api(alice.context, worker.origin);
        const server = async () => (await aliceApi(`/api/messages?accountId=${encodeURIComponent(state.aliceId)}&folder=drafts`)).json.draftCount;
        const badge = () => navItem(page, "Drafts").locator(".nav-count").allInnerTexts();
        await page.reload();
        await page.waitForSelector(".mail-list-pane");
        const before = await server();
        await page.waitForFunction(n => [...document.querySelectorAll(".desktop-sidebar .nav-item")]
          .some(el => el.textContent.includes("Drafts") && (el.querySelector(".nav-count")?.textContent ?? "") === (n ? String(n) : "")), before);
        await page.getByRole("button", { name: "New message" }).first().click();
        await page.fill(".compose-modal input[placeholder='What’s this about?']", "Throwaway");
        await page.locator(".compose-from", { hasText: "Draft saved" }).waitFor({ timeout: 10_000 });
        await page.locator(".compose-discard").dispatchEvent("click");
        await page.locator(".compose-modal").waitFor({ state: "detached" });
        await page.waitForTimeout(800);
        assert.equal(await server(), before);
        assert.deepEqual(await badge(), before ? [String(before)] : [], "the badge matches the server");
      }],

      ["a failed reader action never hides the message after leaving the folder", async () => {
        const { page } = alice;
        const failPatch = async route => {
          if (route.request().method() !== "PATCH") return route.continue();
          await new Promise(resolve => setTimeout(resolve, 1500));
          await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"unavailable"}' });
        };
        await page.route("**/api/messages/*", failPatch);
        try {
          const row = page.locator(".mail-row").first();
          const subject = (await row.locator(".mail-row-subject strong").innerText()).trim();
          await row.click();
          await page.locator(".reader-pane h2", { hasText: subject }).waitFor();
          await page.locator(".reader-reply-bar button.destructive").click();
          await navItem(page, "Archive").click();
          await page.waitForTimeout(2500);
          await navItem(page, "Inbox").click();
          await page.locator(".mail-row", { hasText: subject }).first().waitFor({ timeout: 6_000 });
        } finally {
          await page.unroute("**/api/messages/*", failPatch);
        }
      }],

      ["compose and settings close buttons work on a laptop-height window", async () => {
        const { page } = alice;
        const reachable = selector => page.evaluate(sel => {
          const box = document.querySelector(sel).getBoundingClientRect();
          return Boolean(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest(sel));
        }, selector);
        try {
          for (const [width, height, file] of [[1366, 657, false], [1280, 720, true]]) {
            await page.setViewportSize({ width, height });
            await page.getByRole("button", { name: "New message" }).first().click();
            await page.fill(".compose-modal input[placeholder='What’s this about?']", "Laptop");
            if (file) await page.locator(".compose-modal input[type=file]").setInputFiles({ name: "a.pdf", mimeType: "application/pdf", buffer: Buffer.from("x") });
            assert.ok(await reachable(".compose-close"), `Close is clickable at ${width}x${height}`);
            assert.ok(await reachable(".compose-discard"), `Discard is clickable at ${width}x${height}`);
            await page.locator(".compose-discard").click({ timeout: 3_000 });
            await page.locator(".compose-modal").waitFor({ state: "detached" });
          }
          await page.setViewportSize({ width: 1366, height: 657 });
          await page.locator(".desktop-sidebar button", { hasText: "Settings" }).click();
          assert.ok(await reachable(".settings-close"), "Settings close is clickable");
          await page.locator(".settings-close").click({ timeout: 3_000 });
          await page.locator(".settings-backdrop").waitFor({ state: "detached" });
        } finally {
          await page.setViewportSize({ width: 1280, height: 720 });
        }
      }],

      ["phones: folders in a left drawer, compose bottom-right, actions on the bottom edge", async () => {
        const { page } = alice;
        const [width, height] = [390, 844];
        const box = selector => page.locator(selector).first().boundingBox();
        try {
          await page.setViewportSize({ width, height });
          await page.reload();
          await page.locator(".mail-row").first().waitFor();
          assert.equal(await page.locator(".mobile-nav").count(), 0, "no bottom tab bar");
          assert.equal(await page.locator(".mobile-drawer").isVisible(), false, "the drawer starts closed");

          const fab = await box(".mobile-compose-fab");
          assert.ok(Math.abs(height - (fab.y + fab.height) - 18) <= 2, `compose sits 18px above the bottom (${JSON.stringify(fab)})`);
          assert.ok(Math.abs(width - (fab.x + fab.width) - 17) <= 2, "compose sits on the right");

          await page.getByRole("button", { name: "Open folders" }).click();
          const drawer = page.locator(".mobile-drawer");
          await drawer.waitFor({ state: "visible" });
          await page.waitForFunction(() => document.querySelector(".mobile-drawer").getBoundingClientRect().left === 0);
          await drawer.locator(".nav-item", { hasText: "Archive" }).click();
          await page.locator(".mail-list-header h1", { hasText: "Archive" }).waitFor();
          await drawer.waitFor({ state: "hidden" });

          await page.getByRole("button", { name: "Open folders" }).click();
          await page.keyboard.press("Escape");
          await drawer.waitFor({ state: "hidden" });
          await page.getByRole("button", { name: "Open folders" }).click();
          await drawer.locator(".nav-item", { hasText: "Inbox" }).click();
          await page.locator(".mail-list-header h1", { hasText: "Inbox" }).waitFor();
          await drawer.waitFor({ state: "hidden" });

          await page.locator(".mail-row").first().click();
          await page.locator(".reader-reply-bar").waitFor();
          const bar = await box(".reader-reply-bar");
          assert.ok(Math.abs(height - (bar.y + bar.height)) <= 1, `the action bar reaches the bottom edge (${JSON.stringify(bar)})`);
          const visibleLabels = await page.locator(".reader-reply-bar button:visible .reader-action-label").allInnerTexts();
          assert.deepEqual(visibleLabels, ["Reply", "Forward", "Archive", "Junk", "Unsub", "Delete"], "the bottom bar's actions, in order (Unsubscribe shortened to fit)");
          assert.equal(await page.locator(".reader-actions button").count(), 1, "the top bar keeps only Star");
          assert.equal(await page.locator(".mobile-compose-fab").isVisible(), false, "compose hides while a message is open");
          await page.locator(".reader-back").click();
          await page.locator(".mail-row").first().waitFor();
        } finally {
          await page.setViewportSize({ width: 1280, height: 720 });
        }
      }],

      ["desktop: equal action buttons in order, inside the window; medium windows show list or reader", async () => {
        const { page } = alice;
        const bar = () => page.evaluate(() => {
          const buttons = [...document.querySelectorAll(".reader-reply-bar button")].filter(b => b.getClientRects().length);
          const box = document.querySelector(".reader-reply-bar").getBoundingClientRect();
          return {
            labels: buttons.map(b => b.querySelector(".reader-action-label").innerText.trim()),
            widths: [...new Set(buttons.map(b => Math.round(b.getBoundingClientRect().width)))],
            cut: buttons.some(b => { const l = b.querySelector(".reader-action-label"); return l.scrollWidth > l.clientWidth + 1; }),
            bottom: box.bottom, right: box.right, height: innerHeight,
          };
        });
        try {
          await page.setViewportSize({ width: 1280, height: 720 });
          await page.reload();
          await navItem(page, "Inbox").click();
          await page.locator(".mail-row").first().click();
          await page.locator(".reader-reply-bar").waitFor();
          let state = await bar();
          assert.deepEqual(state.labels, ["Reply", "Forward", "Archive", "Junk", "Unsub", "Delete"], "order, with Unsubscribe shortened to fit");
          assert.equal(state.widths.length, 1, `equal widths (${state.widths})`);
          assert.ok(!state.cut, "no label is cut off");
          assert.ok(state.bottom <= state.height, `the bar is inside the window (${state.bottom} > ${state.height})`);
          const borders = await page.evaluate(() => [".mail-filter-tabs", ".reader-toolbar"].map(s => Math.round(document.querySelector(s).getBoundingClientRect().bottom)));
          assert.equal(borders[0], borders[1], `the list's tab row and the reader's title bar end on one line (${borders})`);

          await page.setViewportSize({ width: 1600, height: 900 });
          state = await bar();
          assert.deepEqual(state.labels, ["Reply", "Forward", "Archive", "Junk", "Unsubscribe", "Delete"], "full words when they fit");
          assert.equal(state.widths.length, 1);

          await page.setViewportSize({ width: 1024, height: 700 });
          assert.equal(await page.locator(".mail-list-scroll").isVisible(), false, "the list makes room for the open message");
          assert.ok(await page.locator(".desktop-topbar").isVisible(), "the search bar stays");
          state = await bar();
          assert.ok(!state.cut && state.widths.length === 1 && state.bottom <= state.height);
          await page.locator(".reader-back").click();
          await page.locator(".mail-list-scroll").waitFor();
          assert.equal(await page.locator(".reader-pane").isVisible(), false, "with no message open, the list fills the space");
        } finally {
          await page.setViewportSize({ width: 1280, height: 720 });
        }
      }],

      ["the administrator opens on All inboxes, with every mailbox's mail", async () => {
        // A new tab: the open mailbox is remembered per tab, a fresh start opens All inboxes.
        const page = await admin.context.newPage();
        state.page = page;
        await page.goto(worker.origin);
        await page.waitForSelector(".mail-list-pane", { timeout: 20_000 });
        // The (mobile) header shows a placeholder until the account list has loaded.
        await page.locator(".mail-list-header").filter({ hasText: /All inboxes/i }).waitFor({ state: "attached", timeout: 20_000 });
        await page.locator(".mail-row").filter({ hasText: "Quarterly report" }).first().waitFor({ timeout: 15_000 });
        const accounts = await adminApi("/api/accounts");
        assert.ok(accounts.json.accounts.some(a => a.emailAddress === `alice@${DOMAIN}`));
        assert.ok(accounts.json.accounts.some(a => a.emailAddress === `admin@${DOMAIN}`));
      }],

      ["attachments open in the system viewer, never replace the app, and close by tapping outside", async () => {
        const page = alice.page;
        await page.bringToFront();
        const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]>>endobj\ntrailer<</Root 1 0 R>>";
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
        assert.equal((await deliver(worker.origin, { from: "Bob <bob@partner.test>", to: `alice@${DOMAIN}`, subject: "Files to open", text: "files",
          attachments: [{ name: "photo.png", type: "image/png", content: png }, { name: "doc.pdf", type: "application/pdf", content: pdf }] })).status, 200);
        try {
          for (const [width, height] of [[1280, 720], [390, 844]]) {
            await page.setViewportSize({ width, height });
            await page.reload();
            await page.locator(".mail-row", { hasText: "Files to open" }).first().click();
            for (const name of ["photo.png", "doc.pdf"]) {
              await page.locator(".attachment-card", { hasText: name }).click();
              const viewer = page.locator(".attachment-preview-backdrop");
              await viewer.waitFor();
              const open = viewer.locator(".attachment-preview-open");
              assert.equal(await open.getAttribute("target"), "_blank", `${name}: Open uses a new window`);
              assert.match(await open.getAttribute("href"), /^\/api\/attachment-previews\//);
              assert.equal(await viewer.locator(".attachment-preview-download").getAttribute("target"), "_blank", `${name}: Download never replaces the app`);
              const response = await page.request.get(worker.origin + await open.getAttribute("href"));
              assert.match(response.headers()["content-security-policy"] ?? "", /default-src 'none'/, "the opened file runs no script");
              await page.locator(".attachment-preview-body").click({ position: { x: 4, y: 4 } });
              await viewer.waitFor({ state: "detached" });
            }
          }
        } finally {
          await page.setViewportSize({ width: 1280, height: 720 });
        }
      }],

      ["admin panel: one button size, themed dropdowns, green set-up chips, a chevron that stays put", async () => {
        const page = admin.page;
        await page.bringToFront();
        await page.goto(`${worker.origin}/#admin`);
        await page.reload();
        await page.locator(".admin-home-nav").waitFor({ timeout: 15_000 });
        for (const selector of ["#admin-security .key-chip-ok", "#admin-keys .key-chip-ok", ".admin-mailbox-status.is-active", ".admin-home select"]) {
          await page.locator(selector).first().waitFor({ state: "attached", timeout: 15_000 });
        }
        const looks = await page.evaluate(() => {
          const visible = [...document.querySelectorAll(".admin-home :is(.settings-primary, .auth-secondary, .settings-row-actions button)")].filter(el => el.getClientRects().length);
          const color = sel => getComputedStyle(document.querySelector(sel)).color;
          return {
            heights: [...new Set(visible.map(el => Math.round(el.getBoundingClientRect().height)))],
            fonts: [...new Set(visible.map(el => getComputedStyle(el).fontSize))],
            selects: [...new Set([...document.querySelectorAll(".admin-home select")].map(el => getComputedStyle(el).appearance))],
            passkey: color("#admin-security .key-chip-ok"), keyOk: color("#admin-keys .key-chip-ok"), active: color(".admin-mailbox-status.is-active"),
          };
        });
        assert.deepEqual(looks.heights, [36], `buttons share one height (${looks.heights})`);
        assert.deepEqual(looks.fonts, ["12px"], `buttons share one text size (${looks.fonts})`);
        assert.deepEqual(looks.selects, ["none"], "dropdowns use the themed field");
        assert.equal(looks.passkey, looks.keyOk, "Passkey enabled is the same green as the set-up keys");
        assert.equal(looks.active, looks.keyOk, "an active mailbox is the same green");
        const summary = page.locator("details.admin-mailbox-more > summary").first();
        await summary.scrollIntoViewIfNeeded();
        const before = await summary.boundingBox();
        await summary.click();
        await page.waitForTimeout(250);
        const after = await summary.boundingBox();
        assert.deepEqual(after, before, `More actions stays put when opened (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
        await summary.click();
      }],

      ["signing out ends the mailbox session", async () => {
        const aliceApi = api(alice.context, worker.origin);
        assert.equal((await aliceApi("/api/device/logout", { method: "POST" })).status, 200);
        assert.equal((await aliceApi(`/api/messages?accountId=${encodeURIComponent(state.aliceId)}&folder=inbox`)).status, 401);
      }],
      ["disabling a mailbox ends its sessions at once", async () => {
        const session = await contextWithPasskey(browser);
        try {
          const aliceApi = api(session.context, worker.origin);
          const login = await aliceApi("/api/device/login", { method: "POST", body: { email: `alice@${DOMAIN}`, password: state.alicePassword } });
          assert.equal(login.status, 200, login.text);
          const inbox = `/api/messages?accountId=${encodeURIComponent(state.aliceId)}&folder=inbox`;
          assert.equal((await aliceApi(inbox)).status, 200);
          // The administrator disables alice@ in the admin panel (passkey approval).
          const page = admin.page;
          state.page = page;
          await page.bringToFront();
          await page.goto(`${worker.origin}/#admin`);
          await page.reload();
          const row = page.locator(".admin-mailbox-item").filter({ hasText: `alice@${DOMAIN}` });
          const status = row.locator(".admin-mailbox-status");
          const toggle = async (label, expected) => {
            await row.locator("details.admin-mailbox-more").evaluate(el => { el.open = true; });
            await row.getByRole("button", { name: label, exact: true }).click();
            await page.waitForFunction(([selector, text]) => [...document.querySelectorAll(selector)]
              .some(el => el.textContent.includes(text[0]) && el.querySelector(".admin-mailbox-status")?.textContent === text[1]),
            [".admin-mailbox-item", [`alice@${DOMAIN}`, expected]], { timeout: 20_000 });
          };
          await status.waitFor({ timeout: 20_000 });
          await toggle("Disable", "Disabled");
          assert.ok([401, 403].includes((await aliceApi(inbox)).status), "the signed-in session lost access");
          await toggle("Enable", "Active");
          assert.ok([401, 403].includes((await aliceApi(inbox)).status), "re-enabling does not revive the old session");
        } finally {
          await session.context.close();
        }
      }],
    ], () => state.page ?? admin?.page);
    return failed;
  } finally {
    await browser.close();
    if (process.env.E2E_SHOW_LOGS) console.log(worker.logs.join(""));
    await worker.stop();
  }
}
