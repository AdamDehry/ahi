#!/usr/bin/env python3
"""
gen_image.py — generate a single image from a text prompt via fal.ai.

Returns the hosted image URL to stdout. Logs to stderr.

Shared vision skill. Designed for AHI agents to embed the returned URL in
Telegram responses — Telegram auto-previews image URLs inline.

Usage:
    $AHI_HOME/skills/design/vision/gen_image.py --prompt "..." [--model ENDPOINT] [--aspect 1:1]

Auth: reads FAL_KEY from env, or from $AHI_HOME/secrets.env if not already set.

Model defaults to fal-ai/flux/dev — good quality, ~5-10s, inside any
reasonable request timeout. Swap to fal-ai/flux-pro/v1.1 for sharper
detail (~10-15s) or fal-ai/flux-1/schnell for speed (~2-3s, lower fidelity).

Exits:
    0 — success, URL printed to stdout
    1 — missing arg, missing credentials, or missing dependency
    2 — fal.ai returned an error or unexpected response shape
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def load_fal_key() -> None:
    """Populate FAL_KEY in env from $AHI_HOME/secrets.env if not already set."""
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


# Aspect ratio → fal.ai image_size token
SIZE_MAP = {
    "1:1": "square_hd",
    "4:3": "landscape_4_3",
    "3:4": "portrait_4_3",
    "16:9": "landscape_16_9",
    "9:16": "portrait_16_9",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate an image via fal.ai")
    parser.add_argument("--prompt", required=True, help="Text prompt for the image")
    parser.add_argument(
        "--model",
        default="fal-ai/flux/dev",
        help="fal.ai model endpoint (default: fal-ai/flux/dev)",
    )
    parser.add_argument(
        "--aspect",
        default="1:1",
        choices=list(SIZE_MAP.keys()),
        help="Aspect ratio (default: 1:1)",
    )
    args = parser.parse_args()

    load_fal_key()
    if not (os.environ.get("FAL_KEY") or os.environ.get("FAL_API_KEY")):
        log("[gen_image] FAL_KEY missing — not in env and not found in $AHI_HOME/secrets.env")
        return 1

    try:
        import fal_client
    except ImportError:
        log("[gen_image] fal_client not installed. Run this script with $AHI_HOME/venvs/fal/bin/python")
        return 1

    log(f"[gen_image] calling {args.model} (aspect: {args.aspect})")
    t0 = time.time()

    try:
        result = fal_client.subscribe(
            args.model,
            arguments={
                "prompt": args.prompt,
                "image_size": SIZE_MAP[args.aspect],
            },
        )
    except Exception as err:
        log(f"[gen_image] fal.ai call failed: {err}")
        return 2

    elapsed = int(time.time() - t0)

    if not isinstance(result, dict) or not result.get("images"):
        log(f"[gen_image] unexpected fal response shape: {result}")
        return 2

    img_url = result["images"][0].get("url")
    if not img_url:
        log(f"[gen_image] no URL in response image: {result['images'][0]}")
        return 2

    log(f"[gen_image] done in {elapsed}s")
    print(img_url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
