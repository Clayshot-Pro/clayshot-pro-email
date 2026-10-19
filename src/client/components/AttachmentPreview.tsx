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
          <a className="attachment-preview-download" href={downloadUrl} download={attachment.filename}>
            <Icon name="paperclip" size={15} />
            <span>Download</span>
          </a>
        </header>

        <div className="attachment-preview-body">
          {image ? <img src={previewUrl} alt={attachment.filename} /> : null}
          {pdf ? <iframe title={attachment.filename} src={previewUrl} /> : null}
          {!image && !pdf ? (
            <div className="attachment-preview-unsupported">
              <span className="attachment-preview-file-icon"><Icon name="paperclip" size={26} /></span>
              <strong>{attachment.filename}</strong>
              <span>This file type does not have an in-app preview.</span>
              <a href={downloadUrl} download={attachment.filename}>Download file</a>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
