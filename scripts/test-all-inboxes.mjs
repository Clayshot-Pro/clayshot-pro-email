// All inboxes: merged lists stay attributable to their account, and every
// change is sent to the account that owns the message.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALL_INBOXES_ID, accountLabel, allInboxesAvailable, groupByAccount, mergeAccountLists, startingAccountId, threadKey, unifiedAccounts,
} from "../src/client/allInboxes.ts";
import { applyMailMutationShields, mailMutationKey } from "../src/client/mailMutationShields.ts";

const account = (id, extra = {}) => ({ id, provider: id.startsWith("gmail:") ? "gmail" : "native", emailAddress: `${id.split(":")[1]}@example.com`,
  displayName: null, avatarUrl: null, status: "active", lastSyncedAt: null, ...extra });
const message = (id, at, extra = {}) => ({ id, threadId: `t-${id}`, direction: "inbound", fromAddress: "a@b.c", fromName: null,
  toAddresses: [], subject: id, preview: "", receivedAt: at, sentAt: null, isRead: false, isStarred: false, isArchived: false,
  isDeleted: false, isJunk: false, hasAttachments: false, deliveryStatus: null, ...extra });

// Offered only with two or more usable accounts.
assert.equal(allInboxesAvailable([account("native:primary")]), false);
assert.equal(allInboxesAvailable([account("native:primary"), account("gmail:x", { status: "reauth_required" })]), false);
assert.equal(allInboxesAvailable([account("native:primary"), account("gmail:x")]), true);
assert.deepEqual(unifiedAccounts([account("native:a"), account("native:b", { status: "disabled" })]).map(a => a.id), ["native:a"]);
assert.ok(!["native:", "gmail:"].some(prefix => ALL_INBOXES_ID.startsWith(prefix)), "the pseudo account can never name a real one");

// The app opens on All inboxes with two or more accounts, else on the one account.
assert.equal(startingAccountId([account("native:admin"), account("native:work"), account("gmail:x")]), ALL_INBOXES_ID);
assert.equal(startingAccountId([account("gmail:x")]), "gmail:x");
assert.equal(startingAccountId([account("native:work"), account("gmail:x", { status: "reauth_required" })]), "native:work",
  "an account that needs reconnecting does not make All inboxes the start");
assert.equal(startingAccountId([]), null);
const appSource = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
assert.match(appSource, /const selectedId = startingAccountId\(accounts\);/);
assert.doesNotMatch(appSource, /ltm:active-mail-account/, "the last mailbox used on the device no longer decides where the app opens");

// Merge: newest first, tagged, counts summed, failures reported, duplicates dropped.
const merged = mergeAccountLists([
  { accountId: "native:primary", ok: true, unreadCount: 2, draftCount: 1, folderTotalCount: 3,
    messages: [message("n1", "2026-10-18T08:00:00Z"), message("n2", "2026-10-16T08:00:00Z"), message("n1", "2026-10-18T08:00:00Z")] },
  { accountId: "gmail:x", ok: true, unreadCount: 5, draftCount: 0, folderTotalCount: null,
    messages: [message("g1", "2026-10-17T08:00:00Z"), message("g2", "2026-10-19T08:00:00Z", { sentAt: "2026-10-15T00:00:00Z" })] },
  { accountId: "gmail:broken", ok: false },
]);
assert.deepEqual(merged.messages.map(m => `${m.accountId}/${m.id}`),
  ["native:primary/n1", "gmail:x/g1", "native:primary/n2", "gmail:x/g2"], "sorted by the date shown in the list (sent, else received)");
assert.equal(merged.unreadCount, 7);
assert.equal(merged.draftCount, 1);
assert.equal(merged.folderTotalCount, 3);
assert.deepEqual(merged.failedAccountIds, ["gmail:broken"]);
assert.equal(mergeAccountLists([]).folderTotalCount, null);

// Same thread ID in two mailboxes must not collapse into one row.
assert.notEqual(threadKey({ ...message("a", ""), threadId: "t", accountId: "native:a" }),
  threadKey({ ...message("b", ""), threadId: "t", accountId: "gmail:x" }));

// Bulk actions are split per owning account, in order.
const owners = { n1: "native:primary", g1: "gmail:x", n2: "native:primary" };
assert.deepEqual([...groupByAccount(["n1", "g1", "n2"], id => owners[id])],
  [["native:primary", ["n1", "n2"]], ["gmail:x", ["g1"]]]);

assert.equal(accountLabel(account("gmail:x", { displayName: "  Work  " })), "Work");
assert.equal(accountLabel(account("gmail:x")), "x@example.com");
assert.equal(accountLabel(undefined), "");

// Read-your-writes shields apply to the message's own account in a merged list.
const shields = new Map([[mailMutationKey("gmail:x", "same"), { flags: { isDeleted: true }, updatedAt: Date.now() }]]);
const shielded = applyMailMutationShields("inbox", ALL_INBOXES_ID, [
  { ...message("same", "2026-10-18T00:00:00Z"), accountId: "gmail:x" },
  { ...message("same", "2026-10-18T00:00:00Z"), accountId: "native:primary" },
], shields);
assert.deepEqual(shielded.map(m => m.accountId), ["native:primary"], "only the deleted message's own account row is hidden");

// App: no message request is sent with the pseudo account; each uses the owning account.
const app = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
for (const route of ["/api/messages/bulk?accountId=", "/api/drafts/${encodeURIComponent(id)}?accountId="]) {
  const at = app.indexOf(route);
  assert.ok(at > 0, route);
  assert.doesNotMatch(app.slice(at, at + 90), /activeAccountId/, `${route} uses the message's account`);
}
assert.match(app, /accountId=\$\{encodeURIComponent\(accountId\)\}`,\s*\{\s*method: "PATCH"/, "PATCH goes to the reader's account");
assert.match(app, /"\?accountId=" \+ encodeURIComponent\(accountId\),\s*\{ method: "DELETE" \}/, "permanent delete goes to the reader's account");

console.log("PASS: All inboxes merges per-account lists and routes every change to the owning account");
