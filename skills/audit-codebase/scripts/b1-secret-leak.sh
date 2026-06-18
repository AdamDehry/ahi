#!/usr/bin/env bash
set -euo pipefail

REPO=""
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    -h|--help) echo "Usage: $0 --repo <path> --output <markdown-path>"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$REPO" && -n "$OUTPUT" ]] || { echo "b1-secret-leak: --repo and --output required" >&2; exit 2; }
[[ -d "$REPO/.git" ]] || { echo "b1-secret-leak: repo is not a git checkout: $REPO" >&2; exit 2; }

mkdir -p "$(dirname "$OUTPUT")"
DATE="$(date +%F)"
TMP="$(mktemp -t audit_b1.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

(
  cd "$REPO"
  git log -p --all --no-ext-diff -- \
    . \
    ':(exclude)package-lock.json' \
    ':(exclude)node_modules' \
    ':(exclude).next' \
    ':(exclude)public/sw.js' \
    ':(exclude)lib/pdf/assets/businessLogo.ts' |
  perl -ne '
    BEGIN {
      @patterns = (
        ["AWS access key", qr/AKIA[0-9A-Z]{16}/],
        ["OpenAI key", qr/sk-[A-Za-z0-9_-]{20,}/],
        ["Anthropic key", qr/sk-ant-[A-Za-z0-9_-]{20,}/],
        ["Stripe secret key", qr/sk_(live|test)_[A-Za-z0-9]{16,}/],
        ["Supabase JWT", qr/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
        ["Private key block", qr/-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/],
        ["Likely committed secret assignment", qr/\b(AUTH_SECRET|JWT_SECRET|SESSION_SECRET|SSN_ENCRYPTION_KEY|SUPABASE_SERVICE_ROLE[_]KEY|RESEND_API_KEY|MICHAEL_BOT_TOKEN|APPLICATION_INTAKE_KEY)\s*=\s*["'\'']?[^"'\''\s#]{12,}/]
      );
      $commit = "";
      $file = "";
      $line = 0;
    }
    if (/^commit ([0-9a-f]{7,40})/) { $commit = $1; next; }
    if (/^\+\+\+ b\/(.+)/) { $file = $1; $line = 0; next; }
    if (/^@@ .* \+(\d+)/) { $line = $1 - 1; next; }
    if (/^\+/ && !/^\+\+\+/) {
      $line++;
      my $text = substr($_, 1);
      next if $file =~ /^(\.env\.example|README|docs\/)/ && $text =~ /=\s*$/;
      for my $p (@patterns) {
        my ($name, $re) = @$p;
        if ($text =~ /$re/) {
          my $preview = $text;
          chomp $preview;
          $preview =~ s/(=)\s*["'\'']?([^"'\''\s#]{4})[^"'\''\s#]+/$1 $2****/g;
          $preview =~ s/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/$1****/g;
          $preview =~ s/(eyJ[A-Za-z0-9_-]{8})[A-Za-z0-9._-]+/$1****/g;
          print "$name\t$commit\t$file\t$line\t$preview\n";
        }
      }
    } elsif (/^ /) {
      $line++;
    }
  ' | sort -u > "$TMP"

  tracked_env="$(git ls-files '.env*' || true)"
  ignored_env="$(git check-ignore .env.local .env 2>/dev/null || true)"
  gitignore_has_env="no"
  grep -Eq '(^|/)\.env(\*|\.|$)|\.env\*\.local' .gitignore && gitignore_has_env="yes"

  count="$(wc -l < "$TMP" | tr -d " ")"
  tracked_env_count="$(printf "%s\n" "$tracked_env" | sed '/^$/d' | grep -vc '^\.env\.example$' || true)"

  {
    echo "# Secret Leak Audit — $(basename "$REPO")"
    echo "Date: $DATE"
    echo "Author: audit-codebase harness"
    echo "Scope: Git history secret pickaxe + tracked .env hygiene"
    echo "Method: git log patch scan for known secret patterns; git ls-files/check-ignore for env-file hygiene"
    echo
    echo "## Summary"
    high=$(( count + tracked_env_count ))
    echo
    echo "- HIGH: $high"
    echo "- MEDIUM: 0"
    echo "- LOW: 0"
    echo
    if [[ "$high" -eq 0 ]]; then
      echo "Top findings: none. B/1 is clean."
    else
      echo "Top findings:"
      echo "1. Potential committed secret material found. Rotate affected credentials before exposing code to PR bots."
    fi
    echo
    echo "## Inventory"
    echo
    echo "| Item | Path | Status | Notes |"
    echo "|---|---|---|---|"
    echo "| Git history | all refs | checked | $count pattern hit(s) |"
    echo "| Tracked env files | .env* | checked | $(printf "%s" "$tracked_env" | tr "\n" " " | sed "s/[[:space:]]*$//") |"
    echo "| Env ignore rule | .gitignore | checked | env ignore present: $gitignore_has_env; ignored envs: $(printf "%s" "$ignored_env" | tr "\n" " " | sed "s/[[:space:]]*$//") |"
    echo
    echo "## Detailed Findings"
    echo
    if [[ "$high" -eq 0 ]]; then
      echo "No HIGH or MEDIUM findings."
    else
      n=1
      if [[ "$tracked_env_count" -gt 0 ]]; then
        while IFS= read -r envfile; do
          [[ -z "$envfile" || "$envfile" == ".env.example" ]] && continue
          echo "### HIGH-$n: Tracked env file"
          echo
          echo "[SOURCE: \`$envfile\` at line 1]"
          echo
          echo "A non-example env file is tracked. Remove from git history and rotate any contained credentials."
          echo
          echo "**Recommendation:** Remove the file from tracking, purge/rotate any real values, and keep only sanitized \`.env.example\` templates."
          echo
          n=$((n + 1))
        done <<< "$tracked_env"
      fi
      while IFS=$'\t' read -r name commit file line preview; do
        [[ -z "${name:-}" ]] && continue
        echo "### HIGH-$n: $name in git history"
        echo
        echo "[SOURCE: commit \`${commit:0:12}\` at \`$file:$line\`]"
        echo
        echo "Masked preview: \`$preview\`"
        echo
        echo "**Recommendation:** Treat the credential as exposed, rotate it, then purge it from history if needed."
        echo
        n=$((n + 1))
      done < "$TMP"
    fi
    echo
    echo "## Recommendations (ranked by value / effort)"
    echo
    echo "1. Keep \`.env.local\` untracked and \`.env.example\` value-free — value: high · effort: low."
    echo "2. Re-run this phase before opening bot-visible PRs after large imports or emergency deploys — value: high · effort: low."
    echo
    echo "## Out of Scope"
    echo
    echo "- Secret validity was not tested."
    echo "- Remote secret stores such as Vercel and Supabase project settings were not inspected."
  } > "$OUTPUT"

  [[ "$high" -eq 0 ]] || exit 10
)
