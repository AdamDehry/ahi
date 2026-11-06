#!/usr/bin/env python3
"""fm_worktree_clean — drop regenerable output in the worktrees of CLOSED builds.

Removes node_modules, .next and dist (at the worktree root and one level down,
e.g. web/) from linked git worktrees whose every associated build is closed.
The worktree and its branch ALWAYS stay; this never runs `git worktree remove`
and never touches a ref. Dry run unless --apply.

A worktree is touched only if ALL of these hold — any doubt skips it:
  * it is a LINKED worktree (its .git is a file), not a main checkout;
  * it is not the live gateway tree or anything inside it;
  * at least one foreman build record claims it (workdir == worktree, or one
    contains the other), and every such build has a closing status event;
  * no tmux pane and no running process has its cwd inside it;
  * no component of its path is hidden (.x) or names evidence;
  * the target is a real directory (a symlink is unlinked, never followed)
    and git tracks nothing under it;
  * no enrolled redaction source is at or under the target (optional redactor,
    FM_REDACTOR_MJS — see fm_redaction_guard). With no redactor configured nothing
    is enrolled; with one configured whose table cannot be read, NOTHING is dropped.

Usage: fm_worktree_clean.py [--apply] [--root DIR ...] [--verbose]
  --root  where to look for worktrees (default: $FM_WORKTREES_DIR plus every root in
          FM_BUILD_ROOTS (colon-separated), plus every worktree registered with the
          gateway repo)
"""
import json
import os
import shutil
import stat
import subprocess
import sys
import time

from fm_redaction_guard import GuardError, enrolled_sources, protected_under

AHI_HOME = os.environ.get("FM_AHI_HOME") or os.environ.get("AHI_HOME") or os.path.expanduser("~/ahi")
FOREMAN = os.environ.get("FOREMAN_ROOT") or os.path.join(AHI_HOME, "foreman")
BUILDS_DIR = os.environ.get("BUILDS_DIR") or os.path.join(FOREMAN, "builds")
WORKTREES_DIR = os.environ.get("FM_WORKTREES_DIR") or os.path.join(AHI_HOME, "builds")
DEFAULT_ROOTS = [WORKTREES_DIR] + [r for r in os.environ.get("FM_BUILD_ROOTS", "").split(":") if r]
GATEWAY_REPO = os.environ.get("FM_GATEWAY_DIR") or os.path.join(AHI_HOME, "gateway")
# Live trees: never cleaned, nor anything inside them. FM_LIVE_TREES (colon-separated) adds
# other spellings/checkouts of the live tree; the gateway dir is always one.
LIVE = {os.path.realpath(p) for p in [GATEWAY_REPO] + os.environ.get("FM_LIVE_TREES", "").split(":")
        if p and os.path.exists(p)}
TARGETS = ("node_modules", ".next", "dist")
LOG = os.environ.get("FM_WORKTREE_CLEAN_LOG") or os.path.join(
    os.environ.get("FM_LOG_DIR") or os.path.join(AHI_HOME, "state", "logs"), "worktree-clean.log")


def under(path, root):
    return path == root or path.startswith(root.rstrip("/") + "/")


def build_status(events):
    status = "active"
    try:
        for line in open(events):
            e = json.loads(line)
            if e["type"].startswith("status:"):
                status = e["type"].split(":", 1)[1]
    except FileNotFoundError:
        status = "unknown"
    except ValueError:
        status = "unreadable"
    return status


def load_builds():
    out = []
    try:
        ids = sorted(os.listdir(BUILDS_DIR))
    except OSError:
        return out
    for bid in ids:
        meta = os.path.join(BUILDS_DIR, bid, "meta.json")
        try:
            wd = json.load(open(meta))["workdir"]
        except (OSError, ValueError, KeyError):
            continue
        out.append((bid, os.path.realpath(wd), build_status(os.path.join(BUILDS_DIR, bid, "events.jsonl"))))
    return out


def find_worktrees(roots):
    found = set()
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            depth = dirpath[len(root):].count("/")
            if ".git" in filenames:            # a .git FILE = linked worktree
                found.add(os.path.realpath(dirpath))
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git", ".next", "dist")]
            if depth >= 3:
                dirnames[:] = []
    try:
        porcelain = subprocess.run(["git", "-C", GATEWAY_REPO, "worktree", "list", "--porcelain"],
                                   capture_output=True, text=True, check=True).stdout
        for line in porcelain.splitlines():
            if line.startswith("worktree "):
                p = os.path.realpath(line[9:])
                if os.path.isfile(os.path.join(p, ".git")):
                    found.add(p)
    except (OSError, subprocess.CalledProcessError):
        pass
    return sorted(found)


def live_cwds():
    cwds = set()
    try:
        out = subprocess.run(["tmux", "list-panes", "-a", "-F", "#{pane_current_path}"],
                             capture_output=True, text=True).stdout
        cwds.update(os.path.realpath(l) for l in out.splitlines() if l)
    except OSError:
        pass
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                cwds.add(os.path.realpath(os.readlink(f"/proc/{pid}/cwd")))
            except OSError:
                pass
    return cwds


def tracked(wt, rel):
    out = subprocess.run(["git", "-C", wt, "ls-files", "--", rel], capture_output=True, text=True)
    return out.returncode != 0 or bool(out.stdout.strip())  # error counts as tracked: skip


def targets(wt):
    cands = [n for n in TARGETS]
    for d in sorted(os.listdir(wt)):
        if d.startswith(".") or d in TARGETS or not os.path.isdir(os.path.join(wt, d)) \
                or os.path.islink(os.path.join(wt, d)):
            continue
        cands += [f"{d}/{n}" for n in TARGETS]
    return [c for c in cands if os.path.lexists(os.path.join(wt, c))]


def du_k(path):
    out = subprocess.run(["du", "-sk", path], capture_output=True, text=True).stdout.split()
    return int(out[0]) if out else 0


def remove(path):
    if os.path.islink(path) or not os.path.isdir(path):
        os.unlink(path)
        return
    for dirpath, _, _ in os.walk(path, followlinks=False):   # hardlinked cache files are a-w,
        os.chmod(dirpath, stat.S_IMODE(os.lstat(dirpath).st_mode) | 0o200)  # their dirs are not
    shutil.rmtree(path)


def main(argv):
    apply = "--apply" in argv
    verbose = "--verbose" in argv
    roots = [argv[i + 1] for i, a in enumerate(argv) if a == "--root"] or DEFAULT_ROOTS
    builds = load_builds()
    roots_real = [os.path.realpath(r) for r in roots]
    cwds = live_cwds()
    freed = 0
    print(f"fm_worktree_clean: {'APPLY' if apply else 'dry run'} — {len(builds)} build records")
    # Never drop a path that holds an enrolled redaction source: deleting one makes every
    # ingest fail closed until the enrollment registry is repaired.
    try:
        sources, guard_err = enrolled_sources(), None
    except GuardError as e:
        sources, guard_err = [], str(e)
        print(f"fm_worktree_clean: REFUSING ALL — redaction-source guard unavailable: {guard_err}")
    for wt in find_worktrees(roots):
        # ASYMMETRIC on purpose. Any open build whose workdir overlaps the worktree, however
        # broad (a build may have run with workdir=$AHI_HOME), BLOCKS it. Only a precise
        # workdir can CERTIFY it closed: the worktree itself, a dir inside it, or a dedicated
        # build dir under a builds root that contains it (builds/<name> -> builds/<name>/<repo>).
        overlap = [(b, s) for b, wd, s in builds if under(wd, wt) or under(wt, wd)]
        claims = [(b, s) for b, wd, s in builds
                  if under(wd, wt) or (under(wt, wd) and any(under(wd, r) and wd != r for r in roots_real))]
        openb = [b for b, s in overlap if s in ("active", "unknown", "unreadable")]
        why = None
        rel = next((wt[len(r):] for r in roots_real if under(wt, r)), wt)
        if any(under(wt, l) or under(l, wt) for l in LIVE):
            why = "live gateway tree"
        elif any(c.startswith(".") or "evidence" in c.lower() for c in rel.split("/") if c):
            why = "evidence or hidden path — preserved as is"
        elif openb:
            why = "open build: " + ",".join(openb)
        elif not claims:
            why = "no build record claims it precisely"
        elif any(under(c, wt) for c in cwds):
            why = "a live process or tmux pane is inside it"
        elif guard_err:
            why = "redaction-source guard unavailable"
        tg = [] if why else [t for t in targets(wt) if not tracked(wt, t)]
        for t in list(tg):
            hits = protected_under(os.path.join(wt, t), sources)
            if hits:
                tg.remove(t)
                print(f"  REFUSE  {os.path.join(wt, t)}  (holds enrolled redaction source "
                      f"{', '.join(i for i, _ in hits)} — retire it first)")
        if why or not tg:
            if verbose:
                print(f"  skip  {wt}  ({why or 'nothing to drop'})")
            continue
        for t in tg:
            p = os.path.join(wt, t)
            kb = du_k(p)
            print(f"  {'drop' if apply else 'would drop'}  {p}  ({kb // 1024} MB by du; shared hardlinks free less)")
            if apply:
                remove(p)
                freed += kb
                os.makedirs(os.path.dirname(LOG), exist_ok=True)
                with open(LOG, "a") as f:
                    f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} rm {p} ({kb}KB) "
                            f"builds={','.join(b + ':' + s for b, s in claims)}\n")
    if apply:
        print(f"fm_worktree_clean: dropped ~{freed // 1024} MB by du (check df for the real figure)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
