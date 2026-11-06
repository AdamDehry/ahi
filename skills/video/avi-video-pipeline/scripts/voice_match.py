#!/usr/bin/env python3
"""Is it the same voice? A blind A-then-B listen.

Joins clip A, one second of silence, and clip B into one file, then asks an audio model
how many distinct speakers it hears, without saying what it should find. Per-clip accent
labels from the same judge are unstable (one voice was called American, British and
Southern on three takes), so the pairwise question is the one worth asking.

Always run a control pair you KNOW are different voices next to the pair under test.
If the control doesn't come back "two speakers", the result means nothing.

Needs OPENAI_API_KEY in the environment. Usage:
  voice_match.py a.wav b.wav [label] [--model gpt-audio-1.5]
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import urllib.request

PROMPT = """You will hear two short speech excerpts separated by one second of silence.
Answer strictly from what you hear.
1. Is the speaker in the first excerpt the same person as the speaker in the second?
   Answer SAME or DIFFERENT, then give your confidence from 0 to 100.
2. Describe the voice in each excerpt: pitch, age, timbre, accent.
3. If they differ, what is the most obvious difference?"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("label", nargs="?", default="")
    ap.add_argument("--model", default=os.environ.get("AUDIO_JUDGE_MODEL", "gpt-audio-1.5"))
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "ab.mp3")
        subprocess.run(["ffmpeg", "-v", "error", "-i", a.a, "-i", a.b, "-filter_complex",
                        "[0:a]aresample=24000,aformat=channel_layouts=mono[x];"
                        "[1:a]aresample=24000,aformat=channel_layouts=mono[y];"
                        "anullsrc=r=24000:cl=mono,atrim=0:1[s];[x][s][y]concat=n=3:v=0:a=1",
                        "-c:a", "libmp3lame", "-b:a", "160k", out, "-y"], check=True)
        b64 = base64.b64encode(open(out, "rb").read()).decode()
    body = {"model": a.model, "modalities": ["text"], "messages": [{"role": "user", "content": [
        {"type": "text", "text": PROMPT},
        {"type": "input_audio", "input_audio": {"data": b64, "format": "mp3"}}]}]}
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}",
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        d = json.load(r)
    print(f"########## {a.label} ##########")
    print(d["choices"][0]["message"]["content"])


if __name__ == "__main__":
    sys.exit(main())
