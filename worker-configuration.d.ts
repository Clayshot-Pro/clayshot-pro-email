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
  EMAIL: EmailServiceBinding;
  EMAIL_MULTI: EmailServiceBinding;
  // Plain vars rendered from .env by scripts/config-render.mjs (see config/schema.mjs).
  APP_ORIGIN: string;
  PRIMARY_ADDRESS: string;
  ADMIN_ADDRESS: string;
  BRAND_NAME?: string;
  BRAND_SHORT_NAME?: string;
  OWNER_DISPLAY_NAME?: string;
  PRIMARY_DISPLAY_NAME?: string;
  MAIL_DOMAINS?: string;
  BRANDING_SOURCE?: string;
  MAX_MAILBOXES?: string;
  FORWARD_TO?: string;
  MULTI_SENDER_APPROVED?: string;
  MAILBOX_PURGE_ENABLED?: string;
  // Worker secrets uploaded by scripts/secrets-push.mjs.
  AUTH_SETUP_TOKEN?: string;
  RESEND_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PROVIDER_CREDENTIAL_KEY?: string;
}
