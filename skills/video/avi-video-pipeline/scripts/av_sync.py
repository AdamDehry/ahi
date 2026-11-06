#!/usr/bin/env python3
"""Audio-to-mouth sync, measured on one delivered file.

Combines the two September instruments from the David series:
  - sync_probe.py's voiced-speech envelope (autocorrelation f0 gate, so foley and
    ambience do not read as speech), and
  - mouth_probe.py's lower-face / brow motion ratio (camera push-ins cancel out).

For a dub, the audio and the mouth were made by different processes and the numbers
below say how far apart they are. For native audio they were made together, and the
numbers say whether that held. Same instrument for both, so before/after is fair.

Reports:
  lag        cross-correlation of the two envelopes, +/-1.0s window.
             Positive = audio is LATE relative to the mouth.
  voice->mouth  share of voiced time during which the mouth is moving.
             Low = "speech over closed lips".
  mouth->voice  share of mouth-moving time that has voice under it.
             Low = "mouth flapping in silence".

Usage: av_sync.py <video.mp4> [label] [--audio other.wav] [--from S] [--to S]
"""
import argparse
import subprocess
import sys

import numpy as np

SR, HOP, WIN = 16000, 0.010, 0.040
F0_LO, F0_HI = 70, 320
W, H, FPS = 180, 320, 24


def load_audio(path, t0, t1):
    cmd = ["ffmpeg", "-v", "error", "-ss", str(t0)] + (["-to", str(t1)] if t1 else []) + \
          ["-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, "<i2").astype(np.float64) / 32768.0


def voiced_envelope(x):
    hop, win = int(HOP * SR), int(WIN * SR)
    lo, hi = SR // F0_HI, SR // F0_LO
    n = max(0, (len(x) - win) // hop + 1)
    energy, period = np.zeros(n), np.zeros(n)
    for i in range(n):
        fr = x[i * hop: i * hop + win]
        fr = fr - fr.mean()
        e = np.sqrt((fr ** 2).mean())
        energy[i] = e
        if e < 1e-4:
            continue
        ac = np.correlate(fr, fr, mode="full")[win - 1:]
        if ac[0] <= 0:
            continue
        period[i] = (ac / ac[0])[lo:hi].max()
    edb = 20 * np.log10(np.maximum(energy, 1e-6))
    egate = np.clip((edb - edb.max() + 35) / 35, 0, 1)
    env = np.clip(period, 0, 1) * egate
    pad = np.pad(env, (2, 2), mode="edge")
    return np.array([np.median(pad[i:i + 5]) for i in range(len(env))])


def load_frames(path, t0, t1):
    cmd = ["ffmpeg", "-v", "error", "-ss", str(t0)] + (["-to", str(t1)] if t1 else []) + \
          ["-i", path, "-vf", f"scale={W}:{H},fps={FPS}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(raw) // (W * H * 3)
    return np.frombuffer(raw, np.uint8)[:n * W * H * 3].reshape(n, H, W, 3).astype(np.float32)


def face_box(f):
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    m = (r > 80) & (g > 40) & (b > 20) & ((f.max(2) - f.min(2)) > 12) & (r > g + 12) & (g > b - 5)
    if m.sum() < 150:
        return None
    rows, cols = m.sum(1), m.sum(0)
    ry = np.where(rows > max(3, rows.max() * 0.25))[0]
    cx = np.where(cols > max(3, cols.max() * 0.25))[0]
    if len(ry) < 4 or len(cx) < 4:
        return None
    y0, y1 = ry[0], ry[0] + int((ry[-1] - ry[0]) * 0.55)
    return y0, y1, cx[0], cx[-1]


def mouth_envelope(F):
    gray = F.mean(3)
    ratio = np.zeros(len(F) - 1)
    for i in range(len(F) - 1):
        bb = face_box(F[i])
        if bb is None:
            continue
        y0, y1, x0, x1 = bb
        h = y1 - y0
        if h < 12 or (x1 - x0) < 8:
            continue
        d = np.abs(gray[i + 1] - gray[i])
        up = d[y0 + int(h * .20):y0 + int(h * .50), x0:x1].mean()
        lo = d[y0 + int(h * .55):y1, x0:x1].mean()
        ratio[i] = lo / (up + 1e-3)
    pad = np.pad(ratio, (3, 3), mode="edge")
    sm = np.array([np.median(pad[i:i + 7]) for i in range(len(ratio))])
    # resample 24fps -> 100Hz to match the audio envelope
    t_src = np.arange(len(sm)) / FPS
    t_dst = np.arange(0, t_src[-1] if len(t_src) else 0, HOP)
    return np.interp(t_dst, t_src, sm), sm


def mouth_open_landmarks(path, t0, t1):
    """Inner-lip gap / face height per frame via MediaPipe FaceMesh (landmarks 13/14 over
    10/152). An absolute measure of openness, so unlike the motion ratio it is not capped
    by a percentile threshold and it ignores body and camera motion entirely.
    Returns (100Hz envelope, detection rate)."""
    import mediapipe as mp
    hi_w, hi_h = 720, 1280
    cmd = ["ffmpeg", "-v", "error", "-ss", str(t0)] + (["-to", str(t1)] if t1 else []) + \
          ["-i", path, "-vf", f"scale={hi_w}:{hi_h},fps={FPS}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(raw) // (hi_w * hi_h * 3)
    F = np.frombuffer(raw, np.uint8)[:n * hi_w * hi_h * 3].reshape(n, hi_h, hi_w, 3)
    sx, sy = hi_w / W, hi_h / H
    op = np.full(n, np.nan)
    last = None
    with mp.solutions.face_mesh.FaceMesh(static_image_mode=True, max_num_faces=1,
                                         refine_landmarks=False, min_detection_confidence=0.3) as fm:
        for i in range(n):
            # locate the head on a small copy (Sept skin-mask locator), crop it at full res
            small = F[i][::int(sy), ::int(sx)].astype(np.float32)
            bb = face_box(small) or last
            if bb is None:
                continue
            last = bb
            y0, y1, x0, x1 = bb
            cx, cy = (x0 + x1) / 2 * sx, (y0 + y1) / 2 * sy
            half = max((x1 - x0) * sx, (y1 - y0) * sy) * 0.9 + 24
            X0, X1 = int(max(0, cx - half)), int(min(hi_w, cx + half))
            Y0, Y1 = int(max(0, cy - half)), int(min(hi_h, cy + half))
            crop = np.ascontiguousarray(F[i][Y0:Y1, X0:X1])
            if crop.shape[0] < 16 or crop.shape[1] < 16:
                continue
            k = max(1, int(np.ceil(256 / crop.shape[0])))
            crop = np.ascontiguousarray(crop.repeat(k, 0).repeat(k, 1))
            r = fm.process(crop)
            if not r.multi_face_landmarks:
                continue
            p = r.multi_face_landmarks[0].landmark
            ar = crop.shape[0] / crop.shape[1]
            gap = np.hypot(p[13].x - p[14].x, (p[13].y - p[14].y) * ar)
            face = np.hypot(p[10].x - p[152].x, (p[10].y - p[152].y) * ar)
            op[i] = gap / max(face, 1e-6)
    det = float(np.isfinite(op).mean()) if n else 0.0
    # nearest-frame resample to 100Hz; frames with no face stay NaN and are excluded
    t_dst = np.arange(0, (n - 1) / FPS if n else 0, HOP)
    return op[np.minimum((t_dst * FPS).round().astype(int), max(n - 1, 0))], det


def spans(on, step, min_len=0.15, join=0.25):
    out, i = [], 0
    while i < len(on):
        if on[i]:
            j = i
            while j < len(on) and on[j]:
                j += 1
            out.append([i * step, j * step])
            i = j
        else:
            i += 1
    merged = []
    for s in out:
        if merged and s[0] - merged[-1][1] < join:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    return [s for s in merged if s[1] - s[0] >= min_len]


def best_lag(a, b, max_lag_s=1.0):
    n = int(max_lag_s / HOP)
    L = min(len(a), len(b))
    a, b = a[:L], b[:L]
    a = (a - a.mean()) / (a.std() + 1e-9)
    b = (b - b.mean()) / (b.std() + 1e-9)
    best, bl = -1e9, 0
    for lag in range(-n, n + 1):
        if lag >= 0:
            s = float((a[:L - lag] * b[lag:]).mean()) if lag < L else -1e9
        else:
            s = float((a[-lag:] * b[:L + lag]).mean())
        if s > best:
            best, bl = s, lag
    return bl * HOP, best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("label", nargs="?", default="")
    ap.add_argument("--audio", help="measure this audio against the video's mouth instead")
    ap.add_argument("--from", dest="t0", type=float, default=0.0)
    ap.add_argument("--to", dest="t1", type=float, default=None)
    ap.add_argument("--method", choices=["auto", "landmarks", "motion"], default="auto",
                    help="landmarks = MediaPipe lip gap (needs the avsync venv); motion = Sept probe")
    ap.add_argument("--open", type=float, default=0.035,
                    help="lip gap / face height above which the mouth counts as open")
    a = ap.parse_args()

    voice = voiced_envelope(load_audio(a.audio or a.video, a.t0, a.t1))
    method = a.method
    if method == "auto":
        try:
            import mediapipe  # noqa: F401
            method = "landmarks"
        except ImportError:
            method = "motion"
    det = None
    if method == "landmarks":
        mouth, det = mouth_open_landmarks(a.video, a.t0, a.t1)
        thr = a.open
    else:
        # motion ratio; NOTE its percentile threshold caps 'active' at ~45% of frames,
        # so on dense dialogue it under-reads. Prefer landmarks.
        mouth, mouth_raw = mouth_envelope(load_frames(a.video, a.t0, a.t1))
        pos = mouth_raw[mouth_raw > 0]
        thr = max(1.35, float(np.percentile(pos, 55))) if pos.size else 1.35
    L = min(len(voice), len(mouth))
    voice, mouth = voice[:L], mouth[:L]

    valid = np.isfinite(mouth)
    if not valid.all():
        mouth = np.where(valid, mouth, np.nanmedian(mouth) if valid.any() else 0.0)
    v_on = voice > 0.30
    m_on = mouth > thr

    lag, score = best_lag(mouth, voice)
    # coverage is scored only on frames where the mouth was actually measured
    vv, mm = v_on & valid, m_on & valid
    v2m = (vv & mm).sum() / max(1, vv.sum())
    m2v = (vv & mm).sum() / max(1, mm.sum())
    sil_open = (mm & ~vv & valid).sum() / max(1, (~v_on & valid).sum())

    print(f"--- {a.label or a.video} ---  method={method}"
          + (f"  face found in {det:.0%} of frames" if det is not None else ""))
    print(f"  voiced spans : {[f'{x + a.t0:.2f}-{y + a.t0:.2f}' for x, y in spans(v_on, HOP)]}")
    print(f"  mouth spans  : {[f'{x + a.t0:.2f}-{y + a.t0:.2f}' for x, y in spans(m_on, HOP)]}")
    print(f"  speech       : {v_on.sum() * HOP:.2f}s of {L * HOP:.2f}s")
    print(f"  lag          : {lag:+.2f}s (audio late if +)  xcorr={score:.3f}")
    print(f"  voice->mouth : {v2m:.0%}   mouth->voice : {m2v:.0%}   open-in-silence : {sil_open:.0%}"
          f"   (scored on {valid.mean():.0%} of the clip)")


if __name__ == "__main__":
    sys.exit(main())
