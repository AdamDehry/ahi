#!/usr/bin/env python3
"""
avi-video-pipeline — character-consistent AI video shot generator.

Two modes:
  generate (default)  Run the full pipeline (or cached stages) for one shot.
  eval                Generate the same prompt across multiple motion engines
                      for side-by-side comparison.

Design principle: the pipeline SHAPE is fixed (face → outfit → fusion → motion).
Which model powers each stage is config-driven via models.yaml. Adding a new
model = adding an engine class here and a line in models.yaml.

Run: $HOME/ai/venvs/fal/bin/python generate_shot.py --help
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import yaml
import fal_client


# ─── Paths ──────────────────────────────────────────────────────────────────

SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = SKILL_DIR / "models.yaml"


# ─── Engine registry ────────────────────────────────────────────────────────
#
# Each engine is a callable that takes kwargs and returns a dict with at least
# a "url" field pointing at the generated artifact. Engines own knowledge of
# their fal.ai endpoint path and parameter shape.
#
# To add a new engine: write a function, register with @register("name", kind).

ENGINES: dict[str, dict[str, Callable]] = {"image": {}, "fusion": {}, "motion": {}}


def register(name: str, kind: str):
    def _wrap(fn):
        ENGINES[kind][name] = fn
        fn._engine_name = name
        fn._engine_kind = kind
        return fn
    return _wrap


def _subscribe(endpoint: str, arguments: dict, on_log: Callable | None = None) -> dict:
    """Thin wrapper over fal_client.subscribe with log streaming."""
    def _on_update(update):
        if on_log and hasattr(update, "logs") and update.logs:
            for log in update.logs:
                on_log(log.get("message", ""))
    return fal_client.subscribe(endpoint, arguments=arguments, with_logs=True, on_queue_update=_on_update)


# ─── Image engines (face + outfit) ──────────────────────────────────────────

@register("fal-flux-dev", "image")
def flux_dev(*, prompt: str, options: dict, on_log=None) -> dict:
    result = _subscribe("fal-ai/flux/dev", {"prompt": prompt, **options}, on_log)
    return {"url": result["images"][0]["url"], "seed": result.get("seed"), "meta": result}


@register("fal-flux-schnell", "image")
def flux_schnell(*, prompt: str, options: dict, on_log=None) -> dict:
    # Cheaper fallback; schnell doesn't accept guidance_scale / full inference_steps range.
    opts = {k: v for k, v in options.items() if k not in ("guidance_scale",)}
    opts.setdefault("num_inference_steps", 4)
    result = _subscribe("fal-ai/flux/schnell", {"prompt": prompt, **opts}, on_log)
    return {"url": result["images"][0]["url"], "seed": result.get("seed"), "meta": result}


# ─── Fusion engines ─────────────────────────────────────────────────────────

@register("fal-nano-banana-2-edit", "fusion")
def nano_banana_2_edit(*, prompt: str, image_urls: list[str], options: dict, on_log=None) -> dict:
    result = _subscribe(
        "fal-ai/nano-banana-2/edit",
        {"prompt": prompt, "image_urls": image_urls, **options},
        on_log,
    )
    return {"url": result["images"][0]["url"], "meta": result}


@register("fal-nano-banana-pro-edit", "fusion")
def nano_banana_pro_edit(*, prompt: str, image_urls: list[str], options: dict, on_log=None) -> dict:
    result = _subscribe(
        "fal-ai/nano-banana-pro/edit",
        {"prompt": prompt, "image_urls": image_urls, **options},
        on_log,
    )
    return {"url": result["images"][0]["url"], "meta": result}


# ─── Motion engines ─────────────────────────────────────────────────────────
#
# All motion engines share the same signature: they take a list of reference
# image URLs. The first URL is the primary reference (the master / "@Image1");
# additional URLs are OmniReference ingredients (character sheet, location,
# props, text graphics) that Seedance blends contextually.
#
# - img2vid can only use ONE frame — uses reference_urls[0] as image_url, warns on multi.
# - ref2vid variants pass the full list (up to 9 per fal.ai Seedance 2.0 spec).

def _seedance_args(prompt, options) -> dict:
    return {
        "prompt": prompt,
        "resolution": options.get("resolution", "720p"),
        "duration": str(options.get("duration", 10)),
        "aspect_ratio": options.get("aspect_ratio", "16:9"),
        "generate_audio": options.get("generate_audio", True),
    }


@register("seedance-img2vid", "motion")
def seedance_img2vid(*, prompt: str, reference_urls: list[str], options: dict, on_log=None) -> dict:
    """Image-to-video — strongest identity lock, master becomes frame 1. Single reference only."""
    if len(reference_urls) > 1 and on_log:
        on_log(f"NOTE: img2vid uses only the first reference ({len(reference_urls)-1} additional refs ignored)")
    args = _seedance_args(prompt, options)
    args["image_url"] = reference_urls[0]
    result = _subscribe("bytedance/seedance-2.0/fast/image-to-video", args, on_log)
    return {"url": result["video"]["url"], "seed": result.get("seed"), "meta": result}


@register("seedance-ref2vid-tagged", "motion")
def seedance_ref_tagged(*, prompt: str, reference_urls: list[str], options: dict, on_log=None) -> dict:
    """Reference-to-video with explicit @Image1 anchoring. Supports OmniReference (up to 9 refs).

    If the prompt doesn't already use @ImageN tags, prepends @Image1 to anchor the primary
    reference. Callers should use @Image2, @Image3, etc. to route additional references
    (character sheets, locations, props).
    """
    if "@Image" not in prompt:
        prompt = f"@Image1 {prompt}"
    args = _seedance_args(prompt, options)
    args["reference_image_urls"] = reference_urls[:9]  # fal.ai cap
    result = _subscribe("bytedance/seedance-2.0/fast/reference-to-video", args, on_log)
    return {"url": result["video"]["url"], "seed": result.get("seed"), "meta": result}


@register("seedance-ref2vid", "motion")
def seedance_ref(*, prompt: str, reference_urls: list[str], options: dict, on_log=None) -> dict:
    """Reference-to-video without anchoring — atmospheric match, character drifts.

    Included for evaluation and atmospheric B-roll only. Do not set as default.
    """
    args = _seedance_args(prompt, options)
    args["reference_image_urls"] = reference_urls[:9]
    result = _subscribe("bytedance/seedance-2.0/fast/reference-to-video", args, on_log)
    return {"url": result["video"]["url"], "seed": result.get("seed"), "meta": result}


# ─── IO helpers ─────────────────────────────────────────────────────────────

def download(url: str, dest: Path) -> int:
    with urllib.request.urlopen(url, timeout=180) as r:
        dest.write_bytes(r.read())
    return dest.stat().st_size


def slugify(text: str, max_len: int = 40) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return s[:max_len] or "shot"


def log(msg: str, indent: int = 0):
    print(f"{'  ' * indent}{msg}", flush=True)


# ─── Config loading ─────────────────────────────────────────────────────────

@dataclass
class Config:
    data: dict

    @classmethod
    def load(cls, path: Path) -> "Config":
        with open(path) as f:
            return cls(yaml.safe_load(f))

    def stage(self, name: str) -> dict:
        return self.data["stages"][name]

    @property
    def char_cache(self) -> Path:
        return Path(os.path.expanduser(os.path.expandvars(self.data["storage"]["character_cache"])))

    @property
    def generated_root(self) -> Path:
        return Path(os.path.expanduser(os.path.expandvars(self.data["storage"]["generated_root"])))

    @property
    def eval_root(self) -> Path:
        return Path(os.path.expanduser(os.path.expandvars(self.data["storage"]["eval_root"])))


# ─── Pipeline ───────────────────────────────────────────────────────────────

@dataclass
class CharacterAssets:
    name: str
    cache_dir: Path
    face_path: Path | None = None
    outfit_path: Path | None = None
    master_path: Path | None = None
    sheet_path: Path | None = None  # multi-pose OmniReference ingredient
    face_url: str | None = None
    outfit_url: str | None = None
    master_url: str | None = None
    sheet_url: str | None = None

    @classmethod
    def for_name(cls, name: str, cache_root: Path) -> "CharacterAssets":
        d = cache_root / name
        d.mkdir(parents=True, exist_ok=True)
        face = d / "face.jpg"
        outfit = d / "outfit.jpg"
        master = d / "master.jpg"
        sheet = d / "character-sheet.jpg"
        return cls(
            name=name,
            cache_dir=d,
            face_path=face if face.exists() else None,
            outfit_path=outfit if outfit.exists() else None,
            master_path=master if master.exists() else None,
            sheet_path=sheet if sheet.exists() else None,
        )

    def write_meta(self, meta: dict):
        (self.cache_dir / "meta.json").write_text(json.dumps(meta, indent=2))


# Default prompt for Stage 3b. Designed to produce a single image containing
# six poses of the same character — used as an OmniReference ingredient so
# Seedance has contextual understanding of the character across angles.
DEFAULT_CHARACTER_SHEET_PROMPT = (
    "Character sheet showing this person in six poses on neutral gray background — "
    "front, three-quarter, profile, action pose, close-up neutral expression, "
    "close-up determined expression. Consistent character across all poses. "
    "Preserve face, hair, outfit, and all identifying details exactly."
)


def upload_if_local(path: Path | None) -> str | None:
    if path and path.exists():
        return fal_client.upload_file(str(path))
    return None


def run_pipeline(
    *,
    cfg: Config,
    character_name: str,
    face_prompt: str | None,
    outfit_prompt: str | None,
    fusion_prompt: str | None,
    video_prompt: str,
    motion_engine_override: str | None,
    video_options_override: dict | None,
    output_dir: Path,
    extra_reference_paths: list[Path] | None = None,
    generate_character_sheet: bool = True,
    sheet_prompt: str | None = None,
) -> dict:
    """Run the four stages, reusing cached character assets when present.

    Returns a manifest dict describing every stage that ran.
    """
    chars = CharacterAssets.for_name(character_name, cfg.char_cache)
    manifest: dict[str, Any] = {
        "character": character_name,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "stages": {},
    }

    # Stage 1 — face
    if chars.face_path:
        log(f"[1/4] face: cached ({chars.face_path})")
        chars.face_url = fal_client.upload_file(str(chars.face_path))
        manifest["stages"]["face"] = {"cached": True, "path": str(chars.face_path)}
    else:
        if not face_prompt:
            raise SystemExit("ERROR: no cached face for character and --face-prompt not provided")
        stage = cfg.stage("face")
        log(f"[1/4] generating face via {stage['engine']}")
        t0 = time.time()
        engine = ENGINES["image"][stage["engine"]]
        r = engine(prompt=face_prompt, options=stage.get("options", {}), on_log=lambda m: log(f"  {m}", 1))
        chars.face_url = r["url"]
        chars.face_path = chars.cache_dir / "face.jpg"
        size = download(r["url"], chars.face_path)
        log(f"      saved {chars.face_path.name} ({size//1024} KB, {int(time.time()-t0)}s)")
        manifest["stages"]["face"] = {"cached": False, "engine": stage["engine"], "prompt": face_prompt, "url": r["url"], "path": str(chars.face_path)}

    # Stage 2 — outfit
    if chars.outfit_path:
        log(f"[2/4] outfit: cached ({chars.outfit_path})")
        chars.outfit_url = fal_client.upload_file(str(chars.outfit_path))
        manifest["stages"]["outfit"] = {"cached": True, "path": str(chars.outfit_path)}
    else:
        if not outfit_prompt:
            raise SystemExit("ERROR: no cached outfit for character and --outfit-prompt not provided")
        stage = cfg.stage("outfit")
        log(f"[2/4] generating outfit via {stage['engine']}")
        t0 = time.time()
        engine = ENGINES["image"][stage["engine"]]
        r = engine(prompt=outfit_prompt, options=stage.get("options", {}), on_log=lambda m: log(f"  {m}", 1))
        chars.outfit_url = r["url"]
        chars.outfit_path = chars.cache_dir / "outfit.jpg"
        size = download(r["url"], chars.outfit_path)
        log(f"      saved {chars.outfit_path.name} ({size//1024} KB, {int(time.time()-t0)}s)")
        manifest["stages"]["outfit"] = {"cached": False, "engine": stage["engine"], "prompt": outfit_prompt, "url": r["url"], "path": str(chars.outfit_path)}

    # Stage 3 — fusion
    if chars.master_path:
        log(f"[3/4] master: cached ({chars.master_path})")
        chars.master_url = fal_client.upload_file(str(chars.master_path))
        manifest["stages"]["master"] = {"cached": True, "path": str(chars.master_path)}
    else:
        if not fusion_prompt:
            raise SystemExit("ERROR: no cached master for character and --fusion-prompt not provided")
        stage = cfg.stage("fusion")
        log(f"[3/4] fusing face + outfit via {stage['engine']}")
        t0 = time.time()
        engine = ENGINES["fusion"][stage["engine"]]
        r = engine(
            prompt=fusion_prompt,
            image_urls=[chars.face_url, chars.outfit_url],
            options=stage.get("options", {}),
            on_log=lambda m: log(f"  {m}", 1),
        )
        chars.master_url = r["url"]
        chars.master_path = chars.cache_dir / "master.jpg"
        size = download(r["url"], chars.master_path)
        log(f"      saved {chars.master_path.name} ({size//1024} KB, {int(time.time()-t0)}s)")
        manifest["stages"]["master"] = {"cached": False, "engine": stage["engine"], "prompt": fusion_prompt, "url": r["url"], "path": str(chars.master_path)}

    # Stage 3b — character sheet (OmniReference ingredient, optional)
    if generate_character_sheet:
        if chars.sheet_path:
            log(f"[3b/4] character sheet: cached ({chars.sheet_path})")
            chars.sheet_url = fal_client.upload_file(str(chars.sheet_path))
            manifest["stages"]["character_sheet"] = {"cached": True, "path": str(chars.sheet_path)}
        else:
            stage = cfg.data["stages"].get("character_sheet", cfg.stage("fusion"))  # falls back to fusion config
            log(f"[3b/4] generating character sheet via {stage['engine']}")
            t0 = time.time()
            engine = ENGINES["fusion"][stage["engine"]]
            prompt_text = sheet_prompt or stage.get("prompt") or DEFAULT_CHARACTER_SHEET_PROMPT
            r = engine(
                prompt=prompt_text,
                image_urls=[chars.master_url],
                options=stage.get("options", {}),
                on_log=lambda m: log(f"  {m}", 1),
            )
            chars.sheet_url = r["url"]
            chars.sheet_path = chars.cache_dir / "character-sheet.jpg"
            size = download(r["url"], chars.sheet_path)
            log(f"      saved {chars.sheet_path.name} ({size//1024} KB, {int(time.time()-t0)}s)")
            manifest["stages"]["character_sheet"] = {"cached": False, "engine": stage["engine"], "prompt": prompt_text, "url": r["url"], "path": str(chars.sheet_path)}

    # Write character meta so future runs know which prompts/engines made this character
    chars.write_meta({
        "name": character_name,
        "face":   manifest["stages"].get("face"),
        "outfit": manifest["stages"].get("outfit"),
        "master": manifest["stages"].get("master"),
        "character_sheet": manifest["stages"].get("character_sheet"),
    })

    # Build the full reference list for motion: master first (always @Image1),
    # then character sheet (if generated), then any --references paths uploaded
    # by the caller. Order matters — Seedance routes via @Image1..N in order.
    reference_urls: list[str] = [chars.master_url]
    if chars.sheet_url:
        reference_urls.append(chars.sheet_url)
    extra_reference_urls: list[str] = []
    if extra_reference_paths:
        for p in extra_reference_paths:
            p = Path(p).expanduser()
            if not p.exists():
                raise SystemExit(f"ERROR: --references path not found: {p}")
            log(f"  uploading extra reference: {p.name}")
            url = fal_client.upload_file(str(p))
            extra_reference_urls.append(url)
            reference_urls.append(url)

    # Stage 4 — motion
    stage = cfg.stage("motion")
    engine_name = motion_engine_override or stage["engine"]
    options = {**stage.get("options", {}), **(video_options_override or {})}
    log(f"[4/4] generating video via {engine_name} ({len(reference_urls)} ref{'s' if len(reference_urls)>1 else ''}, duration={options.get('duration')}s, {options.get('resolution')})")
    t0 = time.time()
    engine = ENGINES["motion"][engine_name]
    r = engine(
        prompt=video_prompt,
        reference_urls=reference_urls,
        options=options,
        on_log=lambda m: log(f"  {m}", 1),
    )
    out_video = output_dir / "video.mp4"
    size = download(r["url"], out_video)
    log(f"      saved {out_video.name} ({size//1024} KB, {int(time.time()-t0)}s)")
    manifest["stages"]["video"] = {
        "engine": engine_name, "prompt": video_prompt, "options": options,
        "reference_urls": reference_urls,
        "extra_reference_paths": [str(p) for p in (extra_reference_paths or [])],
        "url": r["url"], "path": str(out_video), "seed": r.get("seed"),
    }
    manifest["character_dir"] = str(chars.cache_dir)

    return manifest


# ─── CLI ────────────────────────────────────────────────────────────────────

def _add_common_args(p: argparse.ArgumentParser):
    p.add_argument("--config", type=Path, default=DEFAULT_CONFIG, help=f"path to models.yaml (default: {DEFAULT_CONFIG})")
    p.add_argument("--character-name", required=True, help="unique identifier for this character (kebab-case)")
    p.add_argument("--face-prompt", help="Stage 1 prompt — required if no cached face exists for this character")
    p.add_argument("--outfit-prompt", help="Stage 2 prompt — required if no cached outfit exists")
    p.add_argument("--fusion-prompt", help="Stage 3 prompt — required if no cached master exists")
    p.add_argument("--sheet-prompt", help="Stage 3b prompt — overrides the default character-sheet prompt")
    p.add_argument("--skip-character-sheet", action="store_true", help="skip Stage 3b (no OmniReference sheet; motion gets master only)")
    p.add_argument("--references", nargs="*", type=Path, default=[], metavar="PATH", help="additional OmniReference ingredient paths (locations, props, text graphics, extra character views). Each gets uploaded and appended to reference list as @Image3..N. Max 9 refs total per Seedance spec.")
    p.add_argument("--video-prompt", required=True, help="Stage 4 prompt describing the shot. Use @Image1..N to route specific references.")
    p.add_argument("--duration", type=int, help="video duration in seconds (4-15, overrides config)")
    p.add_argument("--aspect-ratio", help="aspect ratio e.g. 16:9, 9:16, 21:9 (overrides config)")
    p.add_argument("--resolution", choices=["480p", "720p"], help="resolution (overrides config)")
    p.add_argument("--no-audio", action="store_true", help="disable audio generation")


def cmd_generate(args) -> int:
    cfg = Config.load(args.config)

    # Gather per-invocation overrides
    video_overrides = {}
    if args.duration is not None:     video_overrides["duration"] = args.duration
    if args.aspect_ratio:             video_overrides["aspect_ratio"] = args.aspect_ratio
    if args.resolution:               video_overrides["resolution"] = args.resolution
    if args.no_audio:                 video_overrides["generate_audio"] = False

    ts = datetime.now().strftime("%Y-%m-%d-%H%M")
    slug = slugify(args.video_prompt)
    output_dir = cfg.generated_root / f"{ts}-{args.character_name}-{slug}"
    output_dir.mkdir(parents=True, exist_ok=True)
    log(f"→ output: {output_dir}")

    manifest = run_pipeline(
        cfg=cfg,
        character_name=args.character_name,
        face_prompt=args.face_prompt,
        outfit_prompt=args.outfit_prompt,
        fusion_prompt=args.fusion_prompt,
        video_prompt=args.video_prompt,
        motion_engine_override=args.motion_engine,
        video_options_override=video_overrides,
        output_dir=output_dir,
        extra_reference_paths=list(args.references or []),
        generate_character_sheet=not args.skip_character_sheet,
        sheet_prompt=args.sheet_prompt,
    )
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    log(f"\n✓ complete — {output_dir / 'video.mp4'}")
    return 0


def cmd_eval(args) -> int:
    cfg = Config.load(args.config)
    engines = args.motion_engines
    for e in engines:
        if e not in ENGINES["motion"]:
            raise SystemExit(f"ERROR: unknown motion engine '{e}'. Known: {list(ENGINES['motion'])}")

    ts = datetime.now().strftime("%Y-%m-%d-%H%M")
    slug = slugify(args.video_prompt)
    base_dir = cfg.eval_root / f"{ts}-{args.character_name}-{slug}"
    base_dir.mkdir(parents=True, exist_ok=True)
    log(f"→ eval output: {base_dir}")
    log(f"→ engines under test: {', '.join(engines)}")

    video_overrides = {}
    if args.duration is not None:     video_overrides["duration"] = args.duration
    if args.aspect_ratio:             video_overrides["aspect_ratio"] = args.aspect_ratio
    if args.resolution:               video_overrides["resolution"] = args.resolution
    if args.no_audio:                 video_overrides["generate_audio"] = False

    results: list[dict] = []
    for engine in engines:
        engine_dir = base_dir / engine
        engine_dir.mkdir(exist_ok=True)
        log(f"\n═══ engine: {engine} ═══")
        try:
            manifest = run_pipeline(
                cfg=cfg,
                character_name=args.character_name,
                face_prompt=args.face_prompt,
                outfit_prompt=args.outfit_prompt,
                fusion_prompt=args.fusion_prompt,
                sheet_prompt=args.sheet_prompt,
                extra_reference_paths=list(args.references or []),
                generate_character_sheet=not args.skip_character_sheet,
                video_prompt=args.video_prompt,
                motion_engine_override=engine,
                video_options_override=video_overrides,
                output_dir=engine_dir,
            )
            (engine_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
            results.append({"engine": engine, "status": "ok", "video": str(engine_dir / "video.mp4")})
        except Exception as exc:
            log(f"engine {engine} failed: {exc}")
            results.append({"engine": engine, "status": "failed", "error": str(exc)})

    (base_dir / "eval-summary.json").write_text(json.dumps({
        "prompt": args.video_prompt,
        "character": args.character_name,
        "engines": engines,
        "results": results,
    }, indent=2))

    # README.md stub for human review notes
    readme = base_dir / "README.md"
    readme.write_text(
        f"# Eval: {args.character_name} — {slug}\n\n"
        f"**Prompt:** {args.video_prompt}\n\n"
        f"## Engines\n\n" +
        "\n".join(f"- `{r['engine']}` — {r['status']} — {r.get('video', '')}" for r in results) +
        "\n\n## Notes\n\n_Fill in after reviewing videos side-by-side._\n\n"
        "Criteria to consider: character consistency, prompt adherence, motion quality, audio quality, cost, time.\n"
        "If a winner emerges, update `models.yaml` and log the change in `CHANGELOG.md`.\n"
    )
    log(f"\n✓ eval complete — {base_dir}")
    return 0


def cmd_list_engines(_args) -> int:
    for kind in ("image", "fusion", "motion"):
        print(f"\n{kind.upper()}:")
        for name in ENGINES[kind]:
            fn = ENGINES[kind][name]
            doc = (fn.__doc__ or "").strip().split("\n")[0]
            print(f"  {name:<32} {doc}")
    return 0


def main(argv: list[str] | None = None) -> int:
    if not os.environ.get("FAL_KEY") and not os.environ.get("FAL_API_KEY"):
        print("ERROR: FAL_KEY / FAL_API_KEY not set. Export it from your secrets file first.", file=sys.stderr)
        return 1

    root = argparse.ArgumentParser(prog="generate_shot", description=__doc__.strip().split("\n")[0])
    sub = root.add_subparsers(dest="cmd")

    gen = sub.add_parser("generate", help="run the pipeline for one shot (default)")
    _add_common_args(gen)
    gen.add_argument("--motion-engine", help="override motion engine (e.g. seedance-img2vid, seedance-ref2vid-tagged)")
    gen.set_defaults(fn=cmd_generate)

    ev = sub.add_parser("eval", help="run the same shot through multiple motion engines")
    _add_common_args(ev)
    ev.add_argument("--motion-engines", nargs="+", required=True, help="engine names to compare")
    ev.set_defaults(fn=cmd_eval)

    li = sub.add_parser("list-engines", help="list all registered engines")
    li.set_defaults(fn=cmd_list_engines)

    # If no subcommand: default to generate
    parsed = root.parse_args(argv)
    if not parsed.cmd:
        # Re-parse with generate as the default
        parsed = root.parse_args(["generate", *(argv or sys.argv[1:])])

    return parsed.fn(parsed)


if __name__ == "__main__":
    sys.exit(main())
