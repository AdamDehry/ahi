#!/usr/bin/env bash
# memory-fetch — H-034 lazy-loader for AHI memory addressed by Sha'ar/Shoresh.
#
# Pure shell wrapper that delegates to the Node CLI at memory_fetch.mjs.
# Kept thin so the skill surface (this script) stays trivial to audit and
# the heavy lifting (index parsing, address resolution, output rendering)
# lives in JS where it belongs.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/memory_fetch.mjs" "$@"
