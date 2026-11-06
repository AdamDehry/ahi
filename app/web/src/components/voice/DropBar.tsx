import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drop something into the call without hanging up (part six):
 * paste or type a link or a note, attach / paste / drag an image. Send, keep
 * talking — "I just dropped you this link" — and it is one turn with his
 * words; say nothing and Michael answers it on its own after a beat.
 *
 * Works the same on desktop and phone: the attach button opens the phone's
 * photo picker or camera (`accept="image/*"`), paste works in both.
 */
export interface DropPayload {
  text: string;
  image: File | null;
}

export default function DropBar({
  onSend,
  busy,
  error,
}: {
  onSend: (drop: DropPayload) => void;
  busy: boolean;
  error: string | null;
}) {
  const [text, setText] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const stage = useCallback((file: File | null | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    setImage(file);
  }, []);

  useEffect(() => {
    if (!image) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  // A pasted screenshot anywhere on the call screen is staged here.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (!file) return;
      e.preventDefault();
      stage(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [stage]);

  const send = () => {
    const t = text.trim();
    if ((!t && !image) || busy) return;
    onSend({ text: t, image });
    setText("");
    setImage(null);
  };

  return (
    <form
      className="drop-bar"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        stage(Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/")));
      }}
    >
      {preview && (
        <div className="drop-chip">
          <img src={preview} alt="Image to drop into the call" />
          <button type="button" aria-label="Remove image" onClick={() => setImage(null)}>
            ✕
          </button>
        </div>
      )}
      <div className="drop-row">
        <button
          type="button"
          className="drop-attach"
          aria-label="Attach an image"
          onClick={() => fileRef.current?.click()}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path
              d="M13.5 7.5l-5.6 5.6a2 2 0 0 1-2.8-2.8l6.3-6.3a3.2 3.2 0 0 1 4.5 4.5l-6.6 6.6"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            stage(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <input
          className="drop-text"
          type="text"
          aria-label="Drop a link or a note into the call"
          placeholder="Paste a link or type a note"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="drop-send mono" disabled={busy || (!text.trim() && !image)}>
          {busy ? "…" : "SEND"}
        </button>
      </div>
      {error && <div className="drop-error mono">{error}</div>}
    </form>
  );
}
