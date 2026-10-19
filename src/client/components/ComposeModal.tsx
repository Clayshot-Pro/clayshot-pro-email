import type { FormEvent } from "react";
import type { ComposeState, ConnectedAccount } from "../mailTypes";
import { Icon } from "./Icon";

type ComposeModalProps = {
  open: boolean;
  compose: ComposeState;
  files: File[];
  sending: boolean;
  sendError: string | null;
  draftStatus: "saving" | "saved" | "failed" | null;
  accounts: ConnectedAccount[];
  senderAccountId: string;
  onSenderAccountChange: (accountId: string) => void;
  onChange: (next: ComposeState) => void;
  onFilesChange: (files: File[]) => void;
  onClose: () => void;
  onDiscard: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

const fallbackAccount: ConnectedAccount = {
  id: "native:admin",
  provider: "native",
  emailAddress: "",
  displayName: "Admin mailbox",
  avatarUrl: null,
  status: "active",
  lastSyncedAt: null,
};

function senderLabel(account: ConnectedAccount) {
  const provider = account.provider === "native" ? "Custom" : "Gmail";
  const status = account.status === "active" ? "" : " — reconnect required";
  return `${account.emailAddress} (${provider})${status}`;
}

export function ComposeModal({
  open,
  compose,
  files,
  sending,
  sendError,
  draftStatus,
  accounts,
  senderAccountId,
  onSenderAccountChange,
  onChange,
  onFilesChange,
  onClose,
  onDiscard,
  onSubmit,
}: ComposeModalProps) {
  if (!open) return null;

  const mode = compose.replyToMessageId ? "Reply" : compose.forwardMessageId ? "Forward" : "New message";
  const senderLocked = Boolean(compose.replyToMessageId || compose.forwardMessageId);
  const senderOptions = accounts.length ? accounts : [fallbackAccount];
  const activeSenderCount = senderOptions.filter((account) => account.status === "active").length;
  const currentSender = senderOptions.find((account) => account.id === senderAccountId) ?? fallbackAccount;
  const canChooseSender = !senderLocked && (activeSenderCount > 1 || currentSender.status !== "active");
  const senderDisabled = currentSender.status !== "active";

  return (
    <div className="compose-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !sending) onClose(); }}>
      <form className="compose-modal" onSubmit={onSubmit}>
        <header className="compose-header">
          <div>
            <span className="eyebrow">{compose.replyToMessageId || compose.forwardMessageId ? "Conversation" : "Compose"}</span>
            <strong>{mode}</strong>
          </div>
          <div className="compose-header-actions">
            {compose.draftId ? (
              <button className="compose-discard" type="button" aria-label="Discard draft" title="Discard draft" disabled={sending} onClick={onDiscard}><Icon name="trash" size={15} /></button>
            ) : null}
            <button className="compose-close" type="button" aria-label="Close compose" disabled={sending} onClick={onClose}>×</button>
          </div>
        </header>

        <div className="compose-fields">
          <label title={senderLocked ? "Replies and forwards stay with the mailbox they were opened from." : undefined}>
            <span>From</span>
            <select
              aria-label="From address"
              value={currentSender.id}
              disabled={sending || !canChooseSender}
              onChange={(event) => onSenderAccountChange(event.target.value)}
              style={{ width: "100%", border: 0, outline: 0, background: "transparent", color: "var(--text)", fontSize: 12, fontFamily: "inherit" }}
            >
              {senderOptions.map((account) => (
                <option key={account.id} value={account.id} disabled={account.status !== "active"}>{senderLabel(account)}</option>
              ))}
            </select>
          </label>
          <label><span>To</span><input required autoFocus value={compose.to} onChange={(event) => onChange({ ...compose, to: event.target.value })} placeholder="name@example.com" /></label>
          <div className="compose-inline-fields">
            <label><span>Cc</span><input value={compose.cc} onChange={(event) => onChange({ ...compose, cc: event.target.value })} /></label>
            <label><span>Bcc</span><input value={compose.bcc} onChange={(event) => onChange({ ...compose, bcc: event.target.value })} /></label>
          </div>
          <label><span>Subject</span><input value={compose.subject} onChange={(event) => onChange({ ...compose, subject: event.target.value })} placeholder="What’s this about?" /></label>
        </div>

        <textarea required className="compose-body" aria-label="Message" value={compose.text} onChange={(event) => onChange({ ...compose, text: event.target.value })} placeholder="Write your message…" />

        {compose.forwardMessageId ? <div className="forward-attachment-note"><Icon name="paperclip" size={13} />Original attachments will be included when you send.</div> : null}

        {files.length > 0 ? (
          <div className="file-chips">
            {files.map((file) => <span key={`${file.name}-${file.lastModified}`}><Icon name="paperclip" size={13} />{file.name}</span>)}
          </div>
        ) : null}

        {sendError ? <p className="compose-send-error" role="alert">{sendError}</p> : null}
        <footer className="compose-footer">
          <label className="attach-control"><Icon name="paperclip" size={16} /><span>Attach</span><input type="file" multiple onChange={(event) => onFilesChange(Array.from(event.target.files ?? []))} /></label>
          <span className="compose-from">{draftStatus === "saving" ? "Saving draft…" : draftStatus === "saved" ? "Draft saved" : draftStatus === "failed" ? "Draft not saved" : currentSender.status === "active" ? `Sending as ${currentSender.emailAddress}` : "Reconnect this sender to send"}</span>
          <button className="send-control" type="submit" disabled={sending || senderDisabled}><Icon name="send" size={15} />{sending ? "Sending…" : "Send"}</button>
        </footer>
      </form>
    </div>
  );
}
