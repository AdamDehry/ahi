import { memo, useEffect, useRef, useState } from "react";
import { IconFiles } from "./icons";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|heic)$/i;
const PDF_EXT = /\.pdf$/i;

export function fileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase().slice(0, 5) : "FILE";
}

export function isImage(name: string): boolean {
  return IMAGE_EXT.test(name);
}

export function isPdf(name: string): boolean {
  return PDF_EXT.test(name);
}

/** First-page PDF thumbnails via lazily-imported pdfjs. Rendered once per
 *  file per session (dataURL cache) so scrolling never re-renders. */
const pdfThumbCache = new Map<string, string>();
const pdfInflight = new Map<string, Promise<string | null>>();

async function renderPdfThumb(url: string): Promise<string | null> {
  const cached = pdfThumbCache.get(url);
  if (cached) return cached;
  const inflight = pdfInflight.get(url);
  if (inflight) return inflight;
  const job = (async () => {
    try {
      const pdfjs = await import("pdfjs-dist");
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      const doc = await pdfjs.getDocument({ url }).promise;
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const scale = 320 / viewport.width; // thumbnail resolution, not display size
      const scaled = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(scaled.width);
      canvas.height = Math.ceil(scaled.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      await page.render({ canvas, canvasContext: ctx, viewport: scaled }).promise;
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      pdfThumbCache.set(url, dataUrl);
      void doc.cleanup();
      return dataUrl;
    } catch {
      return null;
    } finally {
      pdfInflight.delete(url);
    }
  })();
  pdfInflight.set(url, job);
  return job;
}

/**
 * Preview for a file card (3d§3): images = real thumbnail, PDFs =
 * first-page render, everything else = typed icon. Fixed-size boxes —
 * the grid never reflows when a preview resolves. Lazy: PDFs render
 * only once the card is on screen (IntersectionObserver).
 */
const FileThumb = memo(function FileThumb({ name, url }: { name: string; url: string }) {
  const [pdfThumb, setPdfThumb] = useState<string | null>(pdfThumbCache.get(url) ?? null);
  const boxRef = useRef<HTMLDivElement>(null);
  const pdf = isPdf(name);

  useEffect(() => {
    if (!pdf || pdfThumb) return;
    const el = boxRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        renderPdfThumb(url).then(setPdfThumb);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [pdf, pdfThumb, url]);

  return (
    <div className="file-thumb" ref={boxRef}>
      {isImage(name) ? (
        <img src={url} alt={name} loading="lazy" />
      ) : pdf && pdfThumb ? (
        <img src={pdfThumb} alt={name} />
      ) : (
        <span className="file-thumb-icon">
          <IconFiles />
          <span className="tool-chip">{fileExt(name)}</span>
        </span>
      )}
    </div>
  );
});

export default FileThumb;
