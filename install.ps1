# AHI Suite — Windows installer bootstrap.
#
# Thin shim that verifies prerequisites and hands off to the cross-platform
# Node wizard at installer\lib\wizard.js.

$ErrorActionPreference = 'Stop'

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Wizard  = Join-Path $RepoDir 'installer\lib\wizard.js'

function Write-Color {
    param([string]$Color, [string]$Text)
    Write-Host $Text -ForegroundColor $Color
}

Write-Color White "AHI Suite Installer"
Write-Host "-------------------"
Write-Host ""

# ─── Prereq: git ─────────────────────────────────────────────────────────
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Write-Color Red "git is not installed."
    Write-Host ""
    Write-Host "Install git:"
    Write-Host "  - winget: winget install Git.Git"
    Write-Host "  - official installer: https://git-scm.com/download/win"
    Write-Host ""
    Write-Host "Then re-run this installer."
    exit 1
}
Write-Color Green "Found git"

# ─── Prereq: Node 20+ ────────────────────────────────────────────────────
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Color Red "Node.js is not installed."
    Write-Host ""
    Write-Host "AHI needs Node.js 20 or newer."
    Write-Host ""
    Write-Host "Install Node.js from one of:"
    Write-Host "  - Official installer:  https://nodejs.org/en/download"
    Write-Host "  - winget:              winget install OpenJS.NodeJS.LTS"
    Write-Host ""
    Write-Host "Then re-run this installer."
    exit 1
}

$nodeRaw = (& node -v) 2>$null
if ($nodeRaw -notmatch '^v(\d+)\.(\d+)\.(\d+)') {
    Write-Color Red "Could not parse Node version from 'node -v' (got: '$nodeRaw')."
    Write-Host "Reinstall Node from https://nodejs.org/en/download and try again."
    exit 1
}
$nodeMajor = [int]$Matches[1]
$nodeVersion = $nodeRaw.TrimStart('v')
if ($nodeMajor -lt 20) {
    Write-Color Red "Node.js $nodeVersion is too old. AHI needs 20+."
    Write-Host "Update Node and re-run this installer."
    exit 1
}
Write-Color Green "Found Node.js v$nodeVersion"

# ─── Prereq: npm ─────────────────────────────────────────────────────────
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Color Red "npm is missing — it should ship with Node.js."
    Write-Host "Reinstall Node.js from https://nodejs.org/en/download and try again."
    exit 1
}

# ─── Sanity: wizard exists ───────────────────────────────────────────────
if (-not (Test-Path $Wizard)) {
    Write-Color Red "Installer is incomplete — missing $Wizard"
    Write-Host "Re-clone the repo or download a fresh release."
    exit 1
}

# ─── Hand off to the Node wizard ─────────────────────────────────────────
& node $Wizard @args
exit $LASTEXITCODE
