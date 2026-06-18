#!/usr/bin/env bash
set -euo pipefail

REPO=""
OUTPUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$REPO" && -n "$OUTPUT" ]] || { echo "b3-api-route-audit: --repo and --output required" >&2; exit 2; }
mkdir -p "$(dirname "$OUTPUT")"

DATE="$(date +%F)"
TMP="$(mktemp -t audit_b3.XXXXXX)"
CONSULT="$(mktemp -t audit_b3_consult.XXXXXX)"
trap 'rm -f "$TMP" "$CONSULT"' EXIT

(
  cd "$REPO"
  for base in app src pages; do
    [[ -d "$base" ]] && find "$base" -type f \( -path '*/api/*/route.ts' -o -path '*/api/*.ts' -o -path '*/api/*.tsx' \)
  done | sort |
  while IFS= read -r file; do
    methods="$(rg -n 'export[[:space:]]+async[[:space:]]+function[[:space:]]+(GET|POST|PUT|PATCH|DELETE|OPTIONS)|export[[:space:]]+function[[:space:]]+(GET|POST|PUT|PATCH|DELETE|OPTIONS)' "$file" | sed -E 's/.*function ([A-Z]+).*/\1/' | paste -sd ',' - || true)"
    [[ -z "$methods" ]] && methods="handler"
    first_line="$(rg -n 'export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+(GET|POST|PUT|PATCH|DELETE|OPTIONS)|export[[:space:]]+default|handler' "$file" | head -1 | cut -d: -f1 || true)"
    [[ -z "$first_line" ]] && first_line=1
    if rg -qi 'auth\.getUser|getUser\(|requireAuth|createServerClient|createClient\(|cookies\(|X-.*Key|APPLICATION_INTAKE_KEY|service[_-]role|reveal_pin|PUBLIC|public read|cron' "$file"; then
      status="has-gate-or-public-contract"
    else
      status="missing-obvious-auth-gate"
    fi
    printf "%s\t%s\t%s\t%s\n" "$file" "$first_line" "$methods" "$status"
  done > "$TMP" || true
)

missing="$(awk -F '\t' '$4=="missing-obvious-auth-gate"{c++} END{print c+0}' "$TMP")"
routes="$(wc -l < "$TMP" | tr -d " ")"

if [[ -x "$(cd "$(dirname "$0")/../.." && pwd)/codex-consult/codex_consult.sh" ]]; then
  {
    echo "You are reviewing API auth posture for a Next.js/Supabase CRM. Based on this route inventory, identify the top auth/perf/security risks. Keep it concise and cite route paths when possible."
    echo
    cat "$TMP"
  } | CODEX_TIMEOUT="${CODEX_TIMEOUT:-90}" $(cd "$(dirname "$0")/../.." && pwd)/codex-consult/codex_consult.sh --timeout "${CODEX_TIMEOUT:-90}" > "$CONSULT" 2>&1 || true
fi

{
  echo "# API Route Auth Audit — $(basename "$REPO")"
  echo "Date: $DATE"
  echo "Author: audit-codebase harness"
  echo "Scope: Next.js API route inventory and obvious auth/public-contract detection"
  echo "Method: route file inventory, auth-keyword scan, Codex second opinion"
  echo
  echo "## Summary"
  echo
  echo "- HIGH: 0"
  echo "- MEDIUM: $missing"
  echo "- LOW: 0"
  echo
  echo "Top findings:"
  if [[ "$missing" -eq 0 ]]; then
    echo "1. Every route has either an obvious auth gate or an explicit public/API-key contract."
  else
    echo "1. $missing route(s) lack an obvious route-local auth gate or public contract."
  fi
  echo
  echo "## Inventory"
  echo
  echo "| Item | Path | Status | Notes |"
  echo "|---|---|---|---|"
  while IFS=$'\t' read -r file line methods status; do
    echo "| API route | \`$file\` | $status | methods: $methods; first handler line: $line |"
  done < "$TMP"
  echo
  echo "## Detailed Findings"
  echo
  if [[ "$missing" -eq 0 ]]; then
    echo "No HIGH or MEDIUM findings."
  else
    n=1
    awk -F '\t' '$4=="missing-obvious-auth-gate"{print}' "$TMP" |
    while IFS=$'\t' read -r file line methods status; do
      echo "### MEDIUM-$n: API route lacks obvious route-local auth"
      echo
      echo "[SOURCE: \`$file\` at line $line]"
      echo
      echo "The handler exposes $methods but the harness did not find a direct auth check, API-key gate, service-role-only contract, or explicit public marker in the file."
      echo
      echo "**Recommendation:** Add a route-local auth/public-contract comment at minimum; for private CRM data, require Supabase user auth and role checks inside the handler."
      echo
      n=$((n + 1))
    done
  fi
  echo
  echo "## Codex Second Opinion"
  echo
  if [[ -s "$CONSULT" ]]; then
    sed -n '1,180p' "$CONSULT"
  else
    echo "Codex consult unavailable or returned no output."
  fi
  echo
  echo "## Recommendations (ranked by value / effort)"
  echo
  echo "1. Add explicit \`// PUBLIC\` / \`// API_KEY_PUBLIC\` route annotations where intended — value: high · effort: low."
  echo "2. Move broad public API prefixes out of middleware unless each route has a route-local key/RLS boundary — value: high · effort: medium."
  echo
  echo "## Out of Scope"
  echo
  echo "- Dynamic runtime testing of each endpoint."
  echo "- Supabase RLS correctness, covered by B/2."
} > "$OUTPUT"
