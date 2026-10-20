import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const reader = readFileSync(new URL("../src/client/components/MessageReader.tsx", import.meta.url), "utf8");
// v3.27: one Unsubscribe button, in the footer action bar (the bottom bar on phones).
const buttons = [...reader.matchAll(/<button[^>]+onClick=\{\(\) => setUnsubscribeOpen\(true\)\}/g)];
assert.equal(buttons.length, 1, "Unsubscribe lives once, in the footer action bar");
assert.match(buttons[0][0], /className="unsubscribe-action"/);
const styles = readFileSync(new URL("../src/client/ui-overrides.css", import.meta.url), "utf8");
assert.match(styles, /\.app-shell\.message-open \.reader-reply-bar \.unsubscribe-action \{\s*display: inline-flex;/, "Unsubscribe stays visible in the phone action bar");
assert.doesNotMatch(reader, /message\.direction === "inbound" && message\.unsubscribeUrl/, "Missing headers must not hide unsubscribe");
assert.match(reader, /messageUnsubscribeUrl\(message\?\.bodyHtml, message\?\.bodyText\)/);
assert.match(reader, /role="dialog" aria-modal="true"/);
assert.match(reader, /message\.direction === "outbound" \? \(/);
assert.match(reader, /no supported unsubscribe instructions/, "Message without sender-supported method needs accurate feedback");
assert.match(reader, /Opening the link does not confirm/, "Opening a link is not proof of successful unsubscribe");
assert.match(reader, /rel="noopener noreferrer"/);
assert.doesNotMatch(reader, /fetch\(.*unsubscribe/i, "No unsubscribe URL should be automatically requested");
console.log("PASS: unsubscribe controls are unconditional across all mail folders and message types");
