#!/usr/bin/env python3
"""
mix_native — the sound pass for native-audio takes.

Native audio already carries the dialogue and the scene's own ambience and foley, and
they share one acoustic space. That is the thing a dub can never give you, so this pass
KEEPS the take's audio as the main bus and only adds what the model was told to leave
out (music) plus a continuous room-tone floor that hides the ambience jump at each cut.

Buses (levels from david-series/SOUND-SOP.md, measured against dialogue, never guessed):
  native   the take audio, set so speech sits at about -18 dB RMS
  music    -37 dB RMS, sidechain-ducked hardest under the native bus
  floor    -45 dB RMS continuous bed, ducked lightly; masks seams between takes
  foley    optional extra stem, ducked least

The two ffmpeg traps that shipped in David v2 are designed out:
  sidechaincompress truncates to the sidechain  -> apad whole_dur on every ducked bus
  alimiter auto-levels back to full scale      -> level=disabled

Video is stream-copied. A sound pass never re-renders a frame.

Usage:
  mix_native.py --takes a.mp4 b.mp4 c.mp4 --out cut.mp4 \\
      [--music bed.wav] [--floor bed30.wav] [--foley stem.wav] [--speech-db -18]
Then it verifies the delivered file and prints PASS/FAIL per check.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

SR = 48000


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(f"ffmpeg failed:\n{' '.join(map(str, cmd))}\n{r.stderr}")
    return r


def duration(path) -> float:
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
    return float(r.stdout.strip())


def decode(path, ss=None, to=None) -> np.ndarray:
    cmd = ["ffmpeg", "-v", "error"] + (["-ss", str(ss)] if ss is not None else []) + \
          (["-to", str(to)] if to is not None else []) + \
          ["-i", str(path), "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    return np.frombuffer(subprocess.run(cmd, capture_output=True).stdout, np.float32)


def rms_db(x) -> float:
    return 20 * np.log10(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + 1e-12)


def speech_rms_db(x) -> float:
    """RMS over the loudest 40% of 50ms frames: a proxy for 'level while talking'."""
    hop = SR // 20
    fr = x[: len(x) // hop * hop].reshape(-1, hop)
    e = np.sqrt((fr.astype(np.float64) ** 2).mean(1))
    top = np.sort(e)[int(len(e) * 0.6):]
    return 20 * np.log10(np.sqrt((top ** 2).mean()) + 1e-12)


def vduration(path) -> float:
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=duration", "-of", "csv=p=0", str(path)])
    return float(r.stdout.strip() or duration(path))


def concat_takes(takes, work: Path):
    """Hard-cut concat. Video: the original streams, stream-copied. Audio: each take decoded
    to PCM, cut or padded to EXACTLY its own video length, 12ms fades at every seam, then
    joined sample-exact. Re-encoding each part to AAC before concatenating adds codec
    padding at every seam and slides the dialogue late, cumulatively (measured +0.03 /
    +0.07 / +0.11s on David v4's first build). One encode, at the very end, only.
    Returns (video_only_path, native_audio_wav, per-take [start, end] seconds)."""
    pcm, bounds, t0 = [], [], 0.0
    for t in takes:
        vd = vduration(t)
        n = int(round(vd * SR))
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(t), "-vn", "-ac", "2", "-ar", str(SR),
                              "-f", "f32le", "-"], capture_output=True).stdout
        x = np.frombuffer(raw, np.float32).reshape(-1, 2)[:n]
        if len(x) < n:
            x = np.vstack([x, np.zeros((n - len(x), 2), np.float32)])
        x = x.copy()
        f = int(0.012 * SR)
        ramp = np.linspace(0, 1, f, dtype=np.float32)[:, None]
        if len(takes) > 1:
            x[:f] *= ramp
            x[-f:] *= ramp[::-1]
        pcm.append(x)
        bounds.append([t0, t0 + vd])
        t0 += vd
    wav = work / "native.wav"
    p = subprocess.run(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                        "-c:a", "pcm_f32le", str(wav), "-y"], input=np.vstack(pcm).tobytes(),
                       capture_output=True)
    if p.returncode:
        raise SystemExit(p.stderr.decode())
    if len(takes) == 1:
        return Path(takes[0]), wav, bounds
    # The concat demuxer offsets each file by its CONTAINER duration, which is the longer
    # of audio and video (8.064s audio vs 8.042s picture on Seedance takes). Concatenating
    # the takes directly put beat N's picture ~22ms x (N-1) later than its audio. Strip
    # every take to a video-only file first, so container duration == picture duration.
    vparts = []
    for i, t in enumerate(takes):
        v = work / f"v{i}.mp4"
        run(["ffmpeg", "-v", "error", "-i", str(t), "-map", "0:v", "-c:v", "copy", str(v), "-y"])
        vparts.append(v)
    lst = work / "list.txt"
    lst.write_text("".join(f"file '{v}'\n" for v in vparts))
    out = work / "concat.mp4"
    run(["ffmpeg", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-map", "0:v",
         "-c:v", "copy", str(out), "-y"])
    return out, wav, bounds


def mix(src: Path, native_wav: Path, out: Path, music=None, floor=None, foley=None,
        speech_db=-18.0, music_db=-37.0, floor_db=-45.0, foley_gain=1.0):
    D = vduration(src)
    native = decode(native_wav)
    g_native = speech_db - speech_rms_db(native)
    inputs = ["-i", str(src), "-i", str(native_wav)]
    chains = [f"[1:a]aresample={SR},aformat=channel_layouts=stereo,volume={g_native:.2f}dB,"
              f"asplit=4[nat][sc1][sc2][sc3]"]
    buses = ["[nat]"]
    idx = 2

    def bus(path, target_db, sc, comp, label):
        nonlocal idx
        x = decode(path)
        g = target_db - rms_db(x)
        inputs.extend(["-stream_loop", "-1", "-i", str(path)])
        chains.append(
            f"[{idx}:a]aresample={SR},aformat=channel_layouts=stereo,atrim=0:{D:.3f},"
            f"volume={g:.2f}dB[{label}raw];[{label}raw][{sc}]sidechaincompress={comp},"
            f"apad=whole_dur={D:.3f}[{label}]")
        buses.append(f"[{label}]")
        idx += 1

    if music:
        bus(music, music_db, "sc1", "threshold=0.03:ratio=8:attack=15:release=300", "mus")
    if floor:
        bus(floor, floor_db, "sc2", "threshold=0.04:ratio=6:attack=20:release=350", "flr")
    if foley:
        inputs.extend(["-i", str(foley)])
        chains.append(f"[{idx}:a]aresample={SR},aformat=channel_layouts=stereo,volume={foley_gain}"
                      f"[folraw];[folraw][sc3]sidechaincompress=threshold=0.05:ratio=4:attack=25:"
                      f"release=250,apad=whole_dur={D:.3f}[fol]")
        buses.append("[fol]")
        idx += 1
    else:
        chains.append("[sc3]anullsink")
    if not music:
        chains.append("[sc1]anullsink")
    if not floor:
        chains.append("[sc2]anullsink")
    chains.append(f"{''.join(buses)}amix=inputs={len(buses)}:normalize=0:duration=longest,"
                  f"apad=whole_dur={D:.3f},atrim=0:{D:.3f},alimiter=limit=0.85:level=disabled[out]")
    run(["ffmpeg", "-v", "error"] + inputs + ["-filter_complex", ";".join(chains),
         "-map", "0:v", "-map", "[out]", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
         str(out), "-y"])
    return g_native


def env10ms(x):
    hop = SR // 100
    fr = x[: len(x) // hop * hop].reshape(-1, hop).astype(np.float64)
    return np.sqrt((fr ** 2).mean(1))


def placement(native: np.ndarray, delivered: np.ndarray, max_lag=0.3) -> float:
    """Lag (s) of the delivered mix against the native track, by envelope xcorr.
    Positive = delivered is late. Must be ~0: the take's audio IS the sync."""
    a, b = env10ms(native), env10ms(delivered)
    L = min(len(a), len(b))
    a = (a[:L] - a[:L].mean()) / (a[:L].std() + 1e-9)
    b = (b[:L] - b[:L].mean()) / (b[:L].std() + 1e-9)
    n = int(max_lag * 100)
    best, bl = -1e9, 0
    for lag in range(-n, n + 1):
        s = (a[:L - lag] * b[lag:]).mean() if lag >= 0 else (a[-lag:] * b[:L + lag]).mean()
        if s > best:
            best, bl = s, lag
    return bl / 100


def verify(src: Path, out: Path, native_wav: Path = None, bounds=None) -> bool:
    ok = True

    def check(name, cond, detail):
        nonlocal ok
        ok &= bool(cond)
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}: {detail}")

    md5 = lambda p: run(["ffmpeg", "-v", "error", "-i", str(p), "-map", "0:v", "-c", "copy",
                         "-f", "md5", "-"]).stdout.strip()
    check("video stream identical to source", md5(src) == md5(out), "stream-copied")
    vdur = float(run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                      "stream=duration", "-of", "csv=p=0", str(out)]).stdout.strip() or duration(out))
    a = decode(out)
    adur = len(a) / SR
    check("decoded audio covers the video", abs(adur - vdur) < 0.05, f"{adur:.3f}s vs {vdur:.3f}s")
    blk = SR // 2
    b = a[: len(a) // blk * blk].reshape(-1, blk).astype(np.float64)
    bdb = 20 * np.log10(np.sqrt((b ** 2).mean(1)) + 1e-12)
    check("no digital-silence blocks", (bdb < -70).sum() == 0,
          f"{int((bdb < -70).sum())}/{len(bdb)} blocks under -70 dB, floor {bdb.min():.1f} dB")
    peak = 20 * np.log10(np.abs(a).max() + 1e-12)
    check("peak headroom", peak <= -0.3, f"{peak:.2f} dBFS")
    if bounds and len(bounds) > 1:
        # picture timeline: each take must start exactly where its audio was placed
        r = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                 "packet=pts_time", "-of", "csv=p=0", str(out)])
        pts = np.sort(np.array([float(x) for x in r.stdout.split() if x.strip()]))
        gaps = np.diff(pts)
        step = np.median(gaps)
        check("picture timeline continuous (no seam gaps)", gaps.max() <= step * 1.5,
              f"largest frame gap {gaps.max() * 1000:.1f} ms at {step * 1000:.1f} ms/frame")
    if native_wav is not None and bounds:
        nat = decode(native_wav)
        lags = [placement(nat[int(s0 * SR):int(s1 * SR)], a[int(s0 * SR):int(s1 * SR)])
                for s0, s1 in bounds]
        check("native dialogue not moved (per take)", all(abs(l) <= 0.02 for l in lags),
              " ".join(f"{l:+.2f}s" for l in lags))
    return ok


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mix_native")
    ap.add_argument("--takes", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--music")
    ap.add_argument("--floor")
    ap.add_argument("--foley")
    ap.add_argument("--speech-db", type=float, default=-18.0)
    ap.add_argument("--music-db", type=float, default=-37.0)
    ap.add_argument("--floor-db", type=float, default=-45.0)
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        src, wav, bounds = concat_takes(a.takes, Path(td))
        g = mix(src, wav, out, a.music, a.floor, a.foley, a.speech_db, a.music_db, a.floor_db)
        print(f"native bus gain {g:+.1f} dB -> {out}")
        ok = verify(src, out, wav, bounds)
    print("VERIFY:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
