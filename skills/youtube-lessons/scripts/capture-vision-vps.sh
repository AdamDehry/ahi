#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  capture-vision-vps.sh [--max-frames N] [--width PX] [--scene-threshold N] [--min-gap SECONDS] <youtube-url>

Optional remote-backend helper. Runs YouTube fetch, transcription, and frame extraction
on a user-configured machine, then rsyncs the lean bundle back to
$AHI_HOME/skills/videos/yt/<id>/ on the current host.
USAGE
}

AHI_HOME="${AHI_HOME:-$HOME/ahi}"
CONFIG="${REMOTE_CAPTURE_CONFIG:-${MAC_HANDS_CONFIG:-$HOME/.config/ahi/remote-capture.env}}"
[ -r "$CONFIG" ] && # shellcheck disable=SC1090
  . "$CONFIG"

MAC_SSH_HOST="${MAC_SSH_HOST:-}"
MAC_SSH_USER="${MAC_SSH_USER:-${USER:-}}"
MAC_SSH_KEY="${MAC_SSH_KEY:-$HOME/.ssh/ahi_remote_capture}"
MAC_YOUTUBE_SCRIPT="${MAC_YOUTUBE_SCRIPT:-$AHI_HOME/skills/youtube-lessons/scripts/capture-vision-mac.sh}"

ARGS=()
URL=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --max-frames|--width|--scene-threshold|--min-gap)
      ARGS+=("$1" "${2:-}")
      shift 2
      ;;
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

if [ -z "$MAC_SSH_HOST" ] || [ -z "$MAC_SSH_USER" ]; then
  echo "ERROR: remote capture is optional and not configured." >&2
  echo "Set MAC_SSH_HOST, MAC_SSH_USER, MAC_SSH_KEY, and MAC_YOUTUBE_SCRIPT, or use scripts/transcribe.sh locally." >&2
  exit 3
fi

ssh_base=(
  ssh
  -i "$MAC_SSH_KEY"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  "${MAC_SSH_USER}@${MAC_SSH_HOST}"
)

echo "[mac] running vision capture on ${MAC_SSH_USER}@${MAC_SSH_HOST}" >&2
remote_cmd="PATH=\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\$PATH"
remote_cmd+=" $(printf '%q' "$MAC_YOUTUBE_SCRIPT")"
for arg in "${ARGS[@]}" "$URL"; do
  remote_cmd+=" $(printf '%q' "$arg")"
done
remote_output="$("${ssh_base[@]}" "$remote_cmd")"

echo "$remote_output" >&2
remote_dir="$(printf '%s\n' "$remote_output" | awk -F= '$1=="OUT_DIR"{print $2}' | tail -1)"
video_id="$(printf '%s\n' "$remote_output" | awk -F= '$1=="VIDEO_ID"{print $2}' | tail -1)"

if [ -z "$remote_dir" ] || [ -z "$video_id" ]; then
  echo "ERROR: Mac capture did not return OUT_DIR/VIDEO_ID" >&2
  exit 5
fi

dest="$AHI_HOME/skills/videos/yt/$video_id"
mkdir -p "$dest"

echo "[sync] copying lean bundle to $dest" >&2
rsync -az \
  -e "ssh -i '$MAC_SSH_KEY' -o IdentitiesOnly=yes -o BatchMode=yes" \
  --exclude '/raw/' \
  --exclude 'audio.m4a' \
  --exclude '*.mp4' \
  --exclude '*.webm' \
  "${MAC_SSH_USER}@${MAC_SSH_HOST}:${remote_dir}/" \
  "$dest/"

echo "[done] video_id=$video_id" >&2
echo "$dest"
