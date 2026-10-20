import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { messageUnsubscribeUrl } from "../../worker/email/unsubscribe";
import { buildSafeEmailDocument, remoteImageCount } from "../emailHtml";
import { setRemoteImagesMode, useRemoteImagesMode } from "../remoteImages";
import { applyNativeColors, classifyEmail, emailBaseStyles, fitEmailWidth, parseColor, type EmailMode, type EmailTheme } from "../emailTheme";
import type { MessageDetail } from "../mailTypes";
import { attachmentUrls, formatBytes, formatFullDate, oneLine, senderLabel } from "../mailUtils";
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
  return message.direction === "outbound" ? "You" : oneLine(senderLabel(message));
}

function messageSecondary(message: MessageDetail): string {
  return message.direction === "outbound"
    ? `to ${message.toAddresses.join(", ") || "Unknown recipient"}`
    : message.fromName ? message.fromAddress : `to ${message.toAddresses.join(", ") || "you"}`;
}

/** The theme behind the reader, read from the live page so every theme works. */
function readerTheme(shell: HTMLElement): EmailTheme {
  const style = getComputedStyle(shell);
  let background = "";
  for (let node: HTMLElement | null = shell; node && !background; node = node.parentElement) {
    const colour = parseColor(getComputedStyle(node).backgroundColor);
    if (colour && colour.a > 0.9) background = `rgb(${colour.r}, ${colour.g}, ${colour.b})`;
  }
  // Resolve the theme's link colour to rgb through a probe, whatever its token holds.
  const probe = document.createElement("span");
  probe.style.color = "var(--color-accent-text, var(--color-accent))";
  shell.appendChild(probe);
  const link = getComputedStyle(probe).color;
  probe.remove();
  return { text: style.color, link: link || style.color, background: background || "rgb(18, 18, 18)", font: style.fontFamily, scheme: style.colorScheme || "normal" };
}

/**
 * HTML email in a sandboxed frame. Ordinary mail is shown natively in the app
 * theme; designed mail keeps its own colours on a light card (emailTheme.ts).
 * The frame stays hidden until it is adapted, and its height follows the
 * content as the reader resizes or images load.
 */
function RichEmailBody({ html, remoteImages }: { html: string; remoteImages: boolean }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [mode, setMode] = useState<EmailMode | null>(null);
  // Native colours are written into the document, so a theme change re-renders it.
  const [themeVersion, setThemeVersion] = useState(0);
  const srcDoc = useMemo(() => buildSafeEmailDocument(html, { remoteImages }), [html, remoteImages]);

  useEffect(() => () => observerRef.current?.disconnect(), []);
  // Synchronous with the commit, so it always runs before the new document loads.
  useLayoutEffect(() => setMode(null), [srcDoc, themeVersion]);
  useEffect(() => {
    const root = document.documentElement;
    const signature = () => [root.getAttribute("data-theme"), root.getAttribute("data-text-size"), root.style.getPropertyValue("--user-accent")].join("|");
    let last = signature();
    // Appearance is re-applied often with the same values; only a real change reloads the email.
    const watcher = new MutationObserver(() => {
      const next = signature();
      if (next === last) return;
      last = next;
      setThemeVersion(version => version + 1);
    });
    watcher.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-text-size", "style"] });
    return () => watcher.disconnect();
  }, []);

  const onLoad = () => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    const shell = shellRef.current;
    if (!frame || !doc?.body || !shell) return;
    const theme = readerTheme(shell);
    const next = classifyEmail(doc);
    const style = doc.createElement("style");
    style.textContent = emailBaseStyles(next, theme);
    doc.head.appendChild(style);
    if (next === "native") applyNativeColors(doc, theme);
    const fit = () => {
      fitEmailWidth(doc);
      const height = Math.ceil(doc.documentElement.getBoundingClientRect().height);
      frame.style.height = `${Math.min(Math.max(height, 24) + 2, 20000)}px`;
    };
    fit();
    observerRef.current?.disconnect();
    const Observer = (doc.defaultView as (Window & typeof globalThis) | null)?.ResizeObserver ?? ResizeObserver;
    observerRef.current = new Observer(fit);
    observerRef.current.observe(doc.documentElement);
    setMode(next);
  };

  return (
    <div ref={shellRef} className={`rich-email-shell${mode ? ` is-${mode}` : ""}`}>
      <iframe
        key={themeVersion}
        ref={frameRef}
        className="rich-email-frame"
        title="Email content"
        srcDoc={srcDoc}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        style={mode ? undefined : { visibility: "hidden" }}
        onLoad={onLoad}
      />
    </div>
  );
}

export function MessageReader({ message, thread, folderLabel, loading = false, accountId, onBack, onReply, onForward, onPatch, canPermanentlyDelete, onPermanentDelete, onBlockSender }: MessageReaderProps) {
  const [previewAttachment, setPreviewAttachment] = useState<(MessageDetail["attachments"][number] & { messageId: string }) | null>(null);
  const [unsubscribeOpen, setUnsubscribeOpen] = useState(false);
  const imagesMode = useRemoteImagesMode();
  // "Show images" for one message when remote images are set to ask first.
  const [imagesShownFor, setImagesShownFor] = useState<Set<string>>(() => new Set());
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
              {item.bodyHtml && imagesMode === "ask" && !imagesShownFor.has(item.id) && remoteImageCount(item.bodyHtml) > 0 ? (
                <div className="remote-images-banner" role="status">
                  <span>Images in this email are hidden.</span>
                  <button type="button" onClick={() => setImagesShownFor(current => new Set(current).add(item.id))}>Show images</button>
                  <button type="button" className="remote-images-always" onClick={() => setRemoteImagesMode("show")}>Always show</button>
                </div>
              ) : null}
              {item.bodyHtml ? <RichEmailBody html={item.bodyHtml} remoteImages={imagesMode === "show" || imagesShownFor.has(item.id)}/> : <pre>{item.bodyText || "(No readable text content)"}</pre>}
              {item.bodyHtmlAvailable ? (
                <div className="security-note"><Icon name="lock" size={14}/><span>Rich email displayed safely. Images load privately through this app, so senders never see your address.</span></div>
              ) : null}
            </div>

            {item.attachments.length > 0 ? (
              <section className="reader-attachments" aria-label="Attachments">
                <div className="attachment-heading-row">
                  <h3>{item.attachments.length} attachment{item.attachments.length === 1 ? "" : "s"}</h3>
                </div>
                <div className="attachment-grid">
                  {item.attachments.map((attachment) => {
                    const previewHref = attachmentUrls(accountId, item.id, attachment).preview;
                    const isImage = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(attachment.contentType);
                    return (
                      <button
                        key={attachment.id}
                        className={`attachment-card ${isImage ? "image-attachment" : ""}`}
                        type="button"
                        onClick={() => setPreviewAttachment({ ...attachment, messageId: item.id })}
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
        {message.isJunk ? (
          <button type="button" onClick={() => onPatch({ isJunk: false }, true)}><Icon name="inbox" size={16}/><span className="reader-action-label">Not junk</span></button>
        ) : !message.isDeleted ? (
          <button type="button" onClick={() => onPatch({ isArchived: !message.isArchived }, true)}><Icon name="archive" size={16}/><span className="reader-action-label">{message.isArchived ? "Unarchive" : "Archive"}</span></button>
        ) : null}
        {accountId.startsWith("native:") && message.direction === "inbound" && !message.isDeleted && !message.isJunk ? (
          <button type="button" onClick={() => onPatch({ isJunk: true }, true)}><Icon name="junk" size={16}/><span className="reader-action-label">Junk</span></button>
        ) : null}
        <button className="unsubscribe-action" type="button" aria-label="Unsubscribe" onClick={() => setUnsubscribeOpen(true)}><Icon name="mail" size={16}/><span className="reader-action-label"><span className="label-long">Unsubscribe</span><span className="label-short">Unsub</span></span></button>
        {!message.isDeleted ? (
          <button className="destructive" type="button" onClick={() => onPatch({ isDeleted: true }, true)}><Icon name="trash" size={16}/><span className="reader-action-label">Delete</span></button>
        ) : (
          <button type="button" onClick={() => onPatch({ isDeleted: false }, true)}><Icon name="inbox" size={16}/><span className="reader-action-label">Restore</span></button>
        )}
        {message.isDeleted && canPermanentlyDelete ? (
          <button className="destructive delete-forever-action" type="button" aria-label="Delete forever" onClick={onPermanentDelete}><Icon name="trash" size={16}/><span className="reader-action-label"><span className="label-long">Delete forever</span><span className="label-short">Del forever</span></span></button>
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
