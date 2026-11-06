#!/usr/bin/env bash
set -euo pipefail
AHI_HOME="${AHI_HOME:-$HOME/ahi}"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

usage() {
  cat <<'USAGE'
Usage:
  capture-vision-mac.sh [--max-frames N] [--width PX] [--scene-threshold N] [--min-gap SECONDS] <youtube-url>

Runs on the user's Mac. Fetches/transcribes a YouTube video and extracts sampled
vision frames for youtube-lessons v2. Raw media stays Mac-side under raw/.
USAGE
}

MAX_FRAMES=120
WIDTH=768
SCENE_THRESHOLD=0.4
MIN_GAP=5
URL=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --max-frames) MAX_FRAMES="${2:-}"; shift 2 ;;
    --width) WIDTH="${2:-}"; shift 2 ;;
    --scene-threshold) SCENE_THRESHOLD="${2:-}"; shift 2 ;;
    --min-gap) MIN_GAP="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "ERROR: unknown arg $1" >&2; usage >&2; exit 2 ;;
    *) URL="$1"; shift ;;
  esac
done

if [ -z "$URL" ]; then
  echo "ERROR: no YouTube URL provided" >&2
  usage >&2
  exit 2
fi

YTDLP="$(command -v yt-dlp || echo /opt/homebrew/bin/yt-dlp)"
FFMPEG="$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)"
PYTHON="/usr/bin/python3"
TRANSCRIBE="$HOME/.claude/skills/youtube-lessons/scripts/transcribe.sh"
CDP_PROFILE="${MAC_CDP_PROFILE_DIR:-$AHI_HOME/runtimes/browser-control/chrome-cdp-profile}"

for tool in "$YTDLP" "$FFMPEG" "$PYTHON" "$TRANSCRIBE"; do
  if [ ! -x "$tool" ]; then
    echo "ERROR: required tool not executable: $tool" >&2
    exit 3
  fi
done

ROOT="$AHI_HOME/skills/videos/yt"
mkdir -p "$ROOT"

TMP_DIR="$(mktemp -d -t youtube-vision.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT
META_RAW="$TMP_DIR/metadata.raw.json"
META_ERR="$TMP_DIR/metadata.err"

run_ytdlp_json() {
  "$YTDLP" --dump-json --quiet --no-warnings "$URL" >"$META_RAW" 2>"$META_ERR"
}

if ! run_ytdlp_json || [ ! -s "$META_RAW" ] || [ "$(head -c 1 "$META_RAW")" != "{" ]; then
  echo "[fetch] metadata without browser cookies failed; retrying with Chrome profile cookies" >&2
  "$YTDLP" --cookies-from-browser "chrome:$CDP_PROFILE" --dump-json --quiet --no-warnings "$URL" >"$META_RAW" 2>"$META_ERR" || true
fi

if [ ! -s "$META_RAW" ] || [ "$(head -c 1 "$META_RAW")" != "{" ]; then
  echo "ERROR: yt-dlp could not resolve the URL even with Chrome cookies." >&2
  tail -20 "$META_ERR" >&2 || true
  exit 4
fi

VIDEO_ID="$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$META_RAW")"
TITLE="$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("title","(unknown)"))' "$META_RAW")"
DURATION="$("$PYTHON" -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("duration") or 0))' "$META_RAW")"
OUT_DIR="$ROOT/$VIDEO_ID"
RAW_DIR="$OUT_DIR/raw"
FRAMES_DIR="$OUT_DIR/frames"
mkdir -p "$RAW_DIR" "$FRAMES_DIR"

"$PYTHON" - "$META_RAW" "$OUT_DIR/metadata.json" <<'PY'
import datetime, json, sys
raw_path, out_path = sys.argv[1], sys.argv[2]
with open(raw_path) as f:
    m = json.load(f)
out = {
    "id": m["id"],
    "url": m.get("webpage_url"),
    "title": m.get("title"),
    "channel": m.get("channel") or m.get("uploader"),
    "channel_url": m.get("channel_url") or m.get("uploader_url"),
    "duration_seconds": m.get("duration"),
    "upload_date": m.get("upload_date"),
    "view_count": m.get("view_count"),
    "description": (m.get("description") or "")[:2000],
    "tags": m.get("tags", [])[:20],
    "captured_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    "captured_by": "youtube-lessons-v2-vision",
    "vision": {
        "pipeline": "mac-hands",
        "frames_manifest": "frames-manifest.json",
    },
}
with open(out_path, "w") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
PY

echo "[fetch] id=$VIDEO_ID title=$TITLE duration=${DURATION}s" >&2

"$TRANSCRIBE" --keep-audio "$URL" >&2

VIDEO_FILE="$RAW_DIR/video.mp4"
if [ ! -s "$VIDEO_FILE" ]; then
  echo "[fetch] downloading <=480p video for frames" >&2
  if ! "$YTDLP" \
    -f "bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[height<=480][ext=mp4]/best[height<=480]/best" \
    --merge-output-format mp4 \
    --no-warnings \
    -o "$RAW_DIR/video.%(ext)s" \
    "$URL" >&2; then
    echo "[fetch] video download without cookies failed; retrying with Chrome profile cookies" >&2
    "$YTDLP" \
      --cookies-from-browser "chrome:$CDP_PROFILE" \
      -f "bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[height<=480][ext=mp4]/best[height<=480]/best" \
      --merge-output-format mp4 \
      --no-warnings \
      -o "$RAW_DIR/video.%(ext)s" \
      "$URL" >&2
  fi
fi

if [ ! -s "$VIDEO_FILE" ]; then
  found="$(find "$RAW_DIR" -maxdepth 1 -type f \( -name 'video.*' -o -name '*.mp4' \) | head -1 || true)"
  if [ -n "$found" ]; then
    VIDEO_FILE="$found"
  else
    echo "ERROR: video file not found after yt-dlp fetch" >&2
    exit 5
  fi
fi

rm -rf "$FRAMES_DIR"
mkdir -p "$FRAMES_DIR"
WORK_FRAMES="$TMP_DIR/frames"
mkdir -p "$WORK_FRAMES"
FRAME_LOG="$TMP_DIR/frames.log"

SELECT_EXPR="gt(scene\\,$SCENE_THRESHOLD)+isnan(prev_selected_t)+gte(t-prev_selected_t\\,$MIN_GAP)"
echo "[frames] extracting scene>${SCENE_THRESHOLD} plus max ${MIN_GAP}s gap, width=${WIDTH}, cap=${MAX_FRAMES}" >&2
"$FFMPEG" -hide_banner -nostdin -y \
  -i "$VIDEO_FILE" \
  -vf "select='$SELECT_EXPR',scale='min(${WIDTH},iw)':-2,showinfo" \
  -fps_mode vfr \
  "$WORK_FRAMES/frame_%05d.jpg" \
  >"$FRAME_LOG" 2>&1

"$PYTHON" - "$WORK_FRAMES" "$FRAMES_DIR" "$OUT_DIR/frames-manifest.json" "$VIDEO_ID" "$URL" "$TITLE" "$DURATION" "$MAX_FRAMES" "$SCENE_THRESHOLD" "$MIN_GAP" "$WIDTH" "$FRAME_LOG" <<'PY'
import json, math, os, re, shutil, sys
from pathlib import Path

work = Path(sys.argv[1])
frames_dir = Path(sys.argv[2])
manifest_path = Path(sys.argv[3])
video_id, url, title = sys.argv[4], sys.argv[5], sys.argv[6]
duration = int(float(sys.argv[7] or 0))
max_frames = int(sys.argv[8])
scene_threshold = float(sys.argv[9])
min_gap = float(sys.argv[10])
width = int(sys.argv[11])
log_path = Path(sys.argv[12])

times = []
if log_path.exists():
    pattern = re.compile(r"pts_time:([0-9.]+)")
    for line in log_path.read_text(errors="replace").splitlines():
        m = pattern.search(line)
        if m:
            times.append(float(m.group(1)))

files = sorted(work.glob("frame_*.jpg"))
count = min(len(files), len(times)) if times else len(files)
pairs = []
for i, src in enumerate(files[:count]):
    ts = times[i] if i < len(times) else (i * min_gap)
    pairs.append((ts, src))

if len(pairs) > max_frames:
    if max_frames <= 1:
        pairs = [pairs[0]]
    else:
        idxs = sorted(set(round(i * (len(pairs) - 1) / (max_frames - 1)) for i in range(max_frames)))
        pairs = [pairs[i] for i in idxs]

def stamp(seconds):
    seconds = int(round(seconds))
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    if h:
        return f"{h:02d}h{m:02d}m{s:02d}s"
    return f"{m:02d}m{s:02d}s"

frames = []
used = {}
for n, (ts, src) in enumerate(pairs, 1):
    base = f"frame_{stamp(ts)}"
    used[base] = used.get(base, 0) + 1
    suffix = f"_{used[base]:02d}" if used[base] > 1 else ""
    name = f"{base}{suffix}.jpg"
    dest = frames_dir / name
    shutil.copy2(src, dest)
    frames.append({
        "index": n,
        "file": f"frames/{name}",
        "timestamp_seconds": round(ts, 3),
        "timestamp": stamp(ts),
    })

manifest = {
    "video_id": video_id,
    "url": url,
    "title": title,
    "duration_seconds": duration,
    "strategy": {
        "scene_threshold": scene_threshold,
        "min_gap_seconds": min_gap,
        "width_px": width,
        "max_frames": max_frames,
        "raw_selected_frames": len(files),
        "delivered_frames": len(frames),
        "cap_applied": len(files) > max_frames,
    },
    "span": {
        "first_timestamp_seconds": frames[0]["timestamp_seconds"] if frames else None,
        "last_timestamp_seconds": frames[-1]["timestamp_seconds"] if frames else None,
    },
    "frames": frames,
}
manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
print(json.dumps({
    "video_id": video_id,
    "out_dir": str(manifest_path.parent),
    "frames": len(frames),
    "first": manifest["span"]["first_timestamp_seconds"],
    "last": manifest["span"]["last_timestamp_seconds"],
}, ensure_ascii=False))
PY

echo "OUT_DIR=$OUT_DIR"
echo "VIDEO_ID=$VIDEO_ID"
echo "FRAMES_MANIFEST=$OUT_DIR/frames-manifest.json"
