import { useEffect, useRef } from "react";

type Props = {
  count: number;
  kind: "single" | "bulk" | "draft";
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteConfirmationDialog({ count, kind, onCancel, onConfirm }: Props) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelButton.current?.focus();
  }, []);

  const isDraft = kind === "draft";
  const subject = isDraft ? (count === 1 ? "draft" : "drafts") : (count === 1 ? "message" : "messages");
  const title = isDraft ? "Delete drafts permanently?" : "Permanently delete mail?";
  return (
    <div
      className="delete-confirm-backdrop"
      onMouseDown={(event) => { if (event.currentTarget === event.target) onCancel(); }}
    >
      <section
        className="delete-confirm-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-confirm-title"
        aria-describedby="delete-confirm-description"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
          if (event.key === "Tab") {
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
            if (!buttons.length) return;
            if (event.shiftKey && document.activeElement === buttons[0]) {
              event.preventDefault();
              buttons[buttons.length - 1]?.focus();
            } else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) {
              event.preventDefault();
              buttons[0]?.focus();
            }
          }
        }}
      >
        <h3 id="delete-confirm-title">{title}</h3>
        <p id="delete-confirm-description">
          {count === 1 ? "This" : `These ${count}`} {subject} will be deleted from this mailbox permanently.
          This cannot be undone.
        </p>
        <div className="delete-confirm-actions">
          <button ref={cancelButton} type="button" onClick={onCancel}>Cancel</button>
          <button className="delete-confirm-danger" type="button" onClick={onConfirm}>
            {isDraft ? "Delete drafts" : "Delete permanently"}
          </button>
        </div>
      </section>
    </div>
  );
}
