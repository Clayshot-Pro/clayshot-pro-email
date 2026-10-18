import { useEffect, useMemo, useRef, useState } from "react";
import { messageUnsubscribeUrl } from "../../worker/email/unsubscribe";
import { buildSafeEmailDocument } from "../emailHtml";
import type { MessageDetail } from "../mailTypes";
import { formatBytes, formatFullDate, senderLabel } from "../mailUtils";
import { AttachmentPreview } from "./AttachmentPreview";
import { Icon } from "./Icon";
import { SenderAvatar } from "./SenderAvatar";

type MessageReaderProps = {
  message: MessageDetail | null;
  thread: MessageDetail[];
  folderLabel: string;
  loading?: boolean;
  onBack: () => void;
  accountId: string;
  onReply: () => void;
  onForward: () => void;
  onPatch: (patch: Record<string, boolean>, closeAfter?: boolean) => void;
  canPermanentlyDelete: boolean;
  onPermanentDelete: () => void;
  /** Custom mailboxes: block the sender (future mail goes to Junk). */
  onBlockSender?: (address: string) => void;
};

function messageSender(message: MessageDetail): string {
  return message.direction === "outbound" ? "You" : senderLabel(message);
}

function messageSecondary(message: MessageDetail): string {
  return message.direction === "outbound"
    ? `to ${message.toAddresses.join(", ") || "Unknown recipient"}`
    : message.fromName ? message.fromAddress : `to ${message.toAddresses.join(", ") || "you"}`;
}

function RichEmailBody({ html }: { html: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const srcDoc = useMemo(() => buildSafeEmailDocument(html), [html]);

  const resizeFrame = () => {
    const frame = frameRef.current;
    const document = frame?.contentDocument;
    if (!frame || !document) return;
    requestAnimationFrame(() => {
      const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, 100);
      frame.style.height = `${Math.min(height + 4, 12000)}px`;
    });
  };

  return (
    <div className="rich-email-shell">
      <iframe
        ref={frameRef}
        className="rich-email-frame"
        title="Email content"
        srcDoc={srcDoc}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        onLoad={resizeFrame}
      />
    </div>
  );
}

export function MessageReader({ message, thread, folderLabel, loading = false, accountId, onBack, onReply, onForward, onPatch, canPermanentlyDelete, onPermanentDelete, onBlockSender }: MessageReaderProps) {
  const [previewAttachment, setPreviewAttachment] = useState<MessageDetail["attachments"][number] | null>(null);
  const [unsubscribeOpen, setUnsubscribeOpen] = useState(false);
  const unsubscribeUrl = useMemo(
    () => message?.unsubscribeUrl || messageUnsubscribeUrl(message?.bodyHtml, message?.bodyText),
    [message?.unsubscribeUrl, message?.bodyHtml, message?.bodyText],
  );

  useEffect(() => {
    setUnsubscribeOpen(false);
  }, [message?.id, accountId]);

  useEffect(() => {
    if (!unsubscribeOpen) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUnsubscribeOpen(false);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [unsubscribeOpen]);

  if (loading && !message) {
    return (
      <section className="reader-pane reader-empty">
        <div className="reader-empty-card">
          <div className="reader-empty-icon"><Icon name="mail" size={24}/></div>
          <strong>Opening message…</strong>
          <span>Loading the conversation.</span>
        </div>
      </section>
    );
  }

  if (!message) {
    return (
      <section className="reader-pane reader-empty">
        <div className="reader-empty-card">
          <div className="reader-empty-icon"><Icon name="inbox" size={24}/></div>
          <strong>Select a message</strong>
          <span>Choose an email from the list to read it here.</span>
        </div>
      </section>
    );
  }

  const conversation = thread.length > 0 ? thread : [message];

  return (
    <section className="reader-pane">
      <header className="reader-toolbar">
        <button className="reader-back" type="button" onClick={onBack}><Icon name="back" size={18}/><span>{folderLabel}</span></button>
        <div className="reader-title-block">
          <h2>{message.subject || "(no subject)"}</h2>
          <span>{conversation.length > 1 ? `${conversation.length} messages in this conversation` : message.direction === "inbound" ? "Received message" : "Sent message"}</span>
        </div>
        <div className="reader-actions">
          <button className={message.isStarred ? "active-star" : ""} type="button" onClick={() => onPatch({ isStarred: !message.isStarred })} aria-label={message.isStarred ? "Unstar message" : "Star message"}><Icon name="star" size={16}/><span>{message.isStarred ? "Unstar" : "Star"}</span></button>
          {message.isJunk ? (
            <button className="mobile-reader-action junk-action" type="button" onClick={() => onPatch({ isJunk: false }, true)} aria-label="Mark as not junk"><Icon name="inbox" size={17}/><span>Not junk</span></button>
          ) : !message.isDeleted ? (
            <button className="mobile-reader-action" type="button" onClick={() => onPatch({ isArchived: !message.isArchived }, true)} aria-label={message.isArchived ? "Unarchive message" : "Archive message"}><Icon name="archive" size={17}/><span>{message.isArchived ? "Unarchive" : "Archive"}</span></button>
          ) : null}
          {accountId.startsWith("native:") && message.direction === "inbound" && !message.isDeleted && !message.isJunk ? (
            <button className="mobile-reader-action" type="button" onClick={() => onPatch({ isJunk: true }, true)} aria-label="Mark as junk"><Icon name="junk" size={17}/><span>Junk</span></button>
          ) : null}
          <button className="mobile-reader-action unsubscribe-mobile-action" type="button" onClick={() => setUnsubscribeOpen(true)} aria-label="Unsubscribe options" title="Unsubscribe options">
            <Icon name="mail" size={17}/><span>Unsubscribe</span>
          </button>
          <button className="mobile-reader-action" type="button" onClick={onReply} aria-label="Reply to message"><Icon name="reply" size={17}/><span>Reply</span></button>
          {!message.isDeleted ? (
            <button className="mobile-reader-action destructive" type="button" onClick={() => onPatch({ isDeleted: true }, true)} aria-label="Delete message"><Icon name="trash" size={17}/><span>Delete</span></button>
          ) : (
            <button className="mobile-reader-action" type="button" onClick={() => onPatch({ isDeleted: false }, true)} aria-label="Restore message"><Icon name="inbox" size={17}/><span>Restore</span></button>
              
          )}
          {message.isDeleted && canPermanentlyDelete ? (
            <button className="mobile-reader-action destructive" type="button" onClick={onPermanentDelete} aria-label="Permanently delete message"><Icon name="trash" size={17}/><span>Delete forever</span></button>
          ) : null}
        </div>
      </header>

      <article className="reader-scroll conversation-thread">
        {conversation.map((item) => (
          <section key={item.id} className={`conversation-message ${item.id === message.id ? "conversation-current" : ""}`}>
            <div className="message-heading">
              <div className="message-heading-meta">
                <SenderAvatar message={item}/>
                <div>
                  <strong>{messageSender(item)}</strong>
                  <span>{messageSecondary(item)}</span>
                </div>
                <time>{formatFullDate(item.sentAt || item.receivedAt)}</time>
              </div>
            </div>

            {item.deliveryStatus === "failed" ? <div className="delivery-error">Delivery failed: {item.deliveryError}</div> : null}
            {item.deliveryStatus === "bounced" ? <div className="delivery-error">The recipient's server rejected this message (bounced).</div> : null}
            {item.deliveryStatus === "complained" ? <div className="delivery-error">The recipient marked this message as spam. Further mail to them is blocked.</div> : null}
            {item.direction === "outbound" && (item.deliveryStatus === "delivered" || item.deliveryStatus === "delayed") ? (
              <div className="delivery-note">{item.deliveryStatus === "delivered" ? "Delivered to the recipient's server." : "Delivery is delayed; the provider is still retrying."}</div>
            ) : null}

            <div className="message-content">
              {item.bodyHtml ? <RichEmailBody html={item.bodyHtml}/> : <pre>{item.bodyText || "(No readable text content)"}</pre>}
              {item.bodyHtmlAvailable ? (
                <div className="security-note"><Icon name="lock" size={14}/><span>Rich email displayed safely. Links work; remote tracking images stay blocked.</span></div>
              ) : null}
            </div>

            {item.attachments.length > 0 ? (
              <section className="reader-attachments" aria-label="Attachments">
                <div className="attachment-heading-row">
                  <h3>{item.attachments.length} attachment{item.attachments.length === 1 ? "" : "s"}</h3>
                </div>
                <div className="attachment-grid">
                  {item.attachments.map((attachment) => {
                    const previewHref = `/api/attachment-previews/${encodeURIComponent(attachment.id)}?accountId=${encodeURIComponent(accountId)}`;
                    const isImage = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(attachment.contentType);
                    return (
                      <button
                        key={attachment.id}
                        className={`attachment-card ${isImage ? "image-attachment" : ""}`}
                        type="button"
                        onClick={() => setPreviewAttachment(attachment)}
                      >
                        {isImage ? <img src={previewHref} alt="" loading="lazy"/> : <span className="attachment-card-icon"><Icon name="paperclip" size={17}/></span>}
                        <span className="attachment-card-copy"><strong>{attachment.filename}</strong><small>{formatBytes(attachment.size)}</small></span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}
          </section>
        ))}
      </article>

      <footer className="reader-reply-bar">
        <button className="reply-primary" type="button" onClick={onReply}><Icon name="reply" size={17}/><span className="reader-action-label">Reply</span></button>
        <button type="button" onClick={onForward}><Icon name="forward" size={16}/><span className="reader-action-label">Forward</span></button>
        <button className="unsubscribe-action" type="button" onClick={() => setUnsubscribeOpen(true)}><Icon name="mail" size={16}/><span className="reader-action-label">Unsubscribe</span></button>
        {message.isJunk ? (
          <button type="button" onClick={() => onPatch({ isJunk: false }, true)}><Icon name="inbox" size={16}/><span className="reader-action-label">Not junk</span></button>
        ) : !message.isDeleted ? (
          <button type="button" onClick={() => onPatch({ isArchived: !message.isArchived }, true)}><Icon name="archive" size={16}/><span className="reader-action-label">{message.isArchived ? "Unarchive" : "Archive"}</span></button>
        ) : null}
        {accountId.startsWith("native:") && message.direction === "inbound" && !message.isDeleted && !message.isJunk ? (
          <button type="button" onClick={() => onPatch({ isJunk: true }, true)}><Icon name="junk" size={16}/><span className="reader-action-label">Junk</span></button>
        ) : null}
        {onBlockSender && message.direction === "inbound" ? (
          <button className="reader-block-action" type="button" onClick={() => onBlockSender(message.fromAddress)} title={`Block ${message.fromAddress}`}><Icon name="lock" size={16}/><span className="reader-action-label">Block</span></button>
        ) : null}
        {!message.isDeleted ? (
          <button className="destructive" type="button" onClick={() => onPatch({ isDeleted: true }, true)}><Icon name="trash" size={16}/><span className="reader-action-label">Delete</span></button>
        ) : (
          <button type="button" onClick={() => onPatch({ isDeleted: false }, true)}><Icon name="inbox" size={16}/><span className="reader-action-label">Restore</span></button>
        )}
        {message.isDeleted && canPermanentlyDelete ? (
          <button className="destructive" type="button" onClick={onPermanentDelete}><Icon name="trash" size={16}/><span className="reader-action-label">Delete forever</span></button>
        ) : null}
      </footer>

      {unsubscribeOpen ? (
        <div
          className="unsubscribe-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setUnsubscribeOpen(false);
          }}
        >
          <section role="dialog" aria-modal="true" aria-labelledby="unsubscribe-dialog-heading" className="unsubscribe-dialog">
            <header className="unsubscribe-dialog-header">
              <h3 id="unsubscribe-dialog-heading">Unsubscribe</h3>
              <button type="button" aria-label="Close unsubscribe options" onClick={() => setUnsubscribeOpen(false)}>✕</button>
            </header>
            {message.direction === "outbound" ? (
              <p>This is a sent email. Unsubscribing applies to mailing lists that send you email, not messages you sent.</p>
            ) : unsubscribeUrl ? (
              <>
                <p>{message.unsubscribeUrl
                  ? "This sender included an unsubscribe destination in the email headers."
                  : "This email does not include a standard unsubscribe header, but it contains a possible unsubscribe link."}</p>
                <p>Opening the link does not confirm that you have unsubscribed. Review the destination and complete any confirmation steps on the sender's site or in your mail app.</p>
                <div className="unsubscribe-dialog-actions">
                  <button type="button" onClick={() => setUnsubscribeOpen(false)}>Cancel</button>
                  <a href={unsubscribeUrl} target={unsubscribeUrl.startsWith("https:") ? "_blank" : undefined} rel="noopener noreferrer" onClick={() => setUnsubscribeOpen(false)}>
                    {unsubscribeUrl.startsWith("mailto:") ? "Open unsubscribe email" : "Open unsubscribe link"}
                  </a>
                </div>
              </>
            ) : (
              <p>This email has no supported unsubscribe instructions in its headers or message body. You can review the message for manual instructions or use Junk to manage unwanted mail. We cannot unsubscribe you without a sender-provided method.</p>
            )}
            {onBlockSender && message.direction === "inbound" ? (
              <>
                <p>Or block <strong>{message.fromAddress}</strong>: their mail to this mailbox goes straight to Junk.</p>
                <div className="unsubscribe-dialog-actions">
                  <button type="button" onClick={() => { setUnsubscribeOpen(false); onBlockSender(message.fromAddress); }}>Block sender</button>
                </div>
              </>
            ) : null}
            {!unsubscribeUrl || message.direction === "outbound" ? (
              <div className="unsubscribe-dialog-actions"><button type="button" onClick={() => setUnsubscribeOpen(false)}>Close</button></div>
            ) : null}
          </section>
        </div>
      ) : null}

      <AttachmentPreview attachment={previewAttachment} accountId={accountId} onClose={() => setPreviewAttachment(null)}/>
    </section>
  );
}
