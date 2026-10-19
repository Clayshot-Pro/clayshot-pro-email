// End-to-end: first-run setup, administration, receiving, reading, sending,
// junk and blocking, All inboxes and access control, against the real Worker.
import assert from "node:assert/strict";
import { SETUP_SECRET, api, contextWithPasskey, deliver, launchBrowser, mime, startWorker, steps } from "./harness.mjs";

const DOMAIN = "e2e.test";
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

      ["alice signs in with her mailbox password and reads the message safely", async () => {
        alice = await contextWithPasskey(browser);
        state.page = alice.page;
        const { page } = alice;
        await page.goto(worker.origin);
        await page.fill("#device-email", `alice@${DOMAIN}`);
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
        assert.ok(!results.tracker || !/^https?:/i.test(results.tracker), "remote images (trackers) are not loaded");
        assert.doesNotMatch(results.sandbox, /allow-scripts/);
        assert.deepEqual(alice.errors, [], "no page errors");
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
        await page.fill(".compose-modal textarea[aria-label='Message']", "Thanks Bob, received.");
        await page.locator(".compose-modal button[type=submit]").click();
        await page.waitForFunction(() => !document.querySelector(".compose-modal") || document.querySelector(".compose-send-error"), null, { timeout: 20_000 });
        const error = await page.locator(".compose-send-error").allInnerTexts();
        state.sendError = error.join(" ");
        const aliceApi = api(alice.context, worker.origin);
        const sent = await aliceApi(`/api/messages?accountId=${encodeURIComponent(state.aliceId)}&folder=sent`);
        if (!state.sendError) {
          assert.ok(sent.json.messages.some(m => m.subject === "Re: numbers"), "the sent message is in Sent");
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
