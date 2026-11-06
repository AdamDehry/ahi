#!/usr/bin/env python3
"""fm_depcache — one shared, read-only copy of node_modules per lockfile.

A build worktree gets node_modules HARDLINKED from a content-addressed cache
entry instead of downloading its own copy (often hundreds of MB). On a
filesystem without reflink (e.g. ext4) a hardlink is the only zero-copy
primitive, and a hardlink has one hazard: a file edited IN PLACE changes in
every copy, the cache included. Three layers answer it:

  1. PREVENT  every file in a cache entry is chmod a-w. The mode lives on the
              shared inode, so an in-place write from ANY worktree fails loudly
              (EACCES) instead of silently poisoning every build. npm ci /
              npm install replace files (unlink + create), which a read-only
              file does not stop, because worktree DIRECTORIES are private and
              writable.
  2. AVOID    the one file npm rewrites in place — node_modules/.package-lock.json
              (arborist's hidden lockfile) — is COPIED into each worktree, never
              linked.
  3. DETECT   each entry carries a manifest (sha256, size, mode, mtime of every
              file). `materialise` re-hashes the entry before every link and
              refuses — quarantines and rebuilds — on any drift, and names the
              worktrees still linked to it. A chmod u+w + write gets past
              layer 1; it does not get past layer 3.

Key = sha256(lockfile bytes + node ABI + platform/arch + npm major + "include=dev").
A cache miss runs `npm ci --include=dev` IN THE WORKTREE (so lifecycle scripts
see the real project), then the fresh, never-built tree is sealed into the cache
and linked back. Any failure on the sharing path falls back to a plain private
`npm ci`: the cache may make a build cheaper, it may never make one fail.

Usage:
  fm_depcache.py materialise <projdir>     node_modules for <projdir> (its package-lock.json)
  fm_depcache.py key <projdir>             print the cache key
  fm_depcache.py verify [--full] [<key>]   check one or all entries against their manifests
  fm_depcache.py list                      entries, size, recorded users
  fm_depcache.py gc [--apply] [--days N]   drop entries no worktree links to (dry run by default)
Env: AHI_DEPCACHE_ROOT (default ~/.cache/ahi-depcache). Must be on the same
filesystem as the worktrees (hardlinks cannot cross filesystems). Keep it
OUTSIDE any disk-cleanup roots (e.g. $FM_WORKTREES_DIR) — a cleanup would delete
entries still linked into live builds — and outside any synced folder, which
would copy every read-only inode to other machines.
"""
import fcntl
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import time

ROOT = os.environ.get("AHI_DEPCACHE_ROOT") or os.path.expanduser("~/.cache/ahi-depcache")
ENTRIES = os.path.join(ROOT, "entries")
LOCKS = os.path.join(ROOT, "locks")
TMP = os.path.join(ROOT, "tmp")
QUAR = os.path.join(ROOT, "quarantine")
LOG = os.path.join(ROOT, "depcache.log")
HIDDEN_LOCK = ".package-lock.json"  # rewritten in place by npm: copied, never linked
MARKER = ".ahi-depcache.json"       # per-worktree, private, records which entry it came from
NPM_CI = ["npm", "ci", "--include=dev", "--no-audit", "--no-fund"]


def log(msg):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {msg}"
    print(f"depcache: {msg}", file=sys.stderr)
    try:
        os.makedirs(ROOT, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def env_tag():
    out = subprocess.run(
        ["node", "-p", "[process.versions.modules, process.platform, process.arch].join('-')"],
        capture_output=True, text=True, check=True).stdout.strip()
    npm = subprocess.run(["npm", "-v"], capture_output=True, text=True, check=True).stdout.strip()
    return f"abi-{out};npm-{npm.split('.')[0]};include=dev"


def key_for(projdir):
    lock = os.path.join(projdir, "package-lock.json")
    h = hashlib.sha256()
    with open(lock, "rb") as f:
        h.update(f.read())
    h.update(b"\0" + env_tag().encode())
    return h.hexdigest()[:32]


# ── manifest ────────────────────────────────────────────────────────────────
def walk(nm):
    """Yield (relpath, lstat) for every entry under nm, sorted, not following links."""
    for dirpath, dirnames, filenames in os.walk(nm, followlinks=False):
        dirnames.sort()
        for name in sorted(filenames) + [d for d in dirnames if os.path.islink(os.path.join(dirpath, d))]:
            p = os.path.join(dirpath, name)
            yield os.path.relpath(p, nm), os.lstat(p)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_manifest(nm):
    files = {}
    for rel, st in walk(nm):
        if stat.S_ISLNK(st.st_mode):
            files[rel] = {"t": "l", "to": os.readlink(os.path.join(nm, rel))}
        elif stat.S_ISREG(st.st_mode):
            files[rel] = {"t": "f", "size": st.st_size, "mode": stat.S_IMODE(st.st_mode),
                          "mtime": st.st_mtime_ns, "sha": sha256_file(os.path.join(nm, rel))}
    return files


def check_entry(entry, full=False):
    """Return a list of drift findings (empty = clean)."""
    nm = os.path.join(entry, "node_modules")
    try:
        with open(os.path.join(entry, "manifest.json")) as f:
            want = json.load(f)["files"]
    except (OSError, ValueError) as e:
        return [f"manifest unreadable: {e}"]
    bad, seen = [], set()
    for rel, st in walk(nm):
        seen.add(rel)
        w = want.get(rel)
        if w is None:
            if not stat.S_ISDIR(st.st_mode):
                bad.append(f"ADDED {rel}")
            continue
        if w["t"] == "l":
            if not stat.S_ISLNK(st.st_mode) or os.readlink(os.path.join(nm, rel)) != w["to"]:
                bad.append(f"LINK-CHANGED {rel}")
            continue
        if not stat.S_ISREG(st.st_mode):
            bad.append(f"TYPE-CHANGED {rel}")
            continue
        mode = stat.S_IMODE(st.st_mode)
        if st.st_size != w["size"] or st.st_mtime_ns != w["mtime"] or mode != (w["mode"] & ~0o222):
            bad.append(f"STAT-DRIFT {rel} size={st.st_size}/{w['size']} mode={oct(mode)}")
        elif full and sha256_file(os.path.join(nm, rel)) != w["sha"]:
            bad.append(f"CONTENT-DRIFT {rel}")
    bad += [f"MISSING {r}" for r in want if r not in seen]
    return bad


# ── seal / link ─────────────────────────────────────────────────────────────
def set_readonly(nm):
    """Files and dirs a-w. File modes are shared with every hardlink; that is the point."""
    for dirpath, dirnames, filenames in os.walk(nm, topdown=False, followlinks=False):
        for name in filenames:
            p = os.path.join(dirpath, name)
            st = os.lstat(p)
            if stat.S_ISREG(st.st_mode):
                os.chmod(p, stat.S_IMODE(st.st_mode) & ~0o222)
        os.chmod(dirpath, stat.S_IMODE(os.lstat(dirpath).st_mode) & ~0o222)


def make_dirs_writable(tree):
    for dirpath, dirnames, _ in os.walk(tree, followlinks=False):
        os.chmod(dirpath, stat.S_IMODE(os.lstat(dirpath).st_mode) | 0o200)


def rmtree_force(path):
    """Remove a tree whose dirs may be read-only. Unlinks only — never writes to a file."""
    if not os.path.lexists(path):
        return
    if os.path.islink(path) or not os.path.isdir(path):
        os.unlink(path)
        return
    make_dirs_writable(path)
    shutil.rmtree(path)


def seal(projdir, key):
    """Move a fresh node_modules from projdir into the cache as entry <key>.
    On any failure the tree goes back to projdir (writable again) — never re-downloaded."""
    nm = os.path.join(projdir, "node_modules")
    stage = os.path.join(TMP, f"{key}.{os.getpid()}")
    snm = os.path.join(stage, "node_modules")
    os.makedirs(stage)
    os.rename(nm, snm)                    # same fs: atomic, no copy
    try:
        set_readonly(snm)                 # before the manifest, so recorded modes are final
        files = build_manifest(snm)
        with open(os.path.join(stage, "manifest.json"), "w") as f:
            json.dump({"key": key, "files": files}, f)
        meta = {"key": key, "env": env_tag(), "created": int(time.time()),
                "lockfile_from": os.path.join(projdir, "package-lock.json"),
                "files": len(files),
                "bytes": sum(v.get("size", 0) for v in files.values())}
        with open(os.path.join(stage, "meta.json"), "w") as f:
            json.dump(meta, f, indent=1)
        shutil.copy2(os.path.join(projdir, "package-lock.json"), os.path.join(stage, "package-lock.json"))
        make_dirs_writable(snm)           # rename(2) of a dir needs write on the dir itself
        entry = os.path.join(ENTRIES, key)
        os.rename(stage, entry)
        set_readonly(os.path.join(entry, "node_modules"))
        os.chmod(entry, 0o555)
    except BaseException:
        if os.path.isdir(snm) and not os.path.lexists(nm):
            make_dirs_writable(snm)
            os.rename(snm, nm)
            restore_private_writable(nm)
        rmtree_force(stage)
        raise
    log(f"sealed {key} from {projdir} ({meta['files']} files, {meta['bytes'] // 1048576} MB)")


def restore_private_writable(nm):
    """Only for a tree with NO other links (a failed seal): give files back u+w."""
    for dirpath, dirnames, filenames in os.walk(nm, followlinks=False):
        os.chmod(dirpath, stat.S_IMODE(os.lstat(dirpath).st_mode) | 0o200)
        for name in filenames:
            p = os.path.join(dirpath, name)
            st = os.lstat(p)
            if stat.S_ISREG(st.st_mode) and st.st_nlink == 1:
                os.chmod(p, stat.S_IMODE(st.st_mode) | 0o200)


def sweep_tmp():
    """Remove staging dirs whose owning process is gone (crash mid-seal)."""
    for name in os.listdir(TMP):
        pid = name.rsplit(".", 1)[-1]
        if pid.isdigit() and not os.path.exists(f"/proc/{pid}"):
            rmtree_force(os.path.join(TMP, name))
            log(f"swept stale staging dir {name}")


def link(projdir, key):
    entry = os.path.join(ENTRIES, key)
    dest = os.path.join(projdir, "node_modules")
    tmp = os.path.join(projdir, f".node_modules.depcache-{os.getpid()}")
    subprocess.run(["cp", "-a", "-l", os.path.join(entry, "node_modules"), tmp], check=True)
    make_dirs_writable(tmp)               # private dirs: npm can add/remove/replace freely
    hl = os.path.join(tmp, HIDDEN_LOCK)
    if os.path.lexists(hl):               # break the link: npm rewrites this file in place
        data = open(hl, "rb").read()
        os.unlink(hl)
        with open(hl, "wb") as f:
            f.write(data)
    with open(os.path.join(tmp, MARKER), "w") as f:
        json.dump({"key": key, "entry": entry, "linked": int(time.time())}, f)
    os.rename(tmp, dest)
    with open(os.path.join(ROOT, "users.log"), "a") as f:
        f.write(f"{int(time.time())} {key} {os.path.realpath(projdir)}\n")


def quarantine(key, why):
    src = os.path.join(ENTRIES, key)
    dst = os.path.join(QUAR, f"{key}-{int(time.time())}")
    os.chmod(src, 0o755)                  # rename(2) of a dir needs write on the dir itself
    os.rename(src, dst)
    log(f"QUARANTINED {key} -> {dst}: {why}")
    # Worktrees already linked share the drifted inodes; the cache cannot unshare them.
    users = sorted({l.split(" ", 2)[2].strip() for l in open(os.path.join(ROOT, "users.log"))
                    if l.split(" ", 2)[1:2] == [key]}) if os.path.exists(os.path.join(ROOT, "users.log")) else []
    for u in users:
        try:
            linked = json.load(open(os.path.join(u, "node_modules", MARKER)))["key"] == key
        except (OSError, ValueError, KeyError):
            linked = False
        if linked:
            log(f"  STILL LINKED to the drifted entry: {u}/node_modules — rm it and run fm_worktree.sh deps")


def private_ci(projdir, why):
    log(f"fallback: private npm ci in {projdir} ({why})")
    rmtree_force(os.path.join(projdir, "node_modules"))
    return subprocess.run(NPM_CI, cwd=projdir).returncode


def materialise(projdir):
    projdir = os.path.realpath(projdir)
    if not os.path.isfile(os.path.join(projdir, "package-lock.json")):
        sys.exit(f"depcache: no package-lock.json in {projdir}")
    nm = os.path.join(projdir, "node_modules")
    if os.path.lexists(nm):
        sys.exit(f"depcache: {nm} already exists — refusing to replace it (remove it first)")
    for d in (ENTRIES, LOCKS, TMP, QUAR):
        os.makedirs(d, exist_ok=True)
    sweep_tmp()
    try:
        key = key_for(projdir)
    except (OSError, subprocess.CalledProcessError) as e:
        return private_ci(projdir, f"cannot compute key: {e}")
    with open(os.path.join(LOCKS, key + ".lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)    # one builder per key; others wait, then hit
        entry = os.path.join(ENTRIES, key)
        if os.path.isdir(entry):
            drift = check_entry(entry, full=True)  # full sha256: ~0.8 s warm for 19k files / 392 MB
            if drift:
                quarantine(key, f"{len(drift)} drift(s), first: {drift[0]}")
        if os.path.isdir(entry):
            hit = True
        else:
            hit = False
            log(f"miss {key} for {projdir}: npm ci --include=dev")
            rc = subprocess.run(NPM_CI, cwd=projdir).returncode
            if rc != 0:
                log(f"npm ci failed rc={rc} in {projdir}; nothing cached")
                return rc
            try:
                seal(projdir, key)
            except Exception as e:  # cache trouble must not cost the build its tree
                if os.path.isdir(nm):
                    log(f"seal failed ({e}); the fresh tree is back in {projdir}, private")
                    return 0
                return private_ci(projdir, f"seal failed and lost the tree: {e}")
        try:
            link(projdir, key)
        except Exception as e:
            for p in os.listdir(projdir):
                if p.startswith(".node_modules.depcache-"):
                    rmtree_force(os.path.join(projdir, p))
            return private_ci(projdir, f"link failed: {e}")
    log(f"{'hit' if hit else 'built'} {key} -> {nm}")
    return 0


# ── maintenance ─────────────────────────────────────────────────────────────
def entries(sel=None):
    if not os.path.isdir(ENTRIES):
        return []
    return [k for k in sorted(os.listdir(ENTRIES)) if sel in (None, k)]


def cmd_verify(args):
    full = "--full" in args
    sel = next((a for a in args if not a.startswith("--")), None)
    rc = 0
    for k in entries(sel):
        drift = check_entry(os.path.join(ENTRIES, k), full=full)
        print(f"{k} {'CLEAN' if not drift else 'DRIFT ' + str(len(drift))} ({'sha256' if full else 'stat'})")
        for d in drift[:20]:
            print("   ", d)
        rc |= bool(drift)
    return rc


def linked_elsewhere(entry, sample=200):
    """True if any sampled file has a link outside the cache (nlink > 1)."""
    nm = os.path.join(entry, "node_modules")
    n = 0
    for rel, st in walk(nm):
        if stat.S_ISREG(st.st_mode) and not rel.startswith(HIDDEN_LOCK):
            if st.st_nlink > 1:
                return True
            n += 1
            if n >= sample:
                break
    return False


def cmd_list(_):
    for k in entries():
        e = os.path.join(ENTRIES, k)
        m = json.load(open(os.path.join(e, "meta.json")))
        print(f"{k} {m['bytes'] // 1048576:>5} MB {m['files']:>6} files "
              f"linked={'yes' if linked_elsewhere(e) else 'no '} from={m['lockfile_from']}")
    return 0


def cmd_gc(args):
    apply = "--apply" in args
    days = int(args[args.index("--days") + 1]) if "--days" in args else 7
    now = time.time()
    for k in entries():
        e = os.path.join(ENTRIES, k)
        age = (now - json.load(open(os.path.join(e, "meta.json")))["created"]) / 86400
        if linked_elsewhere(e) or age < days:
            continue
        print(f"{'REMOVE' if apply else 'would remove'} {k} (age {age:.1f}d, no worktree links)")
        if apply:
            rmtree_force(e)
            log(f"gc removed {k}")
    return 0


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, rest = argv[1], argv[2:]
    if cmd in ("materialise", "materialize", "link"):
        return materialise(rest[0])
    if cmd == "key":
        print(key_for(os.path.realpath(rest[0])))
        return 0
    if cmd == "verify":
        return cmd_verify(rest)
    if cmd == "list":
        return cmd_list(rest)
    if cmd == "gc":
        return cmd_gc(rest)
    sys.exit(f"depcache: unknown command {cmd}")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
