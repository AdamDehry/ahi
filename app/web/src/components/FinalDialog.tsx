import { useEffect } from "react";
import { createPortal } from "react-dom";

/** The FINAL dialog frame (eyebrow, title, close; body scrolls, foot stays), shared by the Vault and the
 *  Finances dialogs. Styles live in redesign/vault-final.css; no CSS import here so views stay testable in node. */
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
}

export function Modal({ title, onClose, children, eyebrow = "AHI · PRIVATE VAULT", variant }: { title: string; onClose: () => void; children: React.ReactNode; eyebrow?: string; variant?: string }) {
  useEscape(onClose);
  // FINAL vault-dialog frame: eyebrow + title + close; the body scrolls, the foot stays.
  return createPortal(
    <div className="modal-layer vault-dialog-layer">
      <div className="modal-scrim" onPointerDown={onClose} />
      <div className={`modal vault-dialog${variant ? ` ${variant}` : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="vault-dialog-head">
          <div>
            <span className="vault-dialog-eyebrow">{eyebrow}</span>
            <h3 className="card-title">{title}</h3>
          </div>
          <button type="button" className="vault-dialog-x" aria-label="Close dialog" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="vault-dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

