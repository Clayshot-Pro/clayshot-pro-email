/**
 * Junk detection for native mailboxes (v3.10). Pure and dependency-free.
 *
 * Mail goes to Junk when an upstream filter already flagged it, when sender
 * authentication failed (DMARC, or SPF without a passing DKIM signature), or
 * when content signals add up to JUNK_SCORE. Content scoring is skipped for
 * authenticated senders the mailbox has written to. Junk is never deleted, so a false
 * positive is one "Not junk" away; each weight below is tuned so ordinary
 * newsletters, receipts and account notices stay under the threshold.
 */
export const JUNK_SCORE = 4;

export type HeaderSource = { get(name: string): string | null };

export type JunkInput = {
  subject: string;
  /** Header From address (falls back to the envelope sender). */
  sender: string;
  senderName?: string | null;
  replyTo?: string | null;
  text: string;
  html?: string | null;
  headers?: HeaderSource;
  /** The mailbox has sent mail to this sender before. */
  knownSender?: boolean;
  /**
   * Every Authentication-Results and ARC-Authentication-Results header, top
   * first (postal-mime `headers` order). When given, only the receiving
   * server's result is trusted (see trustedResult).
   */
  authenticationHeaders?: Array<{ key: string; value: string }>;
};

export type JunkVerdict = { junk: boolean; score: number; reasons: string[] };

const STRONG = /(?:lottery|you(?:'ve| have) (?:been selected|won)|claim your (?:prize|reward|refund)|unclaimed (?:funds|inheritance)|secret inheritance|next of kin|beneficiary of|million (?:dollars|usd|euros)|wire transfer immediately|western union|moneygram|send .{0,20}gift cards?|bitcoin wallet|crypto giveaway|free money|guaranteed (?:profit|returns|income)|verify your banking password|recover your account now)/i;
const ACCOUNT_THREAT = /(?:account|password|mailbox|payment|card).{0,40}(?:suspend|locked|lock|expir|deactivat|unusual|unauthori[sz]ed|verify|limited)/i;
const CALL_TO_ACT = /(?:click|log ?in|sign ?in|confirm|update|verify) (?:here|now|below|your|immediately|within)/i;
const IP_LINK = /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?:[:/]|\b)/i;
const SHORTENER = /https?:\/\/(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|cutt\.ly|rb\.gy|shorturl\.at)\//i;
const BRANDS = ["paypal", "apple", "icloud", "microsoft", "outlook", "office365", "amazon", "netflix", "google", "irs", "dhl", "fedex", "ups", "usps", "coinbase", "binance", "wellsfargo", "chase"];
const URGENT = /(?:urgent|immediately|final notice|act now|last chance|limited time|expires today|action required)/i;
const GENERIC_GREETING = /dear (?:customer|user|client|friend|beneficiary|account holder|member|valued)/i;

const domainOf = (address: string | null | undefined) => {
  const value = (address ?? "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  return at >= 0 ? value.slice(at + 1).replace(/>$/, "") : "";
};
/** example.co.uk and mail.example.co.uk share "example.co.uk"; good enough to compare origins. */
const baseDomain = (domain: string) => domain.split(".").slice(-2).join(".");

function upstreamFlag(headers: HeaderSource): boolean {
  return /^\s*yes\b/i.test(headers.get("x-spam-flag") ?? "")
    || /^\s*yes\b/i.test(headers.get("x-spam-status") ?? "")
    || /^\s*(?:yes|true|spam)\b/i.test(headers.get("x-spam") ?? "");
}

const authservId = (value: string) => value.replace(/^\s*i=\d+\s*;/i, "").split(";")[0].trim().toLowerCase();
const isCloudflare = (value: string) => /(?:^|\.)cloudflare\.(?:net|com)$/.test(authservId(value));

/**
 * The authentication result written by the server that received the mail.
 * Receiving servers add theirs above everything the sender wrote, so a
 * forged result can never sit above the real one. Prefer the topmost
 * Cloudflare result (plain, then ARC); otherwise the topmost result.
 */
export function trustedResult(headers: Array<{ key: string; value: string }>): string {
  const plain = headers.filter(header => header.key.toLowerCase() === "authentication-results").map(header => header.value);
  const arc = headers.filter(header => header.key.toLowerCase() === "arc-authentication-results").map(header => header.value);
  return plain.find(isCloudflare) ?? arc.find(isCloudflare) ?? plain[0] ?? "";
}

/** DKIM passed for the sender's own domain (or DMARC passed). */
function authenticatedSender(results: string, senderDomain: string): boolean {
  if (/\bdmarc=pass\b/i.test(results)) return true;
  const base = baseDomain(senderDomain);
  return Boolean(base) && [...results.matchAll(/\bdkim=pass\b[^;]{0,200}?header\.d=([a-z0-9.-]{1,253})/gi)]
    .some(match => baseDomain(match[1].toLowerCase()) === base);
}

function authenticationFailure(headers: HeaderSource, results: string): string | null {
  // Mailing lists and forwarders legitimately break SPF/DMARC alignment, but a
  // List-Id header alone (anyone can add one) only counts with a DKIM pass.
  if (headers.get("list-id") && /\bdkim=pass\b/i.test(results)) return null;
  if (/\bdmarc=fail\b/i.test(results)) return "DMARC failed";
  if (/\bspf=fail\b/i.test(results) && !/\bdkim=pass\b/i.test(results)) return "SPF failed without a valid DKIM signature";
  return null;
}

export function junkVerdict(input: JunkInput): JunkVerdict {
  const reasons: string[] = [];
  if (input.headers && upstreamFlag(input.headers)) reasons.push("Flagged as spam by an upstream filter");
  const results = input.authenticationHeaders
    ? trustedResult(input.authenticationHeaders)
    : input.headers?.get("authentication-results") ?? "";
  const auth = input.headers ? authenticationFailure(input.headers, results) : null;
  if (auth) reasons.push(auth);
  if (reasons.length) return { junk: true, score: JUNK_SCORE, reasons };
  // A From address is easy to forge: a contact skips content checks only
  // when the receiving server authenticated that sender.
  if (input.knownSender && authenticatedSender(results, domainOf(input.sender))) return { junk: false, score: 0, reasons };

  const subject = input.subject.slice(0, 500);
  const text = input.text.slice(0, 8000);
  const html = (input.html ?? "").slice(0, 200_000);
  const content = `${subject}\n${text}`;
  const senderDomain = domainOf(input.sender);
  const name = (input.senderName ?? "").toLowerCase();
  let score = 0;
  const add = (points: number, reason: string) => { score += points; reasons.push(reason); };

  if (STRONG.test(content)) add(3, "Scam wording");
  if (ACCOUNT_THREAT.test(content) && CALL_TO_ACT.test(content)) add(3, "Account threat with a call to act");
  if (IP_LINK.test(text) || IP_LINK.test(html)) add(3, "Link to a bare IP address");
  const nameAddress = name.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/)?.[0];
  const impersonated = BRANDS.find(brand => name.includes(brand) && !senderDomain.includes(brand));
  if ((nameAddress && baseDomain(domainOf(nameAddress)) !== baseDomain(senderDomain)) || impersonated) add(2, "Sender name impersonates another sender");
  if (/(?:bitcoin|crypto|investment|forex)/i.test(subject) && /(?:guaranteed|profit|instant|double|returns)/i.test(subject)) add(2, "Investment bait");
  const replyDomain = domainOf(input.replyTo);
  if (replyDomain && senderDomain && baseDomain(replyDomain) !== baseDomain(senderDomain)) add(1, "Replies go to another domain");
  const letters = subject.replace(/[^a-z]/gi, "");
  if (letters.length >= 12 && letters.replace(/[^A-Z]/g, "").length / letters.length >= 0.7) add(1, "Shouting subject");
  if (/(?:!!!|\$\$\$)/.test(subject)) add(1, "Excessive punctuation");
  if (URGENT.test(subject)) add(1, "Urgency");
  if (GENERIC_GREETING.test(text)) add(1, "Generic greeting");
  if (SHORTENER.test(text) || SHORTENER.test(html)) add(1, "Shortened links");
  return { junk: score >= JUNK_SCORE, score, reasons };
}

/** Content-only check (kept for callers without headers). */
export function suspectedJunk(subject: string, sender: string, preview: string): boolean {
  return junkVerdict({ subject, sender, text: preview }).junk;
}
