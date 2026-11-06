# youtube-lessons Setup

This skill is optional. It ships with the public AHI framework but needs user
configuration before it can run.

Required tools:

- `yt-dlp`
- `ffmpeg`
- A transcription backend:
  - macOS Apple Silicon: `mlx-whisper` recommended
  - Linux/Windows: use Whisper-compatible tooling or replace `scripts/transcribe.sh`

Optional remote backend:

- If your server IP is blocked by YouTube, configure SSH to a personal machine
  you control and adapt `scripts/capture-vision-vps.sh`.
- Do not commit browser cookies, SSH keys, or account-specific hostnames.

