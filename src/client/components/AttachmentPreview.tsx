import { useEffect } from "react";
import { attachmentUrls, formatBytes } from "../mailUtils";
import { Icon } from "./Icon";

type Attachment = {
  id: string;
  partId?: string;
  /** The message the attachment belongs to. */
  messageId: string;
  filename: string;
  contentType: string;
  size: number;
};

type AttachmentPreviewProps = {
  attachment: Attachment | null;
  onClose: () => void;
  accountId: string;
};

function canPreviewImage(contentType: string): boolean {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(contentType);
}

export function AttachmentPreview({ attachment, accountId, onClose }: AttachmentPreviewProps) {
  useEffect(() => {
    if (!attachment) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [attachment, onClose]);

  if (!attachment) return null;

  const { preview: previewUrl, download: downloadUrl } = attachmentUrls(accountId, attachment.messageId, attachment);
  const image = canPreviewImage(attachment.contentType);
  const pdf = attachment.contentType === "application/pdf";

  // Files open outside the app (a new tab, or the system viewer with its own
  // Done button in an installed app) instead of replacing the app: in a
  // Home Screen app a plain link would leave no way back. The server only
  // serves images and PDFs inline, and every response is sandboxed.
  return (
    <div className="attachment-preview-backdrop" role="dialog" aria-modal="true" aria-label={`Preview ${attachment.filename}`}>
      <div className="attachment-preview-shell">
        <header className="attachment-preview-header">
          <button className="attachment-preview-back" type="button" onClick={onClose}>
            <Icon name="back" size={18} />
            <span>Back to email</span>
          </button>
          <div className="attachment-preview-title">
            <strong>{attachment.filename}</strong>
            <span>{formatBytes(attachment.size)}</span>
          </div>
          <div className="attachment-preview-actions">
            {image || pdf ? (
              <a className="attachment-preview-open" href={previewUrl} target="_blank" rel="noopener noreferrer" aria-label="Open in a new window">
                <Icon name="external" size={15} />
                <span>Open</span>
              </a>
            ) : null}
            <a className="attachment-preview-download" href={downloadUrl} download={attachment.filename} target="_blank" rel="noopener noreferrer" aria-label="Download">
              <Icon name="download" size={15} />
              <span>Download</span>
            </a>
          </div>
        </header>

        <div className="attachment-preview-body" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
          {image ? <img src={previewUrl} alt={attachment.filename} /> : null}
          {pdf ? <iframe title={attachment.filename} src={previewUrl} /> : null}
          {!image && !pdf ? (
            <div className="attachment-preview-unsupported">
              <span className="attachment-preview-file-icon"><Icon name="paperclip" size={26} /></span>
              <strong>{attachment.filename}</strong>
              <span>This file type does not have an in-app preview.</span>
              <a href={downloadUrl} download={attachment.filename} target="_blank" rel="noopener noreferrer">Download file</a>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
