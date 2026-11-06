#!/usr/bin/env python3
"""
talking_shot — one dialogue shot, native audio, on Higgsfield.

The model draws the mouth AND speaks the words in the same pass, so sync is a property
of the generation rather than something we assemble afterwards. This is the same call
claude.ai's Higgsfield connector makes for talking video (ugc-video workflow):
seedance_2_5, mode omni_reference, generate_audio true, no separate TTS job.

Subcommands
  voice-ref   cut a 5-12s voice-lock reference out of an approved take's audio
  cost        build the prompt and price it (free, creates no job)
  make        cost-gate, generate, download, measure sync, write manifest.json

The prompt is assembled from fixed blocks so the voice and look stay identical
shot to shot. Only ACTION and LINES change between shots of the same character.

  IDENTITY  who is on screen, tied to the reference image(s)
  PERSONA   one sentence, verbatim every shot
  ACTION    what happens, with times, plus camera
  AUDIO     "He speaks to camera with <VOICE>, over <AMBIENCE>: "<LINES>""
  SUFFIX    mouth / consistency / no-subtitles / no-music rules

Example
  talking_shot.py make --out work/v4/seg/D2 \\
     --ref <reference-upload-id> --voice-ref work/v4/voice/lock.wav \\
     --identity-file character/identity.txt --persona-file character/persona.txt \\
     --voice-file character/voice.txt --action-file prompts/D2-action.txt \\
     --ambience "a quiet sunny suburban street, a light breeze in palms" \\
     --lines "Ah, you see this? The track is bent. That's your noise." \\
     --duration 8 --resolution 720p --aspect 9:16 --max-credits 60
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_SUFFIX = (
    "{Pronoun_poss} lips form every word exactly as it is spoken, with one brief closed-mouth "
    "beat between sentences. Facial features clear and undistorted, consistent clothing "
    "throughout, {style} held consistent. No subtitles and no on-screen text{text_exception}. "
    "No music."
)


def sh(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def read_opt(text: str | None, path: Path | None) -> str:
    if path:
        return path.read_text().strip()
    return (text or "").strip()


def build_prompt(a) -> str:
    identity = read_opt(a.identity, a.identity_file)
    persona = read_opt(a.persona, a.persona_file)
    action = read_opt(a.action, a.action_file)
    voice = read_opt(a.voice, a.voice_file)
    lines = read_opt(a.lines, a.lines_file)
    if not (identity and action and lines):
        raise SystemExit("ERROR: identity, action and lines are required")
    if '"' in lines:
        raise SystemExit("ERROR: lines must not contain double quotes; the AUDIO block quotes them")
    # spoken text hygiene: em dash has undefined normaliser behaviour
    lines = lines.replace("—", ",").replace(" ,", ",")
    he = a.pronoun
    poss = {"He": "His", "She": "Her", "They": "Their"}[he]
    voice_clause = f" with {voice}" if voice else ""
    amb = f", over the natural ambience of {a.ambience}" if a.ambience else ""
    audio = f'Audio: {he} speaks to camera{voice_clause}{amb}: "{lines}"'
    suffix = a.suffix or DEFAULT_SUFFIX.format(
        Pronoun_poss=poss, style=a.style,
        text_exception=f" other than {a.text_exception}" if a.text_exception else "")
    if a.accent_guard:
        suffix += " No neutral accent, no generic American voice, no flat monotone delivery."
    blocks = [identity, persona, action, audio, suffix]
    prompt = "\n\n".join(b for b in blocks if b)
    if len(prompt) > 3500:
        raise SystemExit(f"ERROR: prompt is {len(prompt)} chars; keep it under 3500")
    return prompt


def words_per_second(lines: str, duration: int) -> float:
    return len(re.findall(r"[A-Za-z']+", lines)) / max(1, duration)


def cli_args(a, prompt: str, voice_ref: str | None) -> list[str]:
    mode = "omni_reference" if (a.ref or voice_ref) else "t2v"
    args = [a.model, "--mode", mode, "--duration", str(a.duration),
            "--resolution", a.resolution, "--aspect_ratio", a.aspect,
            "--generate_audio", "true", "--prompt", prompt]
    for r in a.ref:
        args += ["--image-references", r]
    if voice_ref:
        args += ["--audio-references", voice_ref]
    if a.draft:
        args += ["--draft", "true"]
    return args


def cost(a, prompt: str, voice_ref: str | None) -> float:
    r = sh(["higgsfield", "generate", "cost"] + cli_args(a, prompt, voice_ref))
    m = re.search(r"([\d.]+)\s+credits", r.stdout + r.stderr)
    if not m:
        raise SystemExit(f"ERROR: could not price the job:\n{r.stdout}{r.stderr}")
    return float(m.group(1))


def balance() -> float | None:
    m = re.search(r"([\d.]+)\s+credits", sh(["higgsfield", "account", "status"]).stdout)
    return float(m.group(1)) if m else None


def cmd_voice_ref(a) -> int:
    """Cut a voice-lock reference out of an approved take. Mono, 48k, light high-pass,
    loudness-normalised. Keep it 5-12s and dialogue-only: whatever else is in the window
    (music, a door slam) becomes part of the 'voice' the model is asked to keep."""
    dur = a.end - a.start
    if not 5 <= dur <= 12:
        raise SystemExit(f"ERROR: window is {dur:.1f}s; a voice reference should be 5-12s")
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    r = sh(["ffmpeg", "-v", "error", "-ss", str(a.start), "-to", str(a.end), "-i", a.take,
            "-vn", "-ac", "1", "-ar", "48000",
            "-af", "highpass=f=80,afade=t=in:d=0.03,afade=t=out:st=%.3f:d=0.05,loudnorm=I=-18:TP=-2"
            % (dur - 0.05), str(out), "-y"])
    if r.returncode:
        raise SystemExit(r.stderr)
    print(f"voice reference -> {out} ({dur:.1f}s)")
    return 0


def cmd_cost(a) -> int:
    prompt = build_prompt(a)
    c = cost(a, prompt, a.voice_ref)
    wps = words_per_second(read_opt(a.lines, a.lines_file), a.duration)
    print(prompt)
    print(f"\n--- {len(prompt)} chars · {wps:.1f} words/s · {c:g} credits (rail {a.max_credits:g})")
    if wps > 2.8:
        print("WARN: over ~2.8 words/s the model starts compressing speech; lip sync is weakest there")
    return 0 if c <= a.max_credits else 2


def cmd_make(a) -> int:
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    prompt = build_prompt(a)
    (out / "prompt.txt").write_text(prompt + "\n")
    c = cost(a, prompt, a.voice_ref)
    if c > a.max_credits:
        print(f"STOP: this job prices at {c:g} credits, over the {a.max_credits:g} rail. Nothing was spent.")
        return 2
    before = balance()
    print(f"generating · {a.model} · {a.duration}s {a.resolution} · {c:g} credits · balance {before}")
    r = sh(["higgsfield", "generate", "create"] + cli_args(a, prompt, a.voice_ref)
           + ["--wait", "--wait-timeout", "30m", "--json"])
    (out / "job.json").write_text(r.stdout or r.stderr)
    try:
        job = json.loads(r.stdout)
        job = job[0] if isinstance(job, list) else job
    except json.JSONDecodeError:
        print(f"ERROR: job did not return JSON; see {out/'job.json'}")
        return 1
    after = balance()
    url = job.get("result_url")
    if job.get("status") != "completed" or not url:
        print(f"FAILED: status={job.get('status')} id={job.get('id')}")
        return 1
    mp4 = out / "take.mp4"
    urllib.request.urlretrieve(url, mp4)
    sh(["ffmpeg", "-v", "error", "-i", str(mp4), "-vn", "-ac", "1", "-ar", "48000",
        str(out / "take.wav"), "-y"])
    sync = sh([sys.executable, str(HERE / "av_sync.py"), str(mp4), out.name]).stdout
    print(sync)
    manifest = {
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "job_id": job.get("id"), "model": a.model,
        "mode": "omni_reference" if (a.ref or a.voice_ref) else "t2v", "draft": a.draft,
        "duration": a.duration, "resolution": a.resolution, "aspect_ratio": a.aspect,
        "image_references": a.ref, "voice_reference": a.voice_ref,
        "priced_credits": c, "balance_before": before, "balance_after": after,
        # balance delta, NOT this job's cost when other jobs ran at the same time
        # (credits are taken at submission). The ledger is `higgsfield account transactions`.
        "balance_delta": round(before - after, 2) if before is not None and after is not None else None,
        "result_url": url, "av_sync": sync.strip().splitlines(),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"-> {mp4}  priced {c:g} credits (balance moved {manifest['balance_delta']}; "
          f"other concurrent jobs count too, check transactions)")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="talking_shot", description=__doc__.strip().splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("voice-ref", help="cut a voice-lock reference from an approved take")
    v.add_argument("take")
    v.add_argument("--start", type=float, required=True)
    v.add_argument("--end", type=float, required=True)
    v.add_argument("--out", required=True)
    v.set_defaults(fn=cmd_voice_ref)

    for name, fn in (("cost", cmd_cost), ("make", cmd_make)):
        p = sub.add_parser(name)
        p.add_argument("--out", default="talking-shot")
        p.add_argument("--model", default="seedance_2_5")
        p.add_argument("--ref", action="append", default=[],
                       help="character/scene reference: upload id, job id, or local path (repeatable). "
                            "None -> text-to-video mode (a voice-ref still forces omni_reference)")
        p.add_argument("--draft", action="store_true",
                       help="seedance_2_5 480p draft; can be finalized to 1080p within 7 days")
        p.add_argument("--voice-ref", help="voice-lock audio: upload id, job id, or local path")
        for blk in ("identity", "persona", "action", "voice", "lines"):
            p.add_argument(f"--{blk}")
            p.add_argument(f"--{blk}-file", type=Path)
        p.add_argument("--ambience", default="")
        p.add_argument("--pronoun", default="He", choices=["He", "She", "They"])
        p.add_argument("--style", default="the look")
        p.add_argument("--text-exception", default="", help="e.g. 'the truck logo'")
        p.add_argument("--accent-guard", action="store_true",
                       help="append the anti-neutral-accent clause (only when an accent is requested)")
        p.add_argument("--suffix", help="replace the default suffix entirely")
        p.add_argument("--duration", type=int, default=8)
        p.add_argument("--resolution", default="720p", choices=["480p", "720p", "1080p"])
        p.add_argument("--aspect", default="9:16")
        p.add_argument("--max-credits", type=float, default=60)
        p.set_defaults(fn=fn)

    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
