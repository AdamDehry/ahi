# Build copies (worktrees) with shared packages

Every build gets its own full git worktree next to the original, and it stays until
the build is closed out. Its `node_modules` are **hardlinked from one shared, read-only
cache** instead of downloaded fresh, so a new copy costs roughly its source size (tens
of MB) instead of a full install (often hundreds of MB), and takes seconds instead of a
full `npm ci`.

Paths below use the foreman's path variables: `$FOREMAN_ROOT` (default
`$AHI_HOME/foreman`), `$FM_WORKTREES_DIR` (default `$AHI_HOME/builds`), `$FM_GATEWAY_DIR`
(default `$AHI_HOME/gateway`).

## Create a build copy

```sh
$FOREMAN_ROOT/bin/fm_worktree.sh <repo> <name> <branch> [<base>]
# e.g.
$FOREMAN_ROOT/bin/fm_worktree.sh ~/src/my-project my-feature/my-project feat/my-feature
```

- Creates `$FM_WORKTREES_DIR/<name>` (override: `BUILDS_ROOT`) with `git worktree add`.
  A new `<branch>` is cut from `<base>` (default: the repo's HEAD). An existing branch is
  checked out as is. Use `--detach` as the branch for a copy with no branch.
- Then fills in `node_modules` for every tracked `package-lock.json` at depth 2 or less
  (e.g. the repo root and `web/`).
- It refuses to create a copy at, or inside, the live gateway checkout (`$FM_GATEWAY_DIR`).

Existing worktree, or one whose `node_modules` you removed:
`fm_worktree.sh deps <worktree>`. Dirs that already have a `node_modules` are left alone.

## What builders need to know

- **It's a normal tree.** `npm test`, `npx tsc`, `npm run build` and dev servers behave
  exactly as in a privately installed copy: same pass/fail set, byte-identical build
  output.
- **`npm ci` and `npm install` are safe.** They replace files rather than editing them,
  and the shared files are read-only. Running them only makes your copy private again
  (full size). If your branch changes a lockfile, that's expected. The next
  `fm_worktree.sh deps` on a copy with that lockfile makes and shares a new cache entry.
- **Don't edit files inside `node_modules` in place.** They're read-only on purpose: an
  in-place edit would change every build's copy. If you truly need a patched dependency,
  run `npm ci --include=dev` first so your tree is private, then patch.
- **If `NODE_ENV=production` is set in your environment, always pass `--include=dev` to
  npm.** A project script that runs `npm ci` without it fails in **every** copy, shared
  or private, because dev dependencies (bundlers, test runners) are never installed. Run
  the build step directly, or run with `NODE_ENV=` (empty).
- `du` of a single copy still reports the full size because it counts the shared files.
  `df` shows the real cost. `du -sk "$AHI_DEPCACHE_ROOT" <copy>` shows the copy's own
  bytes on the second line.

## The cache

`~/.cache/ahi-depcache/` (override: `AHI_DEPCACHE_ROOT`). It must be on the same
filesystem as `$FM_WORKTREES_DIR` (hardlinks cannot cross filesystems). Keep it outside
any disk-cleanup roots (a cleanup would delete entries still linked into live builds) and
outside any synced folder.

- `entries/<key>/`: one sealed `node_modules` per key. The key is the sha256 of
  `package-lock.json` plus node ABI, platform/arch and npm major. Every file and dir is
  read-only; `manifest.json` records sha256, size, mode and mtime of every file.
- A miss runs `npm ci --include=dev` **in the new worktree**, then moves that fresh,
  never-built tree into the cache and links it back. A lock per key: two builders missing
  together build once.
- Before every link, the entry is re-hashed (about a second). Any drift → the entry moves
  to `quarantine/`, a clean one is rebuilt, and the log names every worktree still linked
  to the drifted one.
- If anything on the sharing path fails, the builder gets a plain private `npm ci`. The
  cache can make a build cheaper; it never makes one fail.

```sh
$FOREMAN_ROOT/bin/fm_depcache.py list               # entries, size, still linked?
$FOREMAN_ROOT/bin/fm_depcache.py verify --full      # check every entry against its manifest
$FOREMAN_ROOT/bin/fm_depcache.py gc [--apply]       # drop entries nothing links to, >7 days old
```

Log: `$AHI_DEPCACHE_ROOT/depcache.log`.

## Cleaning up closed builds (packages only)

```sh
$FOREMAN_ROOT/bin/fm_worktree.sh clean            # dry run: what would be dropped, and why others are skipped
$FOREMAN_ROOT/bin/fm_worktree.sh clean --apply
```

Drops `node_modules`, `.next` and `dist` (at the worktree root and one level down) in
worktrees whose builds are **all closed**. **The worktree and branch always stay.** It
looks under `$FM_WORKTREES_DIR`, every root in `FM_BUILD_ROOTS` (colon-separated) and
every worktree registered with the gateway repo. A worktree is skipped if:

- any open build's workdir overlaps it, however broadly (a broad workdir can block, only
  a precise one can certify a copy closed);
- no build record claims it precisely;
- a process or tmux pane is inside it;
- it is, or is inside, the live gateway;
- its path is hidden or names evidence;
- git tracks the target;
- the target holds an enrolled redaction source (see below).

Log: `$FM_LOG_DIR/worktree-clean.log`. To work in a cleaned copy again, run
`fm_worktree.sh deps <worktree>`.

## Closing out a build copy (archive, verify, then remove)

`build_finish.sh` (after a ship) and `fm_close.py sweep` (stragglers) remove whole copies.
The rules that make that safe:

- **Verify before delete.** Keepers (untracked non-regenerable files, reports, evidence,
  the brief and the ledger) are archived and the archive is **read back** against its
  manifest before anything is removed. A failed or unverified archive deletes nothing.
  Default archive: `$AHI_HOME/state/build-archive/<build-id>/archive.tar.gz` +
  `MANIFEST.json`. Set `FM_RESTIC_REPO` (+ `FM_RESTIC_PASSWORD_FILE`, `FM_RESTIC_BIN`) to
  archive to a restic repository instead.
- **Secrets never enter the archive.** Secret-shaped files (`.env*`, keys, credential
  json) go to a private `0700` dir (`$AHI_HOME/state/build-archive-secrets/`, files
  `0600`); only their count is printed, never their content.
- **Never `rm -rf` a builds dir.** Removal is `git worktree remove` on a re-checked tree
  (same HEAD, still clean, nothing new since the archive). The branch is deleted only if
  it still points at the tip proven merged.
- **A `.git` DIRECTORY is a clone**, which may host other worktrees: listed for the
  supervisor, never touched. Folders under a builds root that hold no git tree are
  reported, never touched — they may hold the only copy of something.
- **Ask before retiring any folder.** `fm_worktree.sh guard <path>...` asks the
  (optional) redactor whether an enrolled redaction source lives under the path. Moving
  one away makes every ingest fail closed until the enrollment is repaired. With no
  redactor configured (`FM_REDACTOR_MJS` unset) nothing is enrolled and callers proceed;
  with one configured whose table cannot be read, everything is treated as protected.
