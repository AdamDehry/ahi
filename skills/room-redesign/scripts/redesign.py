#!/usr/bin/env python3
"""
room-redesign — photorealistic room reimagining via fal.ai GPT Image 2 edit.

Avi's interior-design rendering engine. Takes one or more room photos, an
optional floor plan, and a plain-English design description; produces
redesigned room renderings that respect the existing room's bones.

Endpoint: openai/gpt-image-2/edit (image-to-image, accepts up to 16 refs).

Path scheme (the user's canonical creative tree):

  $AHI_HOME/workspaces/interior-design/<project>/<room>/input/
  $AHI_HOME/workspaces/interior-design/<project>/<room>/output/

The script reads inputs from input/ and writes renders to output/. Each run
also writes brief.txt and manifest.json next to output/ for the audit trail.

Run:
  source $AHI_HOME/.env && \
    $AHI_HOME/venvs/fal/bin/python redesign.py \
      --project villa-8 --room primary-bedroom \
      --photos general_20260429_203923.jpg general_20260429_203944.jpg \
      --floorplan floorplan.png \
      --description "..." \
      [--num-images 2] \
      [--quality high] \
      [--size auto]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Hard-fail with a useful message if fal_client is missing — the user will
# almost always be running this through the recommended venv, but if they
# misconfigure their python they should know exactly what to do.
try:
    import fal_client  # type: ignore
except ImportError:
    sys.stderr.write(
        "ERROR: fal_client not installed. Install via:\n"
        "  python3 -m venv $AHI_HOME/venvs/fal\n"
        "  $AHI_HOME/venvs/fal/bin/pip install fal-client\n"
        "Then run this script with $AHI_HOME/venvs/fal/bin/python.\n"
    )
    sys.exit(1)


# ─── Constants ──────────────────────────────────────────────────────────────

# fal.ai endpoint for GPT Image 2 image edit. If this changes upstream, this
# is the one line to edit. (Confirmed 2026-04-29.)
ENDPOINT = "openai/gpt-image-2/edit"

# Model accepts up to 16 reference images. We reserve 1 slot for the floor
# plan and cap room photos at 12 to leave headroom.
MAX_ROOM_PHOTOS = 12

# the user's canonical creative tree. All interior-design projects live here.
DEFAULT_PROJECT_ROOT = Path("$AHI_HOME/workspaces/interior-design")

# Where AHI keeps shared secrets. Falls back here if FAL_KEY isn't already
# in the environment — the secrets file uses bare KEY=VALUE (no `export`),
# so we parse it manually rather than asking the caller to `source` it.
SECRETS_FILE = Path("$AHI_HOME/.env").expanduser()

# Light style preambles. Deliberately short — they're a safety net for thin
# briefs, not a replacement for a real description from Avi.
STYLE_PREAMBLES = {
    "modern": (
        "Reimagine in a clean modern direction — restrained palette, considered "
        "lighting, honest materials, minimal ornament. "
    ),
    "scandinavian": (
        "Reimagine in a Scandinavian direction — pale woods, soft whites, "
        "natural textiles, abundant daylight, calm and uncluttered. "
    ),
    "mediterranean": (
        "Reimagine in a Mediterranean direction — warm plaster walls, terracotta "
        "and clay tones, natural stone, aged wood, generous daylight. "
    ),
    "industrial": (
        "Reimagine in an industrial direction — exposed materials (brick, steel, "
        "concrete), aged metal fixtures, leather, broad-plank floors, considered "
        "warmth against the rawness. "
    ),
}

FLOORPLAN_INSTRUCTION = (
    " The final reference image is a floor plan showing the room's dimensions "
    "and layout — preserve the spatial geometry, wall positions, window "
    "placements, and door openings shown in that floor plan."
)

PRESERVE_BONES_INSTRUCTION = (
    " Preserve the existing architecture — keep window placements, door "
    "openings, ceiling height, and the room's overall geometry exactly as in "
    "the reference photo(s). Change only finishes, furnishings, lighting, and "
    "decor as described."
)

PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


# ─── Helpers ────────────────────────────────────────────────────────────────

def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def download(url: str, dest: Path) -> int:
    with urllib.request.urlopen(url, timeout=180) as r:
        dest.write_bytes(r.read())
    return dest.stat().st_size


def build_prompt(description: str, style: str | None, has_floorplan: bool) -> str:
    """Assemble the final prompt sent to GPT Image 2.

    Order: style preamble → user description → preserve-bones note → floor
    plan note (only if a plan was attached). The bones-and-floorplan notes
    are appended so the user's description carries the semantic weight.
    """
    parts = []
    if style and style in STYLE_PREAMBLES:
        parts.append(STYLE_PREAMBLES[style])
    parts.append(description.strip())
    parts.append(PRESERVE_BONES_INSTRUCTION)
    if has_floorplan:
        parts.append(FLOORPLAN_INSTRUCTION)
    # Single space join keeps the prompt as one paragraph — gpt-image-2 reads
    # paragraph-shaped prompts more reliably than multi-paragraph ones.
    return " ".join(p.strip() for p in parts if p.strip())


def resolve_input_path(project_input_dir: Path, name: str) -> Path:
    """Resolve a photo name to an absolute path.

    Accepts: a bare filename (looked up inside project_input_dir), a relative
    path, or an absolute path. We do not copy files — the script reads from
    input/ in place.
    """
    p = Path(name).expanduser()
    if p.is_absolute() and p.exists():
        return p.resolve()
    candidate = (project_input_dir / name).resolve()
    if candidate.exists():
        return candidate
    # Last try: treat as a relative path from cwd
    cwd_candidate = Path(name).resolve()
    if cwd_candidate.exists():
        return cwd_candidate
    raise FileNotFoundError(name)


# ─── Main ───────────────────────────────────────────────────────────────────

def load_secrets_if_needed() -> None:
    """Populate FAL_KEY / FAL_API_KEY from $AHI_HOME/.env if missing.

    The secrets file uses bare `KEY=VALUE` lines (no `export`), so a normal
    `source` from the shell does not propagate them to subprocess env. Reading
    the file directly here removes that footgun for callers.
    """
    if os.environ.get("FAL_KEY") or os.environ.get("FAL_API_KEY"):
        return
    if not SECRETS_FILE.exists():
        return
    try:
        for raw in SECRETS_FILE.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k in {"FAL_KEY", "FAL_API_KEY"} and v and k not in os.environ:
                os.environ[k] = v
    except OSError:
        pass


def main() -> int:
    p = argparse.ArgumentParser(
        prog="redesign",
        description="Redesign a room from photo(s) + a description via GPT Image 2.",
    )
    p.add_argument(
        "--project",
        required=True,
        help=(
            "Project name (top-level directory under the project root). "
            "Example: villa-8"
        ),
    )
    p.add_argument(
        "--room",
        required=True,
        help=(
            "Sub-project / room name (directory under the project). "
            "Example: primary-bedroom"
        ),
    )
    p.add_argument(
        "--project-root",
        type=Path,
        default=DEFAULT_PROJECT_ROOT,
        help=(
            f"Override the creative root. Default: {DEFAULT_PROJECT_ROOT}. "
            "Resolved path: <root>/<project>/<room>/{input,output}"
        ),
    )
    p.add_argument(
        "--photos",
        nargs="+",
        metavar="NAME",
        help=(
            "Input room photo filenames. Resolved relative to <room>/input/, "
            "or pass absolute paths. If omitted, ALL image files in input/ "
            "are used (excluding any matching --floorplan)."
        ),
    )
    p.add_argument(
        "--floorplan",
        metavar="NAME",
        help=(
            "Optional floor plan filename. Resolved relative to <room>/input/, "
            "or pass an absolute path. Sent as the final reference image."
        ),
    )
    p.add_argument(
        "--description",
        required=True,
        help="The design brief — Avi-elevated, specific, cinematic. This IS the model prompt.",
    )
    p.add_argument(
        "--style",
        choices=sorted(STYLE_PREAMBLES.keys()),
        help="Optional style preamble prepended to the description.",
    )
    p.add_argument(
        "--num-images",
        type=int,
        default=1,
        choices=[1, 2, 3, 4],
        help="Number of variants to generate (1-4, default 1).",
    )
    p.add_argument(
        "--quality",
        choices=["low", "medium", "high"],
        default="high",
        help="Quality tier (default: high).",
    )
    p.add_argument(
        "--size",
        choices=[
            "square_hd", "square",
            "portrait_4_3", "portrait_16_9",
            "landscape_4_3", "landscape_16_9",
            "auto",
        ],
        default="auto",
        help="Image size preset (default: auto — infers from source photo).",
    )
    p.add_argument(
        "--output-format",
        choices=["png", "jpeg", "webp"],
        default="png",
        help="Output image format (default: png).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs, build the prompt, but do not call the API.",
    )

    args = p.parse_args()

    # ─── Resolve project paths ──────────────────────────────────────────────
    project_root = Path(args.project_root).expanduser().resolve()
    room_dir = project_root / args.project / args.room
    input_dir = room_dir / "input"
    output_dir = room_dir / "output"

    if not input_dir.exists():
        log(f"ERROR: input dir not found: {input_dir}")
        log(
            f"Expected layout: {project_root}/<project>/<room>/input/  and output/."
        )
        return 2

    # Make sure output exists
    output_dir.mkdir(parents=True, exist_ok=True)

    # ─── Load secrets (after argparse so --help/--dry-run don't require them) ─
    load_secrets_if_needed()
    # fal_client looks for FAL_KEY specifically. If only FAL_API_KEY is set
    # (older naming), bridge it so the SDK picks it up.
    if not os.environ.get("FAL_KEY") and os.environ.get("FAL_API_KEY"):
        os.environ["FAL_KEY"] = os.environ["FAL_API_KEY"]
    if not args.dry_run and not os.environ.get("FAL_KEY"):
        log(
            "ERROR: FAL_KEY not set and could not be loaded from "
            f"{SECRETS_FILE}. Set it in the env or in that file."
        )
        return 1

    # ─── Resolve floor plan first (so we can exclude it from --photos auto-sweep) ─
    floorplan_path: Path | None = None
    if args.floorplan:
        try:
            floorplan_path = resolve_input_path(input_dir, args.floorplan)
        except FileNotFoundError:
            log(f"ERROR: --floorplan not found: {args.floorplan} (looked in {input_dir})")
            return 2

    # ─── Resolve room photos ────────────────────────────────────────────────
    room_paths: list[Path] = []
    if args.photos:
        for name in args.photos:
            try:
                room_paths.append(resolve_input_path(input_dir, name))
            except FileNotFoundError:
                log(f"ERROR: --photos entry not found: {name} (looked in {input_dir})")
                return 2
    else:
        # Auto-sweep all images from input/, excluding the floor plan
        for child in sorted(input_dir.iterdir()):
            if not child.is_file():
                continue
            if child.suffix.lower() not in PHOTO_EXTENSIONS:
                continue
            if floorplan_path and child.resolve() == floorplan_path:
                continue
            room_paths.append(child.resolve())

    if not room_paths:
        log(
            f"ERROR: no room photos found. Pass --photos or drop "
            f".jpg/.jpeg/.png/.webp files in {input_dir}."
        )
        return 2

    if len(room_paths) > MAX_ROOM_PHOTOS:
        log(
            f"ERROR: too many room photos ({len(room_paths)}). "
            f"Cap is {MAX_ROOM_PHOTOS} (fal limit is 16; we reserve slots for the floor plan)."
        )
        log("Pass an explicit subset via --photos.")
        return 2

    # ─── Build prompt ───────────────────────────────────────────────────────
    final_prompt = build_prompt(
        description=args.description,
        style=args.style,
        has_floorplan=bool(floorplan_path),
    )

    # Each run gets a timestamped brief + manifest stored alongside output/.
    # Renders themselves go directly into output/ with a timestamp prefix so
    # successive runs don't overwrite each other.
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    brief_path = room_dir / f"brief_{ts}.txt"
    manifest_path = room_dir / f"manifest_{ts}.json"
    if not args.dry_run:
        brief_path.write_text(final_prompt + "\n")

    log(f"→ project:     {args.project}/{args.room}")
    log(f"→ input dir:   {input_dir}")
    log(f"→ output dir:  {output_dir}")
    log(f"→ rooms:       {len(room_paths)} photo(s)")
    for rp in room_paths:
        log(f"               - {rp.name}")
    if floorplan_path:
        log(f"→ floor plan:  {floorplan_path.name}")
    else:
        log(f"→ floor plan:  (none)")
    log(f"→ style:       {args.style or '(none — relying on description)'}")
    log(f"→ variants:    {args.num_images} @ quality={args.quality}, size={args.size}")
    log(f"→ endpoint:    {ENDPOINT}")
    log("")
    log("──── PROMPT ────")
    log(final_prompt)
    log("────────────────")

    if args.dry_run:
        log("\n[dry-run] skipping API call.")
        # Still print the resolved output dir on stdout for symmetry
        print(str(output_dir))
        return 0

    # ─── Upload reference images to fal storage ─────────────────────────────
    log("\nUploading reference images...")
    image_urls: list[str] = []
    for rp in room_paths:
        url = fal_client.upload_file(str(rp))
        image_urls.append(url)
        log(f"  uploaded {rp.name} → {url[:60]}...")
    if floorplan_path:
        url = fal_client.upload_file(str(floorplan_path))
        image_urls.append(url)
        log(f"  uploaded {floorplan_path.name} (floor plan) → {url[:60]}...")

    # ─── Call GPT Image 2 edit ──────────────────────────────────────────────
    payload: dict[str, Any] = {
        "prompt": final_prompt,
        "image_urls": image_urls,
        "num_images": args.num_images,
        "quality": args.quality,
        "image_size": args.size,
        "output_format": args.output_format,
    }
    log(f"\nCalling {ENDPOINT}...")

    def on_update(update: Any) -> None:
        # Stream queue logs to stderr if present.
        logs = getattr(update, "logs", None)
        if logs:
            for entry in logs:
                msg = entry.get("message", "") if isinstance(entry, dict) else str(entry)
                if msg:
                    log(f"  [fal] {msg}")

    try:
        result = fal_client.subscribe(
            ENDPOINT,
            arguments=payload,
            with_logs=True,
            on_queue_update=on_update,
        )
    except Exception as exc:  # noqa: BLE001 — surface anything fal raises
        log(f"ERROR: fal.ai call failed: {exc}")
        return 3

    images = result.get("images") if isinstance(result, dict) else None
    if not images:
        log(f"ERROR: response had no images. Raw response: {result}")
        return 4

    # ─── Save renders ───────────────────────────────────────────────────────
    saved_renders: list[Path] = []
    ext = args.output_format if args.output_format != "jpeg" else "jpg"
    for i, img in enumerate(images, start=1):
        url = img.get("url") if isinstance(img, dict) else None
        if not url:
            log(f"  WARN: image {i} had no url, skipping. Entry: {img}")
            continue
        out = output_dir / f"render_{ts}_{i:02d}.{ext}"
        size = download(url, out)
        log(f"  saved {out.name} ({size // 1024} KB)")
        saved_renders.append(out)

    # ─── Manifest ───────────────────────────────────────────────────────────
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "endpoint": ENDPOINT,
        "project": args.project,
        "room": args.room,
        "request": {
            "prompt": final_prompt,
            "image_urls": image_urls,
            "num_images": args.num_images,
            "quality": args.quality,
            "image_size": args.size,
            "output_format": args.output_format,
        },
        "inputs": {
            "rooms": [str(p) for p in room_paths],
            "floorplan": str(floorplan_path) if floorplan_path else None,
            "style": args.style,
            "user_description": args.description,
        },
        "renders": [str(p) for p in saved_renders],
        "raw_response": result,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, default=str))

    log("\n✓ complete")
    # stdout: render paths first, then the output directory. Avi parses this.
    for p in saved_renders:
        print(str(p))
    print(str(output_dir))
    return 0


if __name__ == "__main__":
    sys.exit(main())
