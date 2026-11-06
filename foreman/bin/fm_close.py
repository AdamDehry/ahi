#!/usr/bin/env python3
"""fm_close — the end of a build's life: archive its keepers, VERIFY the archive,
THEN remove its worktree. Once the owner has given the OK and the change is
shipped, the build copy should not linger on the machine — but nothing leaves
the disk until a read-back proves it is safe somewhere else.

    fm_close.py clean <build-id> [--apply] [--finished] [--json]
        Step 2 for ONE build. --finished: the build was just shipped through
        build_finish.sh, so the age grace does not apply (the merge check does).
    fm_close.py sweep [--apply] [--alert] [--root DIR ...] [--json] [--markdown FILE]
        Every worktree under the builds roots: archive+remove the ones that are
        closed and merged (or abandoned/failed > 7 days and safe), hold the rest
        with a reason, and list for Michael what only he can decide. Dry run
        unless --apply. --alert: the Michael list goes to the gateway's review
        desk as ONE soft alert (repeats collapse), resolved when it empties —
        optional, skipped with a note when no review CLI is configured.
    fm_close.py assess <path> [--json]
        The decision for one worktree path, nothing else.

Nothing is ever deleted unless ALL of these hold — any doubt holds it:
  * a LINKED git worktree (.git is a file) under a builds root, not the live
    gateway tree. A .git DIRECTORY is a standalone clone that may host other
    worktrees: listed, never touched.
  * every ledger build that claims it is closed (done/failed/abandoned), and no
    open build's workdir overlaps it;
  * no `.keep`, no tmux pane or process cwd inside, no enrolled redaction
    source (fm_redaction_guard; a configured redactor whose table is
    unreadable holds everything);
  * no uncommitted tracked change, no submodule; the branch tip is merged into
    the mainline, or (failed/abandoned only) already on a remote. Unpushed
    commits on an unmerged branch hold it;
  * the archive — every untracked file that is not regenerable, the named
    keepers, the brief and the ledger — is written AND read back and matches
    the manifest. A failed or unverified archive deletes nothing.
  * right before removal the tree is re-read: same HEAD, still clean, no file
    that is not in the archive. Then `git worktree remove --force` (the force is
    for the untracked files just archived) and the branch ref is deleted only
    if it still points at the merged tip. Never rm -rf.

Archive backends (pluggable):
  local (default)  $FM_ARCHIVE_ROOT/<build-id>/archive.tar.gz + MANIFEST.json
                   (FM_ARCHIVE_ROOT default $AHI_HOME/state/build-archive). Verified
                   by reading the tarball back: every file present, same size and
                   sha256, symlinks intact, MANIFEST.json byte-identical. Only then
                   is the staging copy dropped.
  restic           when FM_RESTIC_REPO is set (+ FM_RESTIC_PASSWORD_FILE, a path that
                   is passed to restic and never read here; FM_RESTIC_BIN, default
                   `restic` on PATH). Verified by listing the snapshot and dumping
                   MANIFEST.json back byte-identical.

Builds roots: $FM_WORKTREES_DIR plus every root in FM_BUILD_ROOTS (colon-separated);
FM_CLOSE_ROOTS replaces the whole list. Only $FM_WORKTREES_DIR is checked for non-git
leftovers by default (FM_CLOSE_RESIDUE_ROOTS) — an extra root may hold project material.

Secret-shaped files (.env*, keys, credential json) never enter the archive:
they are copied to $FM_SECRETS_ARCHIVE/<date>/<build>/ (dirs 0700, files 0600;
default $AHI_HOME/state/build-archive-secrets) and only their count is printed.
"""
import fnmatch
import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import time

BIN = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BIN)
from fm_redaction_guard import GuardError, enrolled_sources, protected_under  # noqa: E402

def _env(name, default):
    return os.environ.get(name) or default


AHI_HOME = _env("FM_AHI_HOME", _env("AHI_HOME", os.path.expanduser("~/ahi")))
FOREMAN = _env("FOREMAN_ROOT", os.path.join(AHI_HOME, "foreman"))
BUILDS_DIR = _env("BUILDS_DIR", os.path.join(FOREMAN, "builds"))
GATEWAY_DIR = _env("FM_GATEWAY_DIR", os.path.join(AHI_HOME, "gateway"))
WORKTREES_DIR = _env("FM_WORKTREES_DIR", os.path.join(AHI_HOME, "builds"))
LOG_DIR = _env("FM_LOG_DIR", os.path.join(AHI_HOME, "state", "logs"))
STATE_DIR = _env("FM_STATE_DIR", os.path.join(AHI_HOME, "state", "foreman"))
DEFAULT_ROOTS = [WORKTREES_DIR] + [r for r in os.environ.get("FM_BUILD_ROOTS", "").split(":") if r]
ROOTS = [r for r in _env("FM_CLOSE_ROOTS", ":".join(DEFAULT_ROOTS)).split(":") if r]
ARCHIVE_ROOT = _env("FM_ARCHIVE_ROOT", os.path.join(AHI_HOME, "state", "build-archive"))
SECRETS_ROOT = _env("FM_SECRETS_ARCHIVE", os.path.join(AHI_HOME, "state", "build-archive-secrets"))
# Optional restic backend. Only the repository and the password-file PATH are handed to
# restic; this script never opens the password file. Snapshots are tagged build-archive and
# build:<id>: if the repo is shared with a scheduled backup, scope that job's `forget` to its
# own tag so build archives are never expired by it.
RESTIC_REPO = os.environ.get("FM_RESTIC_REPO", "")
RESTIC_PASSWORD_FILE = os.environ.get("FM_RESTIC_PASSWORD_FILE", "")
RESTIC = _env("FM_RESTIC_BIN", shutil.which("restic") or "restic")
BACKEND = "restic" if RESTIC_REPO else "local"
# Roots that only ever hold build copies — the only ones whose non-git folders are reported as
# leftovers (an extra builds root may also hold project material that is not a build).
RESIDUE_ROOTS = [r for r in _env("FM_CLOSE_RESIDUE_ROOTS", WORKTREES_DIR).split(":") if r]
LOG = _env("FM_CLOSE_LOG", os.path.join(LOG_DIR, "build-archive.log"))
TIMELINE_DIR = _env("FM_TIMELINE_DIR", os.path.join(STATE_DIR, "timeline"))
REVIEW_MJS = _env("FM_REVIEW_MJS", os.path.join(GATEWAY_DIR, "scripts", "review.mjs"))
# Live trees are never assessed for removal, nor anything inside or around them.
LIVE = {os.path.realpath(p) for p in _env("FM_LIVE_TREES", GATEWAY_DIR).split(":") if p and os.path.exists(p)}
MAX_ARCHIVE_MB = int(os.environ.get("FM_ARCHIVE_MAX_MB", "1024"))
DAY = 86400
GRACE_MERGED = int(os.environ.get("FM_CLOSE_GRACE_MERGED_S", str(2 * DAY)))
GRACE_FAILED = 7 * DAY
LIST_UNMERGED = 14 * DAY
CLOSED = ("done", "failed", "abandoned")
REGENERABLE = {"node_modules", ".next", "dist", ".cache", "__pycache__", ".turbo", "coverage",
               ".venv", "venv", ".pytest_cache", ".parcel-cache", ".svelte-kit", ".vite", ".nyc_output"}
# Regenerable only under a parent: Vercel's build output and cache (`vercel build` remakes them).
REGENERABLE_UNDER = {(".vercel", "output"), (".vercel", "cache")}
KEEPER_GLOBS = ["REPORT*", "BUILD-NOTES*", "evidence", "screenshots", "codex-review", ".foreman"]
SECRET_RE = re.compile(r"^(\.env(\..+)?|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|ed25519|ecdsa)(\..*)?|"
                       r"credentials.*\.json|.*secret.*|\.npmrc|\.netrc|.*\.pass)$", re.I)
NOT_SECRET = re.compile(r"^\.env\.(example|sample|template|defaults)$", re.I)


# ── small helpers ──────────────────────────────────────────────────────────

def regenerable(rel):
    parts = rel.split("/")
    return any(p in REGENERABLE for p in parts) or any(pair in REGENERABLE_UNDER for pair in zip(parts, parts[1:]))


def under(path, root):
    return path == root or path.startswith(root.rstrip("/") + "/")


def git(wt, *args, check=False):
    r = subprocess.run(["git", "-C", wt, *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()[:200]}")
    return r


def ok(wt, *args):
    return git(wt, *args).returncode == 0


def out(wt, *args):
    r = git(wt, *args)
    return r.stdout.strip() if r.returncode == 0 else ""


def log(line):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {line}\n")
    except OSError:
        pass


def ledger_event(build, etype, detail):
    path = os.path.join(BUILDS_DIR, build, "events.jsonl")
    if os.path.isdir(os.path.dirname(path)):
        with open(path, "a") as f:
            f.write(json.dumps({"ts": int(time.time()), "type": etype, "detail": detail}) + "\n")


def is_secret(rel):
    parts = rel.split("/")
    if any(p in (".secrets", "secrets") for p in parts[:-1]):
        return True
    return bool(SECRET_RE.match(parts[-1])) and not NOT_SECRET.match(parts[-1])


def sha256_stream(fobj):
    h = hashlib.sha256()
    for chunk in iter(lambda: fobj.read(1 << 20), b""):
        h.update(chunk)
    return h.hexdigest()


def sha256(path):
    with open(path, "rb") as f:
        return sha256_stream(f)


# ── the ledger ─────────────────────────────────────────────────────────────

def read_build(bid):
    d = os.path.join(BUILDS_DIR, bid)
    try:
        meta = json.load(open(os.path.join(d, "meta.json")))
    except (OSError, ValueError):
        return None
    status, closed_at, finished, brief = "active", None, None, None
    try:
        for line in open(os.path.join(d, "events.jsonl")):
            try:
                e = json.loads(line)
            except ValueError:
                continue
            t = e.get("type", "")
            if t.startswith("status:"):
                status = t.split(":", 1)[1]
                closed_at = e.get("ts") if status in CLOSED else None
            elif t == "finished":
                finished = e.get("detail")
            elif t == "brief" and "path=" in (e.get("detail") or ""):
                brief = e["detail"].split("path=", 1)[1].split()[0]
    except FileNotFoundError:
        status = "unknown"
    wd = meta.get("workdir") or ""
    return {"id": bid, "workdir": os.path.realpath(wd) if wd else "", "status": status,
            "closed_at": closed_at, "finished": finished, "brief": brief, "name": meta.get("name", bid)}


def load_builds():
    try:
        ids = sorted(os.listdir(BUILDS_DIR))
    except OSError:
        return []
    return [b for b in (read_build(i) for i in ids) if b and b["workdir"]]


# ── the live world ─────────────────────────────────────────────────────────

def live_cwds():
    cwds = set()
    try:
        r = subprocess.run(["tmux", "list-panes", "-a", "-F", "#{pane_current_path}"], capture_output=True, text=True)
        cwds.update(os.path.realpath(l) for l in r.stdout.splitlines() if l)
    except OSError:
        pass
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                cwds.add(os.path.realpath(os.readlink(f"/proc/{pid}/cwd")))
            except OSError:
                pass
    return cwds


def find_git_dirs(roots):
    """(path, 'worktree'|'clone') for every git top under the roots, depth <= 3."""
    found = {}
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            depth = dirpath[len(root):].count("/")
            if ".git" in filenames or ".git" in dirnames:
                found[os.path.realpath(dirpath)] = "worktree" if ".git" in filenames else "clone"
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames if d not in REGENERABLE and not d.startswith(".")]
            if depth >= 2:
                dirnames[:] = []
    return sorted(found.items())


# ── git facts about one worktree ───────────────────────────────────────────

def mainline_refs(wt):
    refs = []
    head = out(wt, "symbolic-ref", "-q", "refs/remotes/origin/HEAD")
    if head:
        refs.append(head)
    for r in ("refs/heads/main", "refs/heads/master", "refs/remotes/origin/main", "refs/remotes/origin/master"):
        if r not in refs and ok(wt, "show-ref", "--verify", "--quiet", r):
            refs.append(r)
    return refs


def git_facts(wt):
    f = {"head": out(wt, "rev-parse", "HEAD"), "branch": out(wt, "symbolic-ref", "-q", "--short", "HEAD") or None}
    common = out(wt, "rev-parse", "--path-format=absolute", "--git-common-dir")
    f["common_dir"] = os.path.realpath(common) if common else ""
    f["main_repo"] = os.path.dirname(f["common_dir"]) if f["common_dir"].endswith("/.git") else f["common_dir"]
    f["dirty"] = out(wt, "status", "--porcelain", "--untracked-files=no")
    f["submodules"] = os.path.exists(os.path.join(wt, ".gitmodules"))
    refs = mainline_refs(wt)
    f["mainline"] = next((r for r in refs if f["head"] and ok(wt, "merge-base", "--is-ancestor", f["head"], r)), None)
    f["mainline_refs"] = refs
    f["merged"] = f["mainline"] is not None
    f["on_remote"] = bool(f["head"]) and bool(out(wt, "branch", "-r", "--contains", f["head"]))
    return f


def untracked(wt):
    """Files git does not hold, split into (keep, regenerable_dirs). Ignored dirs are collapsed."""
    keep, regen = [], []
    for args in (["ls-files", "--others", "--exclude-standard", "-z"],
                 ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]):
        r = subprocess.run(["git", "-C", wt, *args], capture_output=True)
        if r.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)} failed")
        for rel in r.stdout.decode(errors="surrogateescape").split("\0"):
            rel = rel.rstrip("/")
            if not rel:
                continue
            if regenerable(rel):
                regen.append(rel)
                continue
            full = os.path.join(wt, rel)
            if os.path.isdir(full) and not os.path.islink(full):
                for dp, dn, fn in os.walk(full):
                    dn[:] = [d for d in dn if not regenerable(os.path.relpath(os.path.join(dp, d), wt))]
                    for n in fn:
                        keep.append(os.path.relpath(os.path.join(dp, n), wt))
                    for d in list(dn):
                        if os.path.islink(os.path.join(dp, d)):
                            keep.append(os.path.relpath(os.path.join(dp, d), wt))
            else:
                keep.append(rel)
    return sorted(set(keep)), sorted(set(regen))


def named_keepers(wt):
    found = []
    for pat in KEEPER_GLOBS:
        for name in fnmatch.filter(os.listdir(wt), pat):
            p = os.path.join(wt, name)
            if os.path.isdir(p) and not os.path.islink(p):
                for dp, dn, fn in os.walk(p):
                    dn[:] = [d for d in dn if d not in REGENERABLE]
                    found += [os.path.relpath(os.path.join(dp, n), wt) for n in fn]
            elif os.path.lexists(p):
                found.append(name)
    return found


def tree_bytes(path):
    """(du-style bytes, bytes only this tree holds — files with one link)."""
    total = own = 0
    for dp, dn, fn in os.walk(path):
        for n in dn + fn:
            try:
                st = os.lstat(os.path.join(dp, n))
            except OSError:
                continue
            b = st.st_blocks * 512
            total += b
            if stat.S_ISDIR(st.st_mode) or st.st_nlink == 1:
                own += b
    return total, own


# ── the decision ───────────────────────────────────────────────────────────

class Ctx:
    def __init__(self, roots=None, need_cwds=True):
        self.roots = [os.path.realpath(r) for r in (roots or ROOTS)]
        self.builds = load_builds()
        self.cwds = live_cwds() if need_cwds else set()
        self.now = time.time()
        try:
            self.sources, self.guard_err = enrolled_sources(), None
        except GuardError as e:
            self.sources, self.guard_err = [], str(e)


def assess(wt, ctx, finished=False):
    """One worktree → {decision: remove|hold, reasons, …}. finished: build_finish's path (no age grace)."""
    wt = os.path.realpath(wt)
    a = {"path": wt, "decision": "hold", "reasons": [], "list_for_michael": None, "builds": [],
         "delete_branch": False, "kind": None}
    hold = a["reasons"].append
    gitp = os.path.join(wt, ".git")
    if not os.path.lexists(gitp):
        hold("not a git worktree")
        return a
    if os.path.isdir(gitp):
        a["kind"] = "clone"
        hosted = [l[9:] for l in out(wt, "worktree", "list", "--porcelain").splitlines()
                  if l.startswith("worktree ") and os.path.realpath(l[9:]) != wt]
        gone = [h for h in hosted if not os.path.exists(h)]
        heads = out(wt, "for-each-ref", "--format=%(objectname)", "refs/heads").split()
        unpushed = [h for h in heads if not out(wt, "branch", "-r", "--contains", h)]
        a["hosted"] = hosted
        hold(f"standalone clone (.git is a directory) hosting {len(hosted) - len(gone)} live worktree(s) — listed, never touched")
        a["list_for_michael"] = (f"clone {wt}: hosts {len(hosted) - len(gone)} live worktree(s)"
                                 f"{f' + {len(gone)} registered whose folder is gone (prunable)' if gone else ''}; "
                                 f"{len(unpushed)} of its {len(heads)} local branch(es) are on no remote")
        return a
    a["kind"] = "worktree"
    if any(under(wt, l) or under(l, wt) for l in LIVE):
        hold("live gateway tree")
        return a
    if not any(under(wt, r) and wt != r for r in ctx.roots):
        hold("not under a builds root")
        return a
    claims = [b for b in ctx.builds if under(b["workdir"], wt)]
    overlap_open = [b["id"] for b in ctx.builds if (under(b["workdir"], wt) or under(wt, b["workdir"]))
                    and b["status"] not in CLOSED]
    a["builds"] = [{"id": b["id"], "status": b["status"], "closed_at": b["closed_at"], "finished": b["finished"]} for b in claims]
    if overlap_open:
        hold("open build: " + ", ".join(overlap_open))
    if not claims:
        hold("no build record claims it")
        a["list_for_michael"] = f"{wt}: a worktree no build record claims"
    if os.path.lexists(os.path.join(wt, ".keep")):
        hold(".keep marker")
    if any(under(c, wt) for c in ctx.cwds):
        hold("a live process or tmux pane is inside it")
    if ctx.guard_err:
        hold("redaction-source guard unavailable: " + ctx.guard_err)
    else:
        hits = protected_under(wt, ctx.sources)
        if hits:
            hold("holds enrolled redaction source " + ", ".join(i for i, _ in hits))
    f = git_facts(wt)
    a["git"] = {k: f[k] for k in ("head", "branch", "main_repo", "merged", "mainline", "on_remote")}
    if not f["head"]:
        hold("HEAD unreadable")
        return a
    if f["dirty"]:
        hold(f"uncommitted tracked changes ({len(f['dirty'].splitlines())} file(s))")
    if f["submodules"]:
        hold("has submodules")
    if not a["reasons"]:
        kinds = {b["status"] for b in claims}
        done = "done" in kinds
        a["status"] = "done" if done else "/".join(sorted(kinds))
        age = ctx.now - max((b["closed_at"] or ctx.now) for b in claims)
        a["closed_days"] = round(age / DAY, 1)
        shipped = finished or any(b["finished"] for b in claims)
        if f["merged"]:
            if done and not shipped and age < GRACE_MERGED:
                hold(f"merged, closed {a['closed_days']} d ago — inside the {GRACE_MERGED // 3600} h review grace")
            elif not done and not shipped and age < GRACE_FAILED:
                hold(f"{a['status']} {a['closed_days']} d ago — kept 7 days")
            else:
                a["delete_branch"] = bool(f["branch"])
        elif not f["on_remote"]:
            hold("unpushed commits on an unmerged branch")
            if done and age >= LIST_UNMERGED:
                a["list_for_michael"] = (f"{wt}: closed {a['closed_days']} d, branch {f['branch'] or 'detached'} "
                                         f"not merged and NOT pushed")
        elif done:
            hold("closed but not merged")
            if age >= LIST_UNMERGED:
                a["list_for_michael"] = f"{wt}: closed {a['closed_days']} d, branch {f['branch'] or 'detached'} pushed but not merged"
        elif age < GRACE_FAILED:
            hold(f"{a['status']} {a['closed_days']} d ago — kept 7 days")
        # else: failed/abandoned > 7 d, commits safe on a remote → remove the copy, keep the branch
    if not a["reasons"]:
        try:
            keep, regen = untracked(wt)
        except RuntimeError as e:
            hold(str(e))
            return a
        keep = sorted(set(keep) | set(named_keepers(wt)))
        a["keep"], a["regenerable"] = keep, regen
        nested = [k for k in keep if ".git" in k.split("/")]
        if nested:
            hold(f"contains a nested git tree ({nested[0].split('/.git')[0]}) — a forced remove would take it")
        size = 0
        for rel in keep:
            try:
                size += os.lstat(os.path.join(wt, rel)).st_size
            except OSError:
                pass
        a["archive_bytes"] = size
        if size > MAX_ARCHIVE_MB << 20:
            hold(f"archive would be {size >> 20} MB (> {MAX_ARCHIVE_MB} MB) — look by hand")
    if not a["reasons"]:
        a["decision"] = "remove"
    return a


# ── archive → verify → remove ──────────────────────────────────────────────

def restic(args):
    env = dict(os.environ)
    env["RESTIC_REPOSITORY"] = RESTIC_REPO
    if RESTIC_PASSWORD_FILE:
        env["RESTIC_PASSWORD_FILE"] = RESTIC_PASSWORD_FILE
    return subprocess.run([RESTIC, *args], capture_output=True, text=True, env=env)


def private_dir(path):
    """mkdir -p with every component we create, and the leaf, at 0700."""
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)


def stage(a, build_ids):
    """Copy keepers + brief + ledger into ARCHIVE_ROOT/<label>/content/; secrets aside.
    → (archive dir, staged content dir, manifest)."""
    wt = a["path"]
    label = build_ids[0] if build_ids else os.path.basename(wt)
    top = os.path.join(ARCHIVE_ROOT, label)
    if os.path.exists(top):
        top = f"{top}.{time.strftime('%Y%m%dT%H%M%S')}"
    dest = os.path.join(top, "content")
    os.makedirs(os.path.join(dest, "worktree"))
    day_dir = os.path.join(SECRETS_ROOT, time.strftime('%Y%m%d'))
    sec_dir = os.path.join(day_dir, label)
    files, secrets = [], []

    def put(src, rel_dest):
        d = os.path.join(dest, rel_dest)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        if os.path.islink(src):
            os.symlink(os.readlink(src), d)
            files.append({"path": rel_dest, "symlink": os.readlink(src)})
        else:
            shutil.copy2(src, d)
            files.append({"path": rel_dest, "size": os.path.getsize(d), "sha256": sha256(d)})

    for rel in a["keep"]:
        src = os.path.join(wt, rel)
        if not os.path.lexists(src):
            continue
        if is_secret(rel) and not os.path.islink(src):
            target = os.path.join(sec_dir, rel)
            for d in (SECRETS_ROOT, day_dir, sec_dir):  # every level 0700, made only when a secret exists
                private_dir(d)
            os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
            shutil.copy2(src, target)
            os.chmod(target, 0o600)
            if os.path.getsize(target) != os.path.getsize(src) or sha256(target) != sha256(src):
                raise RuntimeError(f"secret copy of {rel} does not match")  # never print the content
            secrets.append(rel)
            continue
        put(src, os.path.join("worktree", rel))
    for bid in build_ids:
        ld = os.path.join(BUILDS_DIR, bid)
        for n in sorted(os.listdir(ld)) if os.path.isdir(ld) else []:
            if os.path.isfile(os.path.join(ld, n)) and not is_secret(n):  # the ledger never holds one; belt
                put(os.path.join(ld, n), os.path.join("ledger", bid, n))
        b = read_build(bid) or {}
        if b.get("brief") and os.path.isfile(b["brief"]):
            put(b["brief"], os.path.join("brief", os.path.basename(b["brief"])))
    manifest = {"worktree": wt, "builds": build_ids, "git": a.get("git"), "decision": a["decision"],
                "backend": BACKEND,
                "archived_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "host": socket.gethostname(),
                "files": files, "secrets_set_aside": len(secrets),
                "secrets_dir": sec_dir if secrets else None, "secret_names": secrets}
    with open(os.path.join(dest, "MANIFEST.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    return top, dest, manifest


def local_archive_and_verify(top, dest, manifest):
    """tar.gz the staged folder into <top>/archive.tar.gz, then read it back. → archive path;
    raises on any doubt. Only after the read-back passes is the staging copy dropped."""
    tar_path = os.path.join(top, "archive.tar.gz")
    tmp = tar_path + ".partial"
    with tarfile.open(tmp, "w:gz") as tf:
        tf.add(dest, arcname="content", recursive=True)
    with open(tmp, "rb") as f:
        os.fsync(f.fileno())
    os.replace(tmp, tar_path)
    # Read back from disk, not from what we think we wrote.
    want = {os.path.join("content", f["path"]): f for f in manifest["files"]}
    seen = set()
    man_bytes = None
    with tarfile.open(tar_path, "r:gz") as tf:
        for m in tf:
            if m.name == "content/MANIFEST.json":
                man_bytes = tf.extractfile(m).read()
                continue
            f = want.get(m.name)
            if f is None:
                continue
            if "symlink" in f:
                if not m.issym() or m.linkname != f["symlink"]:
                    raise RuntimeError(f"archive has the wrong symlink for {f['path']}")
            else:
                if not m.isfile() or m.size != f["size"]:
                    raise RuntimeError(f"archive has the wrong size for {f['path']}")
                if sha256_stream(tf.extractfile(m)) != f["sha256"]:
                    raise RuntimeError(f"archive has the wrong content for {f['path']}")
            seen.add(m.name)
    missing = sorted(set(want) - seen)
    if missing:
        raise RuntimeError(f"archive is missing {len(missing)} file(s), first {missing[0]}")
    if man_bytes is None:
        raise RuntimeError("archive has no MANIFEST.json")
    with open(os.path.join(dest, "MANIFEST.json"), "rb") as f:
        if man_bytes != f.read():
            raise RuntimeError("archive MANIFEST.json does not read back byte-identical")
    shutil.copy2(os.path.join(dest, "MANIFEST.json"), os.path.join(top, "MANIFEST.json"))
    try:  # the verified tarball is the archive; the staging copy is a duplicate of it
        make_writable_dirs(dest)
        shutil.rmtree(dest)
    except OSError as e:
        log(f"note: staging copy {dest} not dropped: {e}")
    return tar_path


def archive_and_verify(top, dest, manifest, label):
    """Write the archive with the configured backend and read it back. → archive ref."""
    if BACKEND == "restic":
        return "restic:" + backup_and_verify(dest, manifest, label)
    return "local:" + local_archive_and_verify(top, dest, manifest)


def backup_and_verify(dest, manifest, label):
    """restic backup the staged folder, then read the snapshot back. → snapshot id; raises on any doubt."""
    r = restic(["backup", "--json", "--tag", "build-archive", "--tag", f"build:{label}", dest])
    if r.returncode != 0:
        raise RuntimeError(f"restic backup failed (rc={r.returncode}): {r.stderr.strip()[-300:]}")
    snap = None
    for line in r.stdout.splitlines():
        try:
            j = json.loads(line)
        except ValueError:
            continue
        if j.get("message_type") == "summary":
            snap = j.get("snapshot_id")
    if not snap:
        raise RuntimeError("restic backup printed no snapshot id")
    ls = restic(["ls", "--json", snap])
    if ls.returncode != 0:
        raise RuntimeError(f"restic ls {snap[:8]} failed: {ls.stderr.strip()[-300:]}")
    listed = {}
    for line in ls.stdout.splitlines():
        try:
            j = json.loads(line)
        except ValueError:
            continue
        if j.get("path"):
            listed[j["path"]] = j
    want = [os.path.join(dest, f["path"]) for f in manifest["files"]] + [os.path.join(dest, "MANIFEST.json")]
    missing = [p for p in want if p not in listed]
    if missing:
        raise RuntimeError(f"snapshot {snap[:8]} is missing {len(missing)} file(s), first {missing[0]}")
    for f in manifest["files"]:
        if "size" in f and listed[os.path.join(dest, f["path"])].get("size") != f["size"]:
            raise RuntimeError(f"snapshot {snap[:8]} has the wrong size for {f['path']}")
    dump = restic(["dump", snap, os.path.join(dest, "MANIFEST.json")])
    if dump.returncode != 0 or hashlib.sha256(dump.stdout.encode()).hexdigest() != sha256(os.path.join(dest, "MANIFEST.json")):
        raise RuntimeError(f"snapshot {snap[:8]}: MANIFEST.json does not read back byte-identical")
    return snap


def make_writable_dirs(path):
    for dp, dn, _ in os.walk(path, followlinks=False):
        try:
            os.chmod(dp, stat.S_IMODE(os.lstat(dp).st_mode) | 0o700)
        except OSError:
            pass


def remove(a, ctx, build_ids):
    """Archive, verify, re-check, remove. Returns a result dict; raises nothing."""
    wt = a["path"]
    label = build_ids[0] if build_ids else os.path.basename(wt)
    res = {"path": wt, "archived": None, "removed": False, "branch_deleted": None, "error": None}
    lock_path = os.path.join(ARCHIVE_ROOT, f".{label}.lock")
    os.makedirs(ARCHIVE_ROOT, mode=0o700, exist_ok=True)  # reports and evidence: owner-only
    import fcntl
    lock = open(lock_path, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        res["error"] = "another close is running on this build"
        return res
    try:
        try:
            top, dest, manifest = stage(a, build_ids)
            snap = archive_and_verify(top, dest, manifest, label)
        except Exception as e:  # noqa: BLE001 — any archive doubt = nothing deleted
            res["error"] = f"archive failed, nothing deleted: {e}"
            log(f"ARCHIVE-FAILED {wt} builds={','.join(build_ids)} {e}")
            for b in build_ids:
                ledger_event(b, "archive-failed", str(e)[:300])
            return res
        res["archived"] = {"archive": snap, "backend": BACKEND, "dir": top, "files": len(manifest["files"]),
                           "secrets_set_aside": manifest["secrets_set_aside"]}
        log(f"archived {wt} archive={snap} files={len(manifest['files'])} secrets_aside={manifest['secrets_set_aside']} dir={top}")
        for b in build_ids:
            ledger_event(b, "archived", f"archive={snap} files={len(manifest['files'])} dir={top}")
        # Re-read the tree: what we archived must still be all there is.
        again = assess(wt, Ctx(ctx.roots), finished=True)
        if again["decision"] != "remove":
            res["error"] = "changed since the archive, not removed: " + "; ".join(again["reasons"])
            return res
        f = git_facts(wt)
        if f["head"] != a["git"]["head"]:
            res["error"] = "HEAD moved since the archive, not removed"
            return res
        keep_now, _ = untracked(wt)
        extra = sorted(set(keep_now) - set(a["keep"]))
        if extra:
            res["error"] = f"{len(extra)} new file(s) since the archive (first {extra[0]}), not removed"
            return res
        make_writable_dirs(wt)
        r = subprocess.run(["git", "-C", a["git"]["main_repo"], "worktree", "remove", "--force", wt], capture_output=True, text=True)
        if r.returncode != 0 or os.path.lexists(wt):
            res["error"] = f"git worktree remove failed: {r.stderr.strip()[:300]}"
            log(f"REMOVE-FAILED {wt} {res['error']}")
            return res
        res["removed"] = True
        log(f"removed {wt} (git worktree remove)")
        for b in build_ids:
            ledger_event(b, "worktree-removed", f"{wt} archive={snap}")
        br = a["git"]["branch"]
        if a["delete_branch"] and br:
            repo, tip = a["git"]["main_repo"], a["git"]["head"]
            # Only while the branch still points at the tip we proved merged; update-ref -d is compare-and-delete.
            checked_out = f"branch refs/heads/{br}" in out(repo, "worktree", "list", "--porcelain").splitlines()
            if not checked_out and ok(repo, "merge-base", "--is-ancestor", tip, a["git"]["mainline"]) and \
                    ok(repo, "update-ref", "-d", f"refs/heads/{br}", tip):
                res["branch_deleted"] = br
                log(f"branch {br} deleted in {repo} (tip {tip[:12]} on {a['git']['mainline']})")
                for b in build_ids:
                    ledger_event(b, "branch-deleted", f"{br} tip={tip[:12]}")
            else:
                res["branch_deleted"] = False
        return res
    finally:
        lock.close()


# ── commands ───────────────────────────────────────────────────────────────

def human(n):
    return f"{n / (1 << 30):.2f} GB" if n >= 1 << 30 else f"{n / (1 << 20):.0f} MB"


def residue(roots, trees):
    """Top-level folders under a builds root that hold no git tree at all — leftovers of a hand
    clean-up. Reported, never touched: they may hold the only copy of a secret."""
    found = []
    for root in roots:
        try:
            names = sorted(os.listdir(root))
        except OSError:
            continue
        for n in names:
            p = os.path.realpath(os.path.join(root, n))
            if not os.path.isdir(p) or os.path.islink(os.path.join(root, n)) or os.path.exists(os.path.join(BUILDS_DIR, n, "meta.json")):
                continue
            if any(under(t, p) for t in trees):
                continue
            secrets, files = 0, 0
            for dp, dn, fn in os.walk(p):
                dn[:] = [d for d in dn if d not in REGENERABLE]
                files += len(fn)
                secrets += sum(1 for f in fn if is_secret(os.path.relpath(os.path.join(dp, f), p)))
            found.append(f"{p}: not a git tree — {files} file(s), {human(tree_bytes(p)[1])}"
                         f"{f', {secrets} secret-shaped' if secrets else ''}; never touched — Michael's call")
    return found


def open_questions(builds):
    """Closed builds whose newest timeline record is still a question (read-only)."""
    found = []
    for b in builds:
        if b["status"] not in CLOSED:
            continue
        p = os.path.join(TIMELINE_DIR, f"{b['id']}.jsonl")
        try:
            last = None
            for line in open(p):
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get("type") == "record":
                    last = e.get("record") or {}
        except OSError:
            continue
        if last and last.get("kind") == "needs_owner":
            found.append(f"{b['id']}: closed {b['status']}, but its card still asks the owner a question "
                         f"(asked {last.get('at', '?')}) — record the answer with build_answered.sh, or finish it")
    return found


def cmd_assess(argv):
    a = assess(argv[0], Ctx())
    print(json.dumps(a, indent=1) if "--json" in argv else f"{a['decision']}: {a['path']} — {'; '.join(a['reasons']) or 'ok'}")
    return 0


def cmd_clean(argv):
    bid = argv[0]
    apply, finished = "--apply" in argv, "--finished" in argv
    b = read_build(bid)
    if not b:
        print(f"fm_close: no such build {bid}", file=sys.stderr)
        return 2
    if not os.path.lexists(b["workdir"]):
        print(f"fm_close: {bid}: worktree {b['workdir']} is already gone — nothing to clean")
        return 0
    ctx = Ctx()
    top = out(b["workdir"], "rev-parse", "--show-toplevel")
    if not top or os.path.realpath(top) != b["workdir"]:
        print(f"fm_close: {bid}: workdir {b['workdir']} is not a worktree root — held, nothing touched")
        return 3
    a = assess(b["workdir"], ctx, finished=finished)
    claims = [x["id"] for x in a["builds"]] or [bid]
    if a["decision"] != "remove":
        print(f"fm_close: {bid}: HELD — {'; '.join(a['reasons'])}")
        return 3
    if not apply:
        total, own = tree_bytes(a["path"])
        print(f"fm_close: {bid}: would archive {len(a['keep'])} file(s) and remove {a['path']} "
              f"(frees ~{human(own)}), branch {'deleted' if a['delete_branch'] else 'kept'}")
        return 0
    res = remove(a, ctx, claims)
    if res["error"]:
        print(f"fm_close: {bid}: {res['error']}")
        return 1
    ar = res["archived"]
    print(f"fm_close: {bid}: archived {ar['files']} file(s) to {ar['archive']} (verified)"
          f"{f', {ar['secrets_set_aside']} secret file(s) set aside' if ar['secrets_set_aside'] else ''}; "
          f"removed {res['path']}; branch {res['branch_deleted'] or 'kept'}")
    return 0


def cmd_sweep(argv):
    apply = "--apply" in argv
    roots = [argv[i + 1] for i, x in enumerate(argv) if x == "--root"] or ROOTS
    md = next((argv[i + 1] for i, x in enumerate(argv) if x == "--markdown"), None)
    ctx = Ctx(roots)
    rows, michael = [], []
    for path, kind in find_git_dirs(ctx.roots):
        if any(under(path, l) for l in LIVE):
            continue
        a = assess(path, ctx)
        total, own = tree_bytes(path)
        a["bytes"], a["own_bytes"] = total, own
        if a["list_for_michael"]:
            michael.append(a["list_for_michael"])
        if a["decision"] == "remove" and apply:
            a["result"] = remove(a, ctx, [b["id"] for b in a["builds"]])
        rows.append(a)
    michael += residue([os.path.realpath(r) for r in RESIDUE_ROOTS if os.path.realpath(r) in ctx.roots],
                       [r["path"] for r in rows])
    michael += open_questions(ctx.builds)
    removable = [r for r in rows if r["decision"] == "remove"]
    held = [r for r in rows if r["decision"] != "remove"]
    if "--json" in argv:
        print(json.dumps({"apply": apply, "rows": rows, "michael": michael}, indent=1, default=str))
    else:
        verb = "archived+removed" if apply else "would archive+remove"
        print(f"fm_close sweep: {'APPLY' if apply else 'dry run'} — {len(rows)} git trees under {len(ctx.roots)} roots")
        for r in removable:
            res = r.get("result")
            tail = (f" → {'removed' if res['removed'] else 'NOT removed: ' + str(res['error'])}" if res else "")
            print(f"  {verb}  {r['path']}  ({human(r['own_bytes'])}, {len(r['keep'])} keeper file(s), "
                  f"branch {'deleted' if r['delete_branch'] else 'kept'}){tail}")
        for r in held:
            print(f"  hold  {r['path']}  ({human(r['own_bytes'])}) — {'; '.join(r['reasons'])}")
        print(f"  {verb}: {len(removable)} ({human(sum(r['own_bytes'] for r in removable))} freed) · held: {len(held)}")
        if michael:
            print("For Michael:")
            for m in michael:
                print(f"  - {m}")
    if md:
        write_markdown(md, rows, michael, apply)
    if "--alert" in argv:
        alert(michael, removable, apply)
    return 0


def alert(michael, removable, apply):
    """The Michael list as one review-desk alert, through the gateway's own CLI (it reads its
    token in-process and never prints it). Optional and fail-soft: the log still has every line."""
    cli = os.environ.get("FM_REVIEW_CLI", "").split()
    if not cli:
        if not os.path.isfile(REVIEW_MJS):
            print("fm_close: alert skipped — no review CLI configured (FM_REVIEW_MJS / FM_REVIEW_CLI)")
            return
        cli = [shutil.which("node") or "/usr/local/bin/node", REVIEW_MJS]
    if michael:
        args = ["alert", "--class", "build-sweep-held", "--source", "build-sweep", "--severity", "soft",
                "--title", f"{len(michael)} build copies or questions need Michael's call",
                "--detail", "\n".join(michael)[:3500]]
    else:
        args = ["alert-resolve", "--class", "build-sweep-held"]
    r = subprocess.run([*cli, *args], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"fm_close: alert not delivered (rc={r.returncode}): {r.stderr.strip()[:200]}")


def write_markdown(path, rows, michael, apply):
    removable = [r for r in rows if r["decision"] == "remove"]
    lines = [f"| decision | worktree | size (own) | builds | reason |", "|---|---|---|---|---|"]
    for r in sorted(rows, key=lambda r: (r["decision"] != "remove", r["path"])):
        builds = ", ".join(f"{b['id']} ({b['status']})" for b in r["builds"]) or "—"
        why = "; ".join(r["reasons"]) or ("merged → archive+remove, branch deleted" if r["delete_branch"] else "safe → archive+remove, branch kept")
        lines.append(f"| {'archive+remove' if r['decision'] == 'remove' else 'hold'} | `{r['path']}` | {human(r['own_bytes'])} | {builds} | {why} |")
    lines.append("")
    lines.append(f"**{'Archived+removed' if apply else 'Would archive+remove'}: {len(removable)} "
                 f"({human(sum(r['own_bytes'] for r in removable))} freed). Held: {len(rows) - len(removable)}.**")
    if michael:
        lines += ["", "For Michael (one line each, nothing deleted):", ""] + [f"- {m}" for m in michael]
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "assess" and rest:
        return cmd_assess(rest)
    if cmd == "clean" and rest:
        return cmd_clean(rest)
    if cmd == "sweep":
        return cmd_sweep(rest)
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
