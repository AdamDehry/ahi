import { useEffect, useState } from "react";
import { actions, useAppState } from "../store";
import { fetchClips, saveClip, deleteClip } from "../lib/api";
import type { Clip } from "../lib/types";
import { IconCopy, IconTrash } from "../components/icons";
import { locale, useT, type Key } from "../i18n";

type ClipKind = "links" | "code" | "text";
const KIND_LABEL: Record<ClipKind, Key> = { links: "files.clipKind.link", code: "files.clipKind.code", text: "files.clipKind.text" };

function detectKind(text: string): ClipKind {
  if (/^https?:\/\/\S+$/i.test(text.trim())) return "links";
  if (/[{};`]|^\s{2,}|\$\s|npm |git |curl /m.test(text)) return "code";
  return "text";
}

function formatDate(ts: number | string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit" });
}

/** Clipboard (design 1·5): one save bar with auto-detected type, clip
 *  cards with a mono type chip; click card = copy. Real /ui/clips CRUD. */
export default function Clipboard() {
  const t = useT();
  const { toolFilter, clips } = useAppState();
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const load = () => fetchClips().then(actions.setClips);
  useEffect(() => {
    if (clips === null) load();
  }, [clips]);

  async function save() {
    const text = draft.trim();
    if (!text) return;
    if (await saveClip(text)) {
      setDraft("");
      load();
    }
  }

  async function copy(clip: Clip) {
    try {
      await navigator.clipboard.writeText(clip.text);
      setCopied(clip.id);
      setTimeout(() => setCopied((c) => (c === clip.id ? null : c)), 900);
    } catch {}
  }

  const visible = (clips ?? []).filter((c) => toolFilter === "all" || detectKind(c.text) === toolFilter);

  return (
    <div className="tool-page">
      <div className="save-bar">
        <input
          type="text"
          dir="auto"
          placeholder={t("files.clipPlaceholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        {draft.trim() && <span className="mono-label save-kind">{t("files.autoDetect", { kind: t(KIND_LABEL[detectKind(draft)]) })}</span>}
        <button className="btn-accent" onClick={save} disabled={!draft.trim()}>
          {t("common.save")}
        </button>
      </div>

      {clips === null ? (
        <div className="card-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="clip-card skeleton-card" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="tool-empty mono-label">{t("files.noClips")}</div>
      ) : (
        <div className="card-grid clips">
          {visible.map((clip) => {
            const kind = detectKind(clip.text);
            return (
              <article key={clip.id} className="clip-card" onClick={() => copy(clip)} title={t("files.clickToCopy")}>
                <div className="clip-head">
                  <span className="tool-chip">{copied === clip.id ? t("files.copiedCaps") : t(KIND_LABEL[kind])}</span>
                  <button
                    className="card-action"
                    aria-label={t("files.deleteClip")}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteClip(clip.id).then(load);
                    }}
                  >
                    <IconTrash />
                  </button>
                </div>
                <div className={`clip-text${kind === "code" ? " mono" : ""}`} dir={kind === "text" ? "auto" : "ltr"}>
                  {clip.text}
                </div>
                <div className="clip-foot">
                  <span className="mono-label">{formatDate(clip.created)}</span>
                  <IconCopy />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
