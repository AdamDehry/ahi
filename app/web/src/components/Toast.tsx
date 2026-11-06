import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { subscribeToast, toastState } from "../lib/toast";

/** The app's one-line confirmation ("Copied", "Saved"), mounted once. */
export default function ToastHost() {
  const toast = useSyncExternalStore(subscribeToast, toastState);
  if (!toast) return null;
  return createPortal(
    <div key={toast.id} className="app-toast" role="status" aria-live="polite">
      {toast.text}
    </div>,
    document.body,
  );
}
