/**
 * One app-wide confirmation line ("Copied", "Saved"). Lives outside React so
 * an action whose bubble Virtuoso has already unmounted can still report.
 */
export type ToastState = { id: number; text: string } | null;

let current: ToastState = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function showToast(text: string, ms = 1600): void {
  current = { id: ++seq, text };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    timer = null;
    emit();
  }, ms);
  emit();
}

export function subscribeToast(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function toastState(): ToastState {
  return current;
}
