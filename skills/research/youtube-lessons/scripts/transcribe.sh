#!/usr/bin/env bash
# transcribe.sh — Download a YouTube video's audio and transcribe via MLX Whisper.
#
# Usage: transcribe.sh [--keep-audio] <youtube-url> [model]
#   --keep-audio   — keep audio.m4a after transcription (default: delete it to save ~20MB/video)
#   <youtube-url>  — any YouTube URL yt-dlp recognizes
#   [model]        — optional MLX Whisper model (default: mlx-community/whisper-large-v3-turbo)
#
# Output: writes to $HOME/ai/skills/videos/yt/<video-id>/
#   - metadata.json      (video metadata from yt-dlp)
#   - transcript.txt     (plain text transcript)
#   - transcript.srt     (timestamped transcript)
#   - audio.m4a          (only kept with --keep-audio)
#
# Prints the output directory path to stdout on success.
# Exits non-zero with a clear message on failure.

set -euo pipefail
AHI_HOME="${AHI_HOME:-$HOME/ahi}"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

KEEP_AUDIO=0
if [[ "${1:-}" == "--keep-audio" ]]; then
  KEEP_AUDIO=1
  shift
fi

URL="${1:-}"
MODEL="${2:-mlx-community/whisper-large-v3-turbo}"

if [[ -z "$URL" ]]; then
  echo "ERROR: no URL provided" >&2
  echo "usage: $0 [--keep-audio] <youtube-url> [model]" >&2
  exit 2
fi

# Tool paths — be explicit since ~/.local/bin may not be in PATH yet.
YTDLP="$(command -v yt-dlp || echo /opt/homebrew/bin/yt-dlp)"
if [[ -x "$AHI_HOME/infra/venvs/youtube-lessons-mlx/bin/mlx_whisper" ]]; then
  MLX_WHISPER="$AHI_HOME/infra/venvs/youtube-lessons-mlx/bin/mlx_whisper"
elif [[ -x "$HOME/ai/infra/venvs/youtube-lessons-mlx/bin/mlx_whisper" ]]; then
  MLX_WHISPER="$HOME/ai/infra/venvs/youtube-lessons-mlx/bin/mlx_whisper"
else
  MLX_WHISPER="$(command -v mlx_whisper || echo "$HOME/.local/bin/mlx_whisper")"
fi
FFMPEG="$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)"
CDP_PROFILE="${MAC_CDP_PROFILE_DIR:-$AHI_HOME/runtimes/browser-control/chrome-cdp-profile}"
# yt-dlp's cookie retry needs a Chrome profile that has a cookie store. Say so up front instead of failing late.
if [[ ! -e "$CDP_PROFILE/Default/Cookies" && ! -e "$CDP_PROFILE/Default/Network/Cookies" ]]; then
  echo "note: no Chrome cookie store under $CDP_PROFILE; if YouTube blocks the fetch, open that profile once and sign in, or set MAC_CDP_PROFILE_DIR" >&2
fi

for tool in "$YTDLP" "$MLX_WHISPER" "$FFMPEG"; do
  if [[ ! -x "$tool" ]]; then
    echo "ERROR: required tool not found or not executable: $tool" >&2
    exit 3
  fi
done

ROOT="$AHI_HOME/skills/videos/yt"
mkdir -p "$ROOT"

# Step 1: resolve video ID + metadata. Bail early if age-gated / private / live.
echo "[1/3] resolving video..." >&2
META_RAW="$(mktemp -t ytdlp-meta-raw)"
META_STDERR_LOG="$(mktemp -t ytdlp-meta-err)"
trap 'rm -f "$META_RAW" "$META_STDERR_LOG"' EXIT

"$YTDLP" --dump-json --quiet --no-warnings "$URL" >"$META_RAW" 2>"$META_STDERR_LOG" || true

if [[ ! -s "$META_RAW" ]] || [[ "$(head -c 1 "$META_RAW")" != "{" ]]; then
  echo "      metadata fetch failed; retrying with Chrome profile cookies" >&2
  "$YTDLP" --cookies-from-browser "chrome:$CDP_PROFILE" --dump-json --quiet --no-warnings "$URL" >"$META_RAW" 2>"$META_STDERR_LOG" || true
fi

if [[ ! -s "$META_RAW" ]] || [[ "$(head -c 1 "$META_RAW")" != "{" ]]; then
  echo "ERROR: yt-dlp could not resolve the URL. It may be private, age-gated, members-only, or a live stream that has not ended." >&2
  echo "yt-dlp stderr:" >&2
  tail -5 "$META_STDERR_LOG" >&2
  exit 4
fi

# Parse id/title/duration from the raw dump file (handles large payloads safely).
read -r VIDEO_ID VIDEO_TITLE DURATION < <(/usr/bin/python3 -c '
import json, sys
with open(sys.argv[1], "r") as f:
    d = json.load(f)
print(d["id"], "\t", d.get("title","(unknown)").replace("\t"," "), "\t", d.get("duration",0), sep="")
' "$META_RAW" | awk -F'\t' '{print $1, $2, $3}')
# Re-read cleanly to avoid word-splitting issues in titles.
VIDEO_ID="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$META_RAW")"
VIDEO_TITLE="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("title","(unknown)"))' "$META_RAW")"
DURATION="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("duration",0))' "$META_RAW")"

OUT_DIR="$ROOT/$VIDEO_ID"
mkdir -p "$OUT_DIR"

# Write condensed metadata.json from the raw dump.
/usr/bin/python3 - "$META_RAW" "$OUT_DIR/metadata.json" "$MODEL" <<'PYEOF'
import json, sys, datetime
raw_path, out_path, model = sys.argv[1], sys.argv[2], sys.argv[3]
with open(raw_path, "r") as f:
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
    "captured_by": "youtube-lessons",
    "model": model,
}
with open(out_path, "w") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
PYEOF

echo "      ID: $VIDEO_ID" >&2
echo "      Title: $VIDEO_TITLE" >&2
echo "      Duration: ${DURATION}s" >&2

# Step 2: download audio (m4a).
AUDIO="$OUT_DIR/audio.m4a"
if [[ -f "$AUDIO" ]]; then
  echo "[2/3] audio already present, skipping download" >&2
else
  echo "[2/3] downloading audio..." >&2
  if ! "$YTDLP" \
    -x --audio-format m4a \
    --no-warnings \
    -o "$OUT_DIR/audio.%(ext)s" \
    "$URL" >&2; then
    echo "      audio fetch failed; retrying with Chrome profile cookies" >&2
    "$YTDLP" \
      --cookies-from-browser "chrome:$CDP_PROFILE" \
      -x --audio-format m4a \
      --no-warnings \
      -o "$OUT_DIR/audio.%(ext)s" \
      "$URL" >&2
  fi
fi

# Step 3: transcribe. mlx_whisper writes <name>.txt and <name>.srt alongside the audio.
TRANSCRIPT="$OUT_DIR/transcript.txt"
if [[ -f "$TRANSCRIPT" ]]; then
  echo "[3/3] transcript already present, skipping transcription" >&2
else
  echo "[3/3] transcribing with $MODEL (first run downloads model ~1.5GB)..." >&2
  "$MLX_WHISPER" \
    --model "$MODEL" \
    --output-dir "$OUT_DIR" \
    --output-format txt \
    --output-name transcript \
    "$AUDIO" >&2
  "$MLX_WHISPER" \
    --model "$MODEL" \
    --output-dir "$OUT_DIR" \
    --output-format srt \
    --output-name transcript \
    "$AUDIO" >&2
fi

# Clean up audio unless --keep-audio was passed.
if [[ "$KEEP_AUDIO" == "0" && -f "$AUDIO" ]]; then
  rm -f "$AUDIO"
  echo "      (audio removed to save storage; pass --keep-audio to retain)" >&2
fi

echo "done." >&2
# Print the output directory to stdout so the caller can capture it.
echo "$OUT_DIR"
