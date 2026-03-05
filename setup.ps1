#Requires -Version 5.1
<#
.SYNOPSIS
    One-click setup for Claude Code Web Bridge.
.DESCRIPTION
    Checks prerequisites (Node.js, Claude CLI, devtunnel),
    installs missing pieces, runs npm install, and starts the bridge.
.PARAMETER LocalOnly
    Start without devtunnel (localhost only, no QR code).
.PARAMETER SkipStart
    Only install prerequisites, don't start the bridge.
.EXAMPLE
    .\setup.ps1              # Setup + start with tunnel + QR code (default)
    .\setup.ps1 -LocalOnly   # Setup + start locally without tunnel
    .\setup.ps1 -SkipStart   # Just install prerequisites
#>
param(
    [switch]$LocalOnly,
    [switch]$SkipStart
)

# Default is tunnel mode; use -LocalOnly to skip tunnel
$Tunnel = -not $LocalOnly

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host ("`n>> " + $msg) -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host ("   [OK] " + $msg) -ForegroundColor Green }
function Write-Warn($msg) { Write-Host ("   [!] " + $msg) -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host ("   [X] " + $msg) -ForegroundColor Red }

function Refresh-Path {
    $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = $machinePath + ';' + $userPath
}

Write-Host ''
Write-Host '================================================' -ForegroundColor Magenta
Write-Host '   Claude Code Web Bridge - Setup' -ForegroundColor Magenta
Write-Host '================================================' -ForegroundColor Magenta

# -- 1. Check Node.js --
Write-Step 'Checking Node.js...'
$nodeVersion = $null
try {
    $nodeOutput = & node --version 2>$null
    if ($nodeOutput -match 'v(\d+)') {
        $major = [int]$Matches[1]
        if ($major -ge 18) {
            Write-Ok "Node.js $nodeOutput found"
            $nodeVersion = $nodeOutput
        } else {
            Write-Fail "Node.js $nodeOutput is too old (need v18+)"
        }
    }
} catch {}

if (-not $nodeVersion) {
    Write-Warn 'Node.js v18+ is required but not found.'
    $install = Read-Host '   Install Node.js LTS via winget? (Y/n)'
    if ($install -ne 'n') {
        Write-Host '   Installing Node.js LTS...' -ForegroundColor Gray
        & winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        Refresh-Path
        $nodeCheck = & node --version 2>$null
        if ($nodeCheck) {
            Write-Ok "Node.js $nodeCheck installed"
        } else {
            Write-Fail 'Node.js installation failed. Please install manually from https://nodejs.org/'
            Write-Host '   After installing, close and reopen this terminal, then run setup.ps1 again.' -ForegroundColor Yellow
            exit 1
        }
    } else {
        Write-Fail 'Node.js is required. Install from https://nodejs.org/ and re-run this script.'
        exit 1
    }
}

# -- 2. Check Claude CLI --
Write-Step 'Checking Claude Code CLI...'
$claudeFound = $false
$claudePaths = @(
    (Join-Path $env:USERPROFILE '.claude\local\claude.exe'),
    (Join-Path $env:USERPROFILE '.local\bin\claude.exe')
)
if ($env:APPDATA) {
    $claudePaths += (Join-Path $env:APPDATA 'npm\claude.cmd')
}

foreach ($p in $claudePaths) {
    if (Test-Path $p) {
        Write-Ok "Claude CLI found at $p"
        $claudeFound = $true
        break
    }
}

if (-not $claudeFound) {
    $claudeInPath = Get-Command claude -ErrorAction SilentlyContinue
    if ($claudeInPath) {
        Write-Ok ('Claude CLI found in PATH (' + $claudeInPath.Source + ')')
        $claudeFound = $true
    }
}

if (-not $claudeFound) {
    Write-Warn 'Claude Code CLI not found.'
    $install = Read-Host '   Install via npm? (Y/n)'
    if ($install -ne 'n') {
        Write-Host '   Installing Claude Code CLI...' -ForegroundColor Gray
        & npm install -g @anthropic-ai/claude-code
        if ($LASTEXITCODE -eq 0) {
            Write-Ok 'Claude Code CLI installed'
            Write-Host ''
            Write-Warn 'You need to authenticate Claude before using the bridge.'
            Write-Host '   Run "claude" in a terminal and follow the login prompts.' -ForegroundColor Yellow
            $skipAuth = Read-Host '   Have you already authenticated? (y/N)'
            if ($skipAuth -ne 'y') {
                Write-Host '   Opening Claude for authentication...' -ForegroundColor Gray
                & claude
            }
        } else {
            Write-Fail 'Failed to install Claude CLI. Run manually: npm install -g @anthropic-ai/claude-code'
            exit 1
        }
    } else {
        Write-Fail 'Claude CLI is required. Install with: npm install -g @anthropic-ai/claude-code'
        exit 1
    }
}

# -- 3. Check devtunnel (optional) --
if ($Tunnel) {
    Write-Step 'Checking devtunnel...'
    $dtFound = $false
    $dtPaths = @(
        (Join-Path $env:USERPROFILE '.claude\devtunnel.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\devtunnel.exe')
    )

    foreach ($p in $dtPaths) {
        if (Test-Path $p) {
            Write-Ok "devtunnel found at $p"
            $dtFound = $true
            break
        }
    }

    if (-not $dtFound) {
        $dtInPath = Get-Command devtunnel -ErrorAction SilentlyContinue
        if ($dtInPath) {
            Write-Ok 'devtunnel found in PATH'
            $dtFound = $true
        }
    }

    if (-not $dtFound) {
        Write-Warn 'devtunnel not found.'
        $install = Read-Host '   Install via winget? (Y/n)'
        if ($install -ne 'n') {
            Write-Host '   Installing devtunnel...' -ForegroundColor Gray
            & winget install Microsoft.devtunnel --accept-source-agreements --accept-package-agreements
            Refresh-Path
            Write-Host ''
            Write-Warn 'You need to login to devtunnel.'
            Write-Host '   Running devtunnel user login...' -ForegroundColor Gray
            & devtunnel user login
        } else {
            Write-Warn 'Skipping devtunnel. Will start in local-only mode.'
            $Tunnel = $false
        }
    }
}

# -- 4. Check cloudflared (optional, for Teams integration) --
Write-Step 'Checking cloudflared (for Teams integration)...'
$cfFound = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cfFound) {
    $cfPath = Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'
    if (Test-Path $cfPath) { $cfFound = $true }
}
if ($cfFound) {
    Write-Ok 'cloudflared found'
} else {
    Write-Warn 'cloudflared not found (optional - only needed for Teams integration).'
    $install = Read-Host '   Install via winget? (Y/n)'
    if ($install -ne 'n') {
        Write-Host '   Installing cloudflared...' -ForegroundColor Gray
        & winget install Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements
        Refresh-Path
        Write-Ok 'cloudflared installed'
    } else {
        Write-Warn 'Skipping cloudflared. Teams webhook integration will not be available.'
    }
}

Write-Step 'Installing project dependencies...'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $projectDir
try {
    & npm install 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Ok 'Dependencies installed'
    } else {
        & npm install
        if ($LASTEXITCODE -ne 0) {
            Write-Fail 'npm install failed. Check errors above.'
            exit 1
        }
    }
} finally {
    Pop-Location
}

# -- Start --
if ($SkipStart) {
    Write-Host ''
    Write-Host '================================================' -ForegroundColor Green
    Write-Host '   Setup complete!' -ForegroundColor Green
    Write-Host '================================================' -ForegroundColor Green
    Write-Host ''
    Write-Host '   To start locally:              npm start' -ForegroundColor White
    Write-Host '   To start with tunnel:          npm run start:tunnel' -ForegroundColor White
    Write-Host '   To start with auto-reconnect:  npm run start:tunnel:auto' -ForegroundColor White
    Write-Host '   For Teams webhook tunnel:      npm run cloudflare' -ForegroundColor White
    Write-Host ''
    exit 0
}

Write-Host ''
Write-Host '================================================' -ForegroundColor Green
Write-Host '   Setup complete - starting bridge...' -ForegroundColor Green
Write-Host '================================================' -ForegroundColor Green
Write-Host ''

Push-Location $projectDir
try {
    if ($Tunnel) {
        Write-Host '   Starting with devtunnel (remote access)...' -ForegroundColor Gray
        Write-Host '   A QR code will appear - scan it to open on your phone.' -ForegroundColor Gray
        Write-Host ''
        & npm run start:tunnel:auto
    } else {
        Write-Host '   Starting in local mode...' -ForegroundColor Gray
        Write-Host '   Open http://localhost:3847 in your browser.' -ForegroundColor Gray
        Write-Host ''
        & npm start
    }
} finally {
    Pop-Location
}
