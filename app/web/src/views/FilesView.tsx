import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { actions, useAppState } from "../store";
import { fetchFiles, uploadFile, deleteFile } from "../lib/api";
import { displayFileName, fileCategory, FILE_DRAG_TYPE } from "../components/Sidebar";
import FileThumb, { fileExt, isImage, isPdf } from "../components/FileThumb";
import type { FileEntry } from "../lib/types";
import { IconDownload, IconTrash, IconFiles, IconGrid, IconHamburger } from "../components/icons";

type ViewMode = "list" | "grid";
type TileSize = "sm" | "md" | "lg";
const VIEW_KEY = "ahi-files-view-v2";

function loadPrefs(): { mode: ViewMode; size: TileSize } {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}");
    return {
      mode: parsed.mode === "list" ? "list" : "grid",
      size: parsed.size === "sm" || parsed.size === "lg" ? parsed.size : "md",
    };
  } catch {
    return { mode: "grid", size: "md" };
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number | string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], { month: "short", day: "numeric" }).toUpperCase();
}

function fileUrl(name: string): string {
  return `/ui/files/${encodeURIComponent(name)}`;
}

/** Click-to-open preview (DocumentsTab pattern): full-size image / PDF
 *  centered in a modal; Esc or click-outside returns to the grid. */
function PreviewModal({ file, onClose }: { file: FileEntry; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const name = displayFileName(file.name);
  return createPortal(
    <div className="modal-layer">
      <div className="modal-scrim" onPointerDown={onClose} />
      <div className="preview-modal" role="dialog" aria-label={name}>
        <header className="preview-head">
          <span className="preview-name">{name}</span>
          <span className="mono-label">{formatSize(file.size)}</span>
          <a className="card-action" href={fileUrl(file.name)} download aria-label="Download">
            <IconDownload />
          </a>
        </header>
        <div className="preview-body">
          {isImage(file.name) ? (
            <img src={fileUrl(file.name)} alt={name} />
          ) : isPdf(file.name) ? (
            <iframe src={fileUrl(file.name)} title={name} />
          ) : (
            <div className="preview-fallback">
              <IconFiles />
              <span className="tool-chip">{fileExt(name)}</span>
              <span className="mono-label">NO INLINE PREVIEW — DOWNLOAD TO OPEN</span>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Files (3d2 redo — mirrors the business DocumentsTab): List ↔ Grid toggle +
 * S/M/L size (grid), both persisted; uniform rounded tiles with the
 * preview CONTAINED in a fixed aspect-square box (object-fit: cover —
 * never the raw image); click → modal; clean display names + type
 * badges (category never bleeds into the name).
 */
export default function FilesView() {
  const { filesList, toolFilter } = useAppState();
  const [prefs, setPrefs] = useState(loadPrefs);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = () => fetchFiles().then(actions.setFiles);
  useEffect(() => {
    if (filesList === null) reload();
  }, [filesList]);

  function savePrefs(next: Partial<{ mode: ViewMode; size: TileSize }>) {
    setPrefs((p) => {
      const merged = { ...p, ...next };
      localStorage.setItem(VIEW_KEY, JSON.stringify(merged));
      return merged;
    });
  }

  const targetCategory = toolFilter !== "all" && toolFilter !== "uncategorized" ? toolFilter : "general";

  async function handleFiles(list: FileList | null) {
    if (!list?.length) return;
    const names = Array.from(list).map((f) => f.name);
    setUploading((u) => [...u, ...names]);
    for (const f of Array.from(list)) {
      const result = await uploadFile(f, targetCategory);
      if (!result.ok && result.error) alert(`${f.name}: ${result.error}`);
      setUploading((u) => u.filter((n) => n !== f.name));
      reload();
    }
  }

  const visible = (filesList ?? []).filter((f) => toolFilter === "all" || fileCategory(f.name) === toolFilter);

  const dragProps = (f: FileEntry) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(FILE_DRAG_TYPE, f.name);
      e.dataTransfer.effectAllowed = "move";
    },
  });

  const actionButtons = (f: FileEntry) => (
    <div className="file-actions">
      <a
        className="card-action"
        href={fileUrl(f.name)}
        download
        aria-label="Download"
        onClick={(e) => e.stopPropagation()}
      >
        <IconDownload />
      </a>
      <button
        className="card-action"
        aria-label="Delete"
        onClick={(e) => {
          e.stopPropagation();
          if (confirm(`Delete "${displayFileName(f.name)}"?`)) deleteFile(f.name).then(reload);
        }}
      >
        <IconTrash />
      </button>
    </div>
  );

  return (
    <div
      className="tool-page files-page"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }
      }}
    >
      <div
        className={`drop-strip slim${dragOver ? " over" : ""}`}
        onClick={() => inputRef.current?.click()}
      >
        <span className="mono-label">
          {uploading.length
            ? `UPLOADING ${uploading.length}…`
            : `DROP FILES OR CLICK TO UPLOAD → ${targetCategory.toUpperCase()}`}
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {/* Compact right-aligned view controls (3d2#1) — List↔Grid, then
          S/M/L when in grid mode. */}
      <div className="files-controls">
        <div className="segmented view-toggle" role="radiogroup" aria-label="Layout">
          <button
            role="radio"
            aria-checked={prefs.mode === "list"}
            className={`segment icon${prefs.mode === "list" ? " active" : ""}`}
            title="List"
            onClick={() => savePrefs({ mode: "list" })}
          >
            <IconHamburger />
          </button>
          <button
            role="radio"
            aria-checked={prefs.mode === "grid"}
            className={`segment icon${prefs.mode === "grid" ? " active" : ""}`}
            title="Grid"
            onClick={() => savePrefs({ mode: "grid" })}
          >
            <IconGrid />
          </button>
        </div>
        {prefs.mode === "grid" && (
          <div className="segmented view-toggle" role="radiogroup" aria-label="Tile size">
            {(["sm", "md", "lg"] as TileSize[]).map((v) => (
              <button
                key={v}
                role="radio"
                aria-checked={prefs.size === v}
                className={`segment${prefs.size === v ? " active" : ""}`}
                title={{ sm: "Small", md: "Medium", lg: "Large" }[v]}
                onClick={() => savePrefs({ size: v })}
              >
                {v.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>

      {filesList === null ? (
        <div className={`doc-grid ${prefs.size}`}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="doc-tile skeleton-card" />
          ))}
        </div>
      ) : visible.length === 0 && !uploading.length ? (
        <div className="tool-empty mono-label">NO FILES HERE YET</div>
      ) : prefs.mode === "list" ? (
        <div className="doc-list">
          {visible.map((f) => (
            <div key={f.name} className="doc-row" onClick={() => setPreview(f)} {...dragProps(f)}>
              <span className="doc-row-glyph">
                <IconFiles />
              </span>
              <span className="doc-row-name">{displayFileName(f.name)}</span>
              <span className="tool-chip">{fileExt(displayFileName(f.name))}</span>
              <span className="mono-label doc-row-meta">
                {formatSize(f.size)} · {formatDate(f.modified)}
              </span>
              {actionButtons(f)}
            </div>
          ))}
        </div>
      ) : (
        <div className={`doc-grid ${prefs.size}`}>
          {uploading.map((name) => (
            <div key={`up-${name}`} className="doc-tile uploading">
              <div className="doc-thumb skeleton-card" />
              <p className="doc-tile-name">{name}</p>
            </div>
          ))}
          {visible.map((f) => {
            const name = displayFileName(f.name);
            return (
              <article
                key={f.name}
                className="doc-tile"
                onClick={() => setPreview(f)}
                title={name}
                {...dragProps(f)}
              >
                <div className="doc-thumb">
                  {prefs.size !== "sm" && (isImage(name) || isPdf(name)) ? (
                    <FileThumb name={name} url={fileUrl(f.name)} />
                  ) : (
                    <span className="file-thumb-icon">
                      <IconFiles />
                      <span className="tool-chip">{fileExt(name)}</span>
                    </span>
                  )}
                  {actionButtons(f)}
                </div>
                <p className="doc-tile-name">{name}</p>
                {prefs.size === "lg" && (
                  <p className="mono-label doc-tile-meta">
                    {formatSize(f.size)} · {formatDate(f.modified)}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}

      {preview && <PreviewModal file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
