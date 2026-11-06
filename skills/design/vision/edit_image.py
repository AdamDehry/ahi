#!/usr/bin/env python3
"""
edit_image.py — edit or transform existing image(s) via fal.ai nano-banana-2/edit.

Takes one or more reference images (local paths OR URLs) plus a prompt
describing the desired edit. Returns the hosted URL of the result to stdout.

Shared vision skill. Designed for AHI agents to edit an image the user
sent (via Telegram or uploaded to the dashboard) and return a new version.
Telegram auto-previews the returned URL inline.

Usage:
    $AHI_AI_ROOT/skills/design/vision/edit_image.py --prompt "..." --ref <path-or-url> [--ref <path-or-url>...] [--model ENDPOINT] [--negative "..."]

Arguments:
    --prompt    REQUIRED. The edit you want ("change background to soft pink,"
                "replace label text with 'Botanica', keep bottle shape," etc.)
    --ref       REQUIRED (repeatable). Local file path OR public URL to use
                as a reference. Local paths are uploaded to fal first.
                Repeat for multi-reference (up to ~9 refs per nano-banana call).
    --model     Optional fal.ai endpoint (default: fal-ai/nano-banana-2/edit).
    --negative  Optional negative prompt — things to avoid in the output.

Auth: reads FAL_KEY from env, or from $AHI_AI_ROOT/secrets.env if not set.

Typical latency: 5-15s for a single-reference edit. Multi-reference may be slower.

Exits:
    0 — success, URL printed to stdout
    1 — missing arg, missing credentials, or missing dependency
    2 — reference file not found or unreadable
    3 — fal.ai returned an error or unexpected shape
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlparse


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def load_fal_key() -> None:
    """Populate FAL_KEY in env from $AHI_AI_ROOT/secrets.env if not already set."""
    if os.environ.get("FAL_KEY") or os.environ.get("FAL_API_KEY"):
        return
    secrets = Path.home() / "ai" / "secrets.env"
    if not secrets.exists():
        return
    for line in secrets.read_text().splitlines():
        line = line.strip()
        if line.startswith("FAL_KEY=") and "=" in line:
            os.environ["FAL_KEY"] = line.split("=", 1)[1].strip().strip('"').strip("'")
            return


def is_url(s: str) -> bool:
    parsed = urlparse(s)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def resolve_ref(ref: str, fal_client) -> str:
    """Return a fal-accessible URL for a reference. Uploads local files; passes URLs through."""
    if is_url(ref):
        return ref
    path = Path(ref).expanduser().resolve()
    if not path.exists():
        log(f"[edit_image] reference not found: {path}")
        sys.exit(2)
    if not path.is_file():
        log(f"[edit_image] reference is not a file: {path}")
        sys.exit(2)
    log(f"[edit_image] uploading local ref: {path.name}")
    return fal_client.upload_file(str(path))


def main() -> int:
    parser = argparse.ArgumentParser(description="Edit an image via fal.ai")
    parser.add_argument("--prompt", required=True, help="Edit description")
    parser.add_argument(
        "--ref",
        action="append",
        required=True,
        dest="refs",
        help="Reference image (local path or URL). Repeat for multi-ref.",
    )
    parser.add_argument(
        "--model",
        default="fal-ai/nano-banana-2/edit",
        help="fal.ai endpoint (default: fal-ai/nano-banana-2/edit)",
    )
    parser.add_argument(
        "--negative",
        default="",
        help="Optional negative prompt — things to avoid",
    )
    args = parser.parse_args()

    load_fal_key()
    if not (os.environ.get("FAL_KEY") or os.environ.get("FAL_API_KEY")):
        log("[edit_image] FAL_KEY missing — not in env and not found in $AHI_AI_ROOT/secrets.env")
        return 1

    try:
        import fal_client
    except ImportError:
        log("[edit_image] fal_client not installed. Run this script with $AHI_AI_ROOT/venvs/fal/bin/python")
        return 1

    # Resolve all refs (upload locals, pass through URLs)
    ref_urls: list[str] = [resolve_ref(r, fal_client) for r in args.refs]

    log(f"[edit_image] calling {args.model} with {len(ref_urls)} ref(s)")
    t0 = time.time()

    arguments: dict = {
        "prompt": args.prompt,
        "image_urls": ref_urls,
    }
    if args.negative:
        arguments["negative_prompt"] = args.negative

    try:
        result = fal_client.subscribe(args.model, arguments=arguments)
    except Exception as err:
        log(f"[edit_image] fal.ai call failed: {err}")
        return 3

    elapsed = int(time.time() - t0)

    if not isinstance(result, dict) or not result.get("images"):
        log(f"[edit_image] unexpected fal response shape: {result}")
        return 3

    img_url = result["images"][0].get("url")
    if not img_url:
        log(f"[edit_image] no URL in response image: {result['images'][0]}")
        return 3

    log(f"[edit_image] done in {elapsed}s")
    print(img_url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
