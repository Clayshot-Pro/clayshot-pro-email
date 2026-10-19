interface EmailAddressInput {
  email: string;
  name?: string;
}

interface OutboundAttachmentInput {
  content: string | ArrayBuffer | ArrayBufferView;
  filename: string;
  type: string;
  disposition: "attachment" | "inline";
  contentId?: string;
}

interface OutboundEmailInput {
  from: EmailAddressInput | string;
  to: EmailAddressInput | EmailAddressInput[] | string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: EmailAddressInput | EmailAddressInput[] | string | string[];
  bcc?: EmailAddressInput | EmailAddressInput[] | string | string[];
  replyTo?: EmailAddressInput | string;
  attachments?: OutboundAttachmentInput[];
  headers?: Record<string, string>;
}

interface EmailSendResult {
  messageId: string;
}

interface EmailServiceBinding {
  send(message: OutboundEmailInput): Promise<EmailSendResult>;
}

interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  ASSETS: Fetcher;
  // Unrestricted send_email binding: the default Cloudflare sending path, no token needed.
  EMAIL?: EmailServiceBinding;
  // Optional Email Sending API (used instead of the binding when the token is set).
  // The account ID is filled automatically at build time from CLOUDFLARE_ACCOUNT_ID.
  CF_EMAIL_SENDING_ACCOUNT_ID?: string;
  // The Worker's own name (wrangler.jsonc "name"), for Email Routing and the Cloudflare API.
  LTM_WORKER_NAME?: string;
  // The running version; proves a Cloudflare API token belongs to this Worker's account.
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  // Worker secrets uploaded by scripts/secrets-push.mjs. Instance settings
  // (domains, branding, forwarding, limits) live in D1, not in Worker vars.
  CF_EMAIL_SENDING_TOKEN?: string;
  AUTH_SETUP_TOKEN?: string;
  RESEND_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PROVIDER_CREDENTIAL_KEY?: string;
}
