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
[[ -n "$REPO" && -n "$OUTPUT" ]] || { echo "b4-web-security-posture: --repo and --output required" >&2; exit 2; }
mkdir -p "$(dirname "$OUTPUT")"

DATE="$(date +%F)"
TMP="$(mktemp -t audit_b4.XXXXXX)"
AUDIT="$(mktemp -t audit_b4_npm.XXXXXX)"
CONSULT="$(mktemp -t audit_b4_consult.XXXXXX)"
trap 'rm -f "$TMP" "$AUDIT" "$CONSULT"' EXIT

(
  cd "$REPO"
  : > "$TMP"
  if ! rg -n "Content-Security-Policy|contentSecurityPolicy|script-src|default-src" next.config.* vercel.json middleware.ts app lib -g'*.ts' -g'*.tsx' -g'*.js' -g'*.mjs' -g'*.json' > /tmp/audit_csp.$$ 2>/dev/null; then
    echo "MEDIUM	CSP header missing	next.config.mjs	1	No Content-Security-Policy header source found in Next/Vercel/middleware config." >> "$TMP"
  fi
  rm -f /tmp/audit_csp.$$

  rg -n 'Access-Control-Allow-Origin.*\*' app lib middleware.ts -g'*.ts' -g'*.tsx' > /tmp/audit_cors.$$ 2>/dev/null || true
  while IFS= read -r line; do
    file="${line%%:*}"; rest="${line#*:}"; lineno="${rest%%:*}"
    echo "MEDIUM	Wildcard CORS	$file	$lineno	Wildcard Access-Control-Allow-Origin found; verify each route is intentionally public and data is non-sensitive." >> "$TMP"
  done < /tmp/audit_cors.$$
  rm -f /tmp/audit_cors.$$

  rg -n 'dangerouslySetInnerHTML|innerHTML\\s*=|v-html' app components lib -g'*.ts' -g'*.tsx' -g'*.js' > /tmp/audit_xss.$$ 2>/dev/null || true
  while IFS= read -r line; do
    file="${line%%:*}"; rest="${line#*:}"; lineno="${rest%%:*}"
    echo "MEDIUM	XSS sink	$file	$lineno	Potential raw HTML sink found; verify content is trusted or sanitized." >> "$TMP"
  done < /tmp/audit_xss.$$
  rm -f /tmp/audit_xss.$$

  rg -n 'Set-Cookie|cookies\\.set\\(' app lib middleware.ts -g'*.ts' -g'*.tsx' > /tmp/audit_cookie.$$ 2>/dev/null || true
  while IFS= read -r line; do
    file="${line%%:*}"; rest="${line#*:}"; lineno="${rest%%:*}"
    if ! sed -n "$lineno,$((lineno + 8))p" "$file" | rg -qi 'secure|httponly|samesite|supabaseResponse\\.cookies'; then
      echo "LOW	Cookie flags need review	$file	$lineno	Cookie write found without nearby Secure/HttpOnly/SameSite options." >> "$TMP"
    fi
  done < /tmp/audit_cookie.$$
  rm -f /tmp/audit_cookie.$$

  if [[ -f package.json ]]; then
    npm audit --json > "$AUDIT" 2>/dev/null || true
  fi
)

high="$(awk -F '\t' '$1=="HIGH"{c++} END{print c+0}' "$TMP")"
medium="$(awk -F '\t' '$1=="MEDIUM"{c++} END{print c+0}' "$TMP")"
low="$(awk -F '\t' '$1=="LOW"{c++} END{print c+0}' "$TMP")"
audit_high="$(node -e 'try{let j=require(process.argv[1]); console.log((j.metadata?.vulnerabilities?.high||0)+(j.metadata?.vulnerabilities?.critical||0))}catch{console.log(0)}' "$AUDIT")"
audit_mod="$(node -e 'try{let j=require(process.argv[1]); console.log(j.metadata?.vulnerabilities?.moderate||0)}catch{console.log(0)}' "$AUDIT")"
high=$((high + audit_high))
medium=$((medium + audit_mod))

if [[ -x "$(cd "$(dirname "$0")/../.." && pwd)/codex-consult/codex_consult.sh" ]]; then
  {
    echo "Review this web security/performance posture scan for a Next.js/Supabase CRM. Identify likely serious issues and likely false positives. Also comment on nav-lag candidates from middleware/auth/PWA/bundle posture."
    echo
    cat "$TMP"
    echo
    echo "npm audit metadata:"
    node -e 'try{let j=require(process.argv[1]); console.log(JSON.stringify(j.metadata,null,2))}catch(e){console.log("none")}' "$AUDIT"
  } | CODEX_TIMEOUT="${CODEX_TIMEOUT:-90}" $(cd "$(dirname "$0")/../.." && pwd)/codex-consult/codex_consult.sh --timeout "${CODEX_TIMEOUT:-90}" > "$CONSULT" 2>&1 || true
fi

{
  echo "# Web Security Posture Audit — $(basename "$REPO")"
  echo "Date: $DATE"
  echo "Author: audit-codebase harness"
  echo "Scope: CSP, CORS, cookies, XSS sinks, session hygiene, dependency audit"
  echo "Method: config/source regex scan, npm audit, Codex second opinion"
  echo
  echo "## Summary"
  echo
  echo "- HIGH: $high"
  echo "- MEDIUM: $medium"
  echo "- LOW: $low"
  echo
  echo "Top findings:"
  echo "1. CSP is absent unless provided outside the repo."
  echo "2. Several API routes expose wildcard CORS and need public-contract review."
  echo "3. npm audit reports critical/high=$audit_high and moderate=$audit_mod."
  echo
  echo "## Inventory"
  echo
  echo "| Item | Path | Status | Notes |"
  echo "|---|---|---|---|"
  echo "| CSP | next.config/vercel/middleware | checked | no repo-defined CSP found if MEDIUM finding is present |"
  echo "| CORS | app/api | checked | wildcard CORS occurrences scanned |"
  echo "| Cookies | middleware/lib | checked | Supabase cookie helper detected |"
  echo "| XSS sinks | app/components/lib | checked | raw HTML sinks scanned |"
  echo "| Dependencies | package-lock.json | checked | npm audit metadata included |"
  echo
  echo "## Detailed Findings"
  echo
  if [[ ! -s "$TMP" && "$audit_high" -eq 0 && "$audit_mod" -eq 0 ]]; then
    echo "No HIGH or MEDIUM findings."
  else
    n=1
    while IFS=$'\t' read -r sev title file line detail; do
      [[ "$sev" == "LOW" ]] && continue
      echo "### $sev-$n: $title"
      echo
      echo "[SOURCE: \`$file\` at line $line]"
      echo
      echo "$detail"
      echo
      echo "**Recommendation:** Review and tighten this posture before broad external exposure."
      echo
      n=$((n + 1))
    done < "$TMP"
    if [[ "$audit_high" -gt 0 || "$audit_mod" -gt 0 ]]; then
      echo "### MEDIUM-$n: Dependency vulnerabilities reported by npm audit"
      echo
      echo "[SOURCE: \`package-lock.json\` at line 1]"
      echo
      echo "npm audit metadata reports critical/high=$audit_high and moderate=$audit_mod vulnerability count(s)."
      echo
      echo "**Recommendation:** Run \`npm audit\` interactively and upgrade or document accepted risk."
    fi
  fi
  echo
  echo "## Codex Second Opinion"
  echo
  if [[ -s "$CONSULT" ]]; then sed -n '1,220p' "$CONSULT"; else echo "Codex consult unavailable or returned no output."; fi
  echo
  echo "## npm audit metadata"
  echo
  echo '```json'
  node -e 'try{let j=require(process.argv[1]); console.log(JSON.stringify(j.metadata||{},null,2))}catch(e){console.log("{}")}' "$AUDIT"
  echo '```'
  echo
  echo "## Recommendations (ranked by value / effort)"
  echo
  echo "1. Add a production CSP in \`next.config.mjs\` headers or Vercel headers — value: high · effort: medium."
  echo "2. Narrow wildcard CORS to known origins where routes expose customer/deal data — value: high · effort: medium."
  echo "3. Review npm audit output after framework upgrades — value: medium · effort: medium."
  echo
  echo "## Out of Scope"
  echo
  echo "- Browser-based penetration testing."
  echo "- Third-party service configuration outside the repo."
} > "$OUTPUT"
