#!/usr/bin/env bash
# smoke_install.sh — install the foreman into a throwaway $AHI_HOME and run one dummy build
# start → status → steer → close, then a close with work still queued. No model is called and no gateway is woken:
#   - the runtime is a stub "claude" that echoes what it is typed,
#   - tmux runs on its own server (private TMUX_TMPDIR), never the one your real builds use,
#   - GATEWAY_URL points at a closed port, so every wake is logged as undelivered,
#   - HOME is a temp dir, so nothing is written to your real ~/.claude.
# Usage: tests/smoke_install.sh [foreman source dir]     (default: the tree this script is in)
# Leaves the temp dir for inspection and prints its path. Exit 0 = every check passed.
set -uo pipefail
SRC="$(cd "${1:-$(dirname "$0")/..}" && pwd)"
T="$(mktemp -d /tmp/ahi-fm-smoke.XXXXXX)"
export HOME="$T/home" AHI_HOME="$T/ahi" TMUX_TMPDIR="$T/tmux" GATEWAY_URL="http://127.0.0.1:9"
unset TMUX FOREMAN_ROOT BUILDS_DIR FM_LIVE_REGISTRY CLAUDE_CODE_OAUTH_TOKEN
mkdir -p "$HOME/.claude" "$HOME/bin" "$AHI_HOME" "$TMUX_TMPDIR" "$T/work"
pass=0 fail=0
ok()  { pass=$((pass + 1)); echo "  ✓ $*"; }
bad() { fail=$((fail + 1)); echo "  ✗ $*"; }
check() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi; }

# A stub runtime: draws a "❯ " composer (what the launcher's submit check reads), echoes every line
# typed into it, never calls a model.
cat > "$HOME/bin/claude" <<'EOF'
#!/usr/bin/env bash
case " $* " in *" -p "*) exit 0 ;; esac            # headless probes: succeed silently
echo "stub claude $*"
while IFS= read -r -e -p "❯ " line; do echo "got: $line"; done   # draws a composer line like the real TUI
EOF
chmod +x "$HOME/bin/claude"
export AHI_FM_CLAUDE_BIN="$HOME/bin/claude"
# A login file that is merely unexpired — no secret in it.
printf '{"claudeAiOauth":{"expiresAt":%s000}}\n' "$(( $(date +%s) + 86400 ))" > "$HOME/.claude/.credentials.json"

echo "1. install into $AHI_HOME"
cp -a "$SRC" "$AHI_HOME/foreman"
check "fm_setup.sh runs"               bash "$AHI_HOME/foreman/bin/fm_setup.sh"
check "QUEUE.md seeded"                test -f "$AHI_HOME/foreman/QUEUE.md"
check "ACTIVE-GATES.md seeded"         test -f "$AHI_HOME/foreman/ACTIVE-GATES.md"
FM="$AHI_HOME/foreman/bin"
check "gates check passes"             bash -c "source '$FM/fm_gates.sh' && fm_gates_check"

echo "2. dummy build start"
git -C "$T/work" init -q && git -C "$T/work" -c user.email=smoke -c user.name=smoke \
  commit -q --allow-empty -m init
out="$("$FM/build_start.sh" -r claude -m claude-opus-5-5 -e high -w "smoke test of a fresh foreman install" \
  tzali smoke "$T/work" "Smoke test brief: reply ok and stop." 2>&1)"; rc=$?
echo "$out" | tail -5 | sed 's/^/    | /'
ID="$(printf '%s\n' "$out" | sed -n 's/^BUILD_ID=//p' | tail -1)"
[ "$rc" -eq 0 ] && [ -n "$ID" ] && ok "build_start → $ID" || bad "build_start rc=$rc"
check "meta.json written once"         test -f "$AHI_HOME/foreman/builds/$ID/meta.json"
check "gates installed in the build"   test -f "$T/work/.foreman/ACTIVE-GATES.md"
check "deny rails injected"            grep -q '"deny"' "$T/work/.claude/settings.json"
check "tmux session is live"           tmux has-session -t "fm-$ID"

echo "3. status and steer"
check "build_status lists it"          bash -c "'$FM/build_status.sh' | grep -q '$ID'"
check "build_status <id>"              "$FM/build_status.sh" "$ID"
check "build_say types into the pane"  "$FM/build_say.sh" "$ID" "smoke steer"
check "steer reached the session"      bash -c "for _ in \$(seq 25); do tmux capture-pane -pt 'fm-$ID' | grep -q 'got: smoke steer' && exit 0; sleep 0.2; done; exit 1"

echo "4. close"
check "build_done done"                "$FM/build_done.sh" "$ID" done
check "status derived as done"         bash -c "source '$FM/lib.sh' && [ \"\$(fm_status '$ID')\" = done ]"
check "tmux session gone"              bash -c "! tmux has-session -t 'fm-$ID'"

echo "5. close the LAST build while the queue still has work (the chain must name it, not abort)"
echo "- [ ] queued smoke item: tidy the readme" >> "$AHI_HOME/foreman/QUEUE.md"
out="$("$FM/build_start.sh" -r claude -m claude-opus-5-5 -e high -w "smoke test of the close chain with a queued item" \
  tzali smoke-chain "$T/work" "Smoke test brief: reply ok and stop." 2>&1)"
ID2="$(printf '%s\n' "$out" | sed -n 's/^BUILD_ID=//p' | tail -1)"
[ -n "$ID2" ] && ok "second build → $ID2" || bad "second build_start failed"
out="$("$FM/build_done.sh" "$ID2" done 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "build_done exits 0 with a queued item" || bad "build_done rc=$rc"
printf '%s' "$out" | grep -q "unbound variable" && bad "build_done hit an unbound variable" || ok "no unbound variable"
check "the close wake names the queued item" bash -c "cat '$AHI_HOME/foreman/refused-wakes.log' '$AHI_HOME/foreman/failed-wakes.log' '$AHI_HOME/foreman/pending-wakes/'*.wake 2>/dev/null | grep -q 'queued smoke item'"

echo "6. a host app whose AHI_HOME is not the foreman's home (FM_AHI_HOME wins)"
got="$(FM_AHI_HOME="$AHI_HOME" AHI_HOME="$T/host-app" bash -c 'unset FOREMAN_ROOT; source "$0"; echo "$FOREMAN_ROOT"' "$FM/lib.sh")"
[ "$got" = "$AHI_HOME/foreman" ] && ok "lib.sh resolves the foreman under FM_AHI_HOME" || bad "FOREMAN_ROOT=$got"
check "fm_gates.py finds the gates under FM_AHI_HOME" env -u FOREMAN_ROOT FM_AHI_HOME="$AHI_HOME" AHI_HOME="$T/host-app" "$FM/fm_gates.py" check

tmux kill-server 2>/dev/null || true          # the private smoke server only (TMUX_TMPDIR)
echo "smoke: $pass passed, $fail failed — temp dir kept at $T"
[ "$fail" -eq 0 ]
