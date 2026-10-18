import assert from "node:assert/strict";
import { permanentlyDeleteNativeTrashBatch } from "../src/worker/api/nativeBulkTrash.ts";

function fixture() {
  const rows = new Map([
    ["a", { id: "a", thread_id: "thread-a", is_deleted: 1, raw_r2_key: null, body_text: "hello", body_html: null }],
    ["b", { id: "b", thread_id: "thread-b", is_deleted: 1, raw_r2_key: null, body_text: "bye", body_html: null }],
    ["notTrash", { id: "notTrash", thread_id: "thread-c", is_deleted: 0, raw_r2_key: null, body_text: "not deleted", body_html: null }],
    ["otherMailbox", { id: "otherMailbox", thread_id: "thread-d", is_deleted: 1, raw_r2_key: null, body_text: "private", body_html: null, mailbox_id: "native:other" }],
  ]);
  const calls = [];
  const batchResults = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...bindings) {
            return {
              sql,
              bindings,
              async all() {
                calls.push(sql);
                if (/SELECT id,thread_id,raw_r2_key/.test(sql)) {
                  return { results: bindings.slice(1).map(id => rows.get(id))
                    .filter(row => row && (row.mailbox_id ?? "native:primary") === bindings[0]) };
                }
                if (/SELECT r2_key FROM attachments/.test(sql)) return { results: [] };
                throw Error("Unexpected mock read: " + sql);
              },
              async run() { return { meta: { changes: 1 } }; },
              async first() { return null; },
            };
          },
        };
      },
      async batch(statements) {
        batchResults.push(statements);
        assert.equal(statements.length, 3);
        assert.match(statements[0].sql, /is_deleted=1/);
        assert.match(statements[0].sql, /mailbox_id=\?/);
        assert.match(statements[1].sql, /message_count/);
        assert.match(statements[2].sql, /NOT EXISTS/);
        const [mailbox, ...ids] = statements[0].bindings;
        let changes = 0;
        for (const id of ids) {
          const row = rows.get(id);
          if (row && row.is_deleted === 1 && (row.mailbox_id ?? "native:primary") === mailbox) {
            rows.delete(id);
            changes++;
          }
        }
        return [{ meta: { changes } }, { meta: { changes: 0 } }, { meta: { changes: 0 } }];
      },
    },
    MAIL: { head: async () => null, delete: async () => undefined },
  };
  const background = [];
  const ctx = { waitUntil(promise) { background.push(promise); } };
  return { env, ctx, rows, calls, batchResults, background };
}

{
  const { env, ctx, rows, batchResults, background } = fixture();
  const result = await permanentlyDeleteNativeTrashBatch(env, "native:primary",
    ["a", "b", "missing", "notTrash", "otherMailbox"], ctx);
  assert.deepEqual(result.succeeded, ["a", "b", "missing", "otherMailbox"]);
  assert.deepEqual(result.failed.map(item => item.id), ["notTrash"]);
  assert.equal(result.cleanupPending, true);
  assert.equal(rows.has("a"), false);
  assert.equal(rows.has("b"), false);
  assert.equal(rows.has("notTrash"), true);
  assert.equal(rows.has("otherMailbox"), true, "another mailbox must never be modified");
  assert.equal(batchResults.length, 1, "one database transaction per batch, not 50 per-message deletions");
  await Promise.all(background);
  const retry = await permanentlyDeleteNativeTrashBatch(env, "native:primary", ["a", "b"], ctx);
  assert.deepEqual(retry.succeeded, ["a", "b"], "lost replies must be safe to retry");
  assert.equal(retry.cleanupPending, false);
  assert.equal(batchResults.length, 1, "retry must not run redundant R2 cleanup");
}
{
  const { env, ctx, rows } = fixture();
  env.DB.batch = async () => { throw Error("D1 transaction failed"); };
  await assert.rejects(() => permanentlyDeleteNativeTrashBatch(env, "native:primary", ["a", "b"], ctx));
  assert.equal(rows.has("a"), true, "failed D1 transaction must not claim success");
}

const { readFileSync } = await import("node:fs");
const app = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
const list = readFileSync(new URL("../src/client/components/MailList.tsx", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/worker/api/mailActions.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
assert.match(worker, /permanentlyDeleteNativeTrashBatch\(env, provider.accountId, ids as string\[\], ctx\)/);
assert.match(route, /bulkMailAction\(request, env, ctx\)/);
assert.match(app, /setSelectedMailIds\(\[\]\);\s*setSelectionMode\(false\);\s*await loadMessages/);
assert.equal(app.includes("setSelectedMailIds(failed.map"), false);
assert.match(app, /AbortSignal.timeout\(20_000\)/);
assert.match(app, /current.filter\(id => listed.has\(id\)\)/);
assert.match(list, /All \$\{visible.length\} shown/);
assert.match(list, /folderTotalCount/);
console.log("PASS: Atomic, mailbox-scoped native Trash deletion, safe retries and reselection after batch");
