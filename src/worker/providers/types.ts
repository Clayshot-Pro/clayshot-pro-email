export type MailProviderKind = "native" | "gmail";
export type MailFolder = "inbox" | "junk" | "starred" | "sent" | "archive" | "trash";

export type ProviderMessage = {
  id: string;
  threadId: string;
  direction: "inbound" | "outbound";
  fromAddress: string;
  fromName: string | null;
  senderAvatarUrl?: string | null;
  toAddresses: string[];
  subject: string;
  preview: string;
  receivedAt: string;
  sentAt: string | null;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isDeleted: boolean;
  isJunk: boolean;
  hasAttachments: boolean;
  deliveryStatus: string | null;
  isDraft: false;
};

export type ProviderListOptions = {
  folder: MailFolder;
  search: string;
  limit: number;
};

export type ProviderMutation = Partial<{
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isDeleted: boolean;
  isJunk: boolean;
}>;

/** One conversation-wide change. */
export type ThreadMutation = Pick<ProviderMutation, "isDeleted" | "isArchived" | "isJunk">;

export type ProviderAttachment = {
  filename: string;
  type: string;
  content: ArrayBuffer;
};

export type ProviderSendInput = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  headers?: Record<string, string>;
  threadId?: string | null;
  attachments: ProviderAttachment[];
  idempotencyKey?: string;
};

export type ProviderSendResult = {
  providerMessageId: string | null;
  transport?: "cloudflare" | "resend";
};

export interface MailProvider {
  readonly kind: MailProviderKind;
  readonly accountId: string;
  readonly address: string;

  listMessages(options: ProviderListOptions): Promise<ProviderMessage[]>;
  getMessage(id: string): Promise<ProviderMessage | null>;
  patchMessage(id: string, mutation: ProviderMutation): Promise<boolean>;
  /** Delete/restore, archive/unarchive or junk/not-junk a whole conversation. */
  patchThread(id: string, mutation: ThreadMutation): Promise<boolean>;
  sendMessage(input: ProviderSendInput): Promise<ProviderSendResult>;
}
