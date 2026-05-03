#!/usr/bin/env python3
"""
ocr.py — run Google Cloud Vision OCR on an image and print extracted text.

Shared vision skill. Any AHI agent can invoke it directly.

Usage:
    $AHI_HOME/skills/vision/ocr.py /path/to/image.jpg

Auth (checked in order):
    1. GOOGLE_VISION_API_KEY      — dedicated Vision API key
    2. GOOGLE_TTS_API_KEY         — shared Google key (TTS/STT/Vision enabled)
    3. GOOGLE_APPLICATION_CREDENTIALS — service account JSON path

Fails loudly if none are present. Prints extracted text to stdout; logs to stderr.
"""
import os
import sys
from pathlib import Path

def log(msg):
    print(msg, file=sys.stderr)

def main():
    if len(sys.argv) < 2:
        log("Usage: ocr.py <image-path>")
        sys.exit(2)

    image_path = Path(sys.argv[1]).expanduser().resolve()
    if not image_path.exists():
        log(f"[ocr] File not found: {image_path}")
        sys.exit(3)

    image_bytes = image_path.read_bytes()

    # Prefer a dedicated Vision key, else fall back to the shared Google key
    # that already powers TTS/STT (the same key is used for Vision).
    api_key = os.environ.get("GOOGLE_VISION_API_KEY") or os.environ.get("GOOGLE_TTS_API_KEY")
    creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")

    if api_key:
        import base64
        try:
            import requests
        except ImportError:
            log("[ocr] requests not installed. pip3 install requests")
            sys.exit(2)
        log(f"[ocr] Using API key auth for {image_path}")
        payload = {
            "requests": [{
                "image": {"content": base64.b64encode(image_bytes).decode("ascii")},
                "features": [{"type": "TEXT_DETECTION"}],
            }]
        }
        r = requests.post(
            f"https://vision.googleapis.com/v1/images:annotate?key={api_key}",
            json=payload, timeout=30,
        )
        if not r.ok:
            log(f"[ocr] Vision API error {r.status_code}: {r.text[:500]}")
            sys.exit(4)
        data = r.json()
        resp = data.get("responses", [{}])[0]
        text = resp.get("fullTextAnnotation", {}).get("text") or ""
        if not text:
            anns = resp.get("textAnnotations", [])
            if anns:
                text = anns[0].get("description", "")
        print(text)
        return

    if creds_path:
        try:
            from google.cloud import vision
        except ImportError as e:
            log(f"[ocr] Missing dependency: {e}")
            log("[ocr] Install: pip3 install google-cloud-vision")
            sys.exit(2)
        log(f"[ocr] Using service account auth for {image_path}")
        client = vision.ImageAnnotatorClient()
        image = vision.Image(content=image_bytes)
        response = client.text_detection(image=image)
        if response.error.message:
            log(f"[ocr] Vision API error: {response.error.message}")
            sys.exit(4)
        text = response.full_text_annotation.text if response.full_text_annotation else ""
        if not text and response.text_annotations:
            text = response.text_annotations[0].description
        print(text)
        return

    log("[ocr] No Google Vision credentials found.")
    log("[ocr] Set GOOGLE_VISION_API_KEY, GOOGLE_TTS_API_KEY, or GOOGLE_APPLICATION_CREDENTIALS.")
    sys.exit(5)

if __name__ == "__main__":
    main()
