#!/usr/bin/env bash
#
# One-click setup for Claude Code Web Bridge.
#
# Usage:
#   ./setup.sh                # Setup + start with tunnel + QR code (default)
#   ./setup.sh --local-only   # Setup + start locally without tunnel
#   ./setup.sh --skip-start   # Just install prerequisites
#

set -e

TUNNEL=true
SKIP_START=false

for arg in "$@"; do
  case "$arg" in
    --local-only) TUNNEL=false ;;
    --skip-start) SKIP_START=true ;;
    --help|-h)
      echo "Usage: ./setup.sh [--local-only] [--skip-start]"
      echo "  --local-only  Start without devtunnel (localhost only, no QR code)"
      echo "  --skip-start  Only install prerequisites, don't start the bridge"
      exit 0
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

step()  { printf "\n\033[36m>> %s\033[0m\n" "$1"; }
ok()    { printf "   \033[32m[OK]\033[0m %s\n" "$1"; }
warn()  { printf "   \033[33m[!]\033[0m %s\n" "$1"; }
fail()  { printf "   \033[31m[X]\033[0m %s\n" "$1"; }

echo ""
echo -e "\033[35m================================================\033[0m"
echo -e "\033[35m   Claude Code Web Bridge — Setup\033[0m"
echo -e "\033[35m================================================\033[0m"

# ── 1. Check Node.js ──
step "Checking Node.js..."
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version)
  NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v\([0-9]*\).*/\1/')
  if [ "$NODE_MAJOR" -ge 18 ]; then
    ok "Node.js $NODE_VERSION found"
  else
    fail "Node.js $NODE_VERSION is too old (need v18+)"
    echo "   Install from https://nodejs.org/ or use nvm:"
    echo "   nvm install 18 && nvm use 18"
    exit 1
  fi
else
  fail "Node.js not found."
  if command -v brew &>/dev/null; then
    echo -n "   Install via Homebrew? (Y/n) "
    read -r ans
    if [ "$ans" != "n" ]; then
      brew install node
      ok "Node.js installed"
    else
      fail "Node.js v18+ is required. Install from https://nodejs.org/"
      exit 1
    fi
  else
    echo "   Install from https://nodejs.org/ or:"
    echo "   curl -fsSL https://fnm.vercel.app/install | bash && fnm install 18"
    exit 1
  fi
fi

# ── 2. Check Claude CLI ──
step "Checking Claude Code CLI..."
CLAUDE_FOUND=false
CLAUDE_PATHS=(
  "$HOME/.claude/local/claude"
  "$HOME/.local/bin/claude"
)

for p in "${CLAUDE_PATHS[@]}"; do
  if [ -x "$p" ]; then
    ok "Claude CLI found at $p"
    CLAUDE_FOUND=true
    break
  fi
done

if [ "$CLAUDE_FOUND" = false ] && command -v claude &>/dev/null; then
  ok "Claude CLI found in PATH ($(which claude))"
  CLAUDE_FOUND=true
fi

if [ "$CLAUDE_FOUND" = false ]; then
  warn "Claude Code CLI not found."
  echo -n "   Install via npm? (Y/n) "
  read -r ans
  if [ "$ans" != "n" ]; then
    echo "   Installing Claude Code CLI..."
    npm install -g @anthropic-ai/claude-code
    ok "Claude Code CLI installed"
    echo ""
    warn "You need to authenticate Claude before using the bridge."
    echo "   Run 'claude' in a terminal and follow the login prompts."
    echo -n "   Have you already authenticated? (y/N) "
    read -r ans
    if [ "$ans" != "y" ]; then
      echo "   Opening Claude for authentication..."
      claude || true
    fi
  else
    fail "Claude CLI is required. Install with: npm install -g @anthropic-ai/claude-code"
    exit 1
  fi
fi

# ── 3. Check devtunnel (optional) ──
if [ "$TUNNEL" = true ]; then
  step "Checking devtunnel..."
  if command -v devtunnel &>/dev/null; then
    ok "devtunnel found in PATH"
  else
    warn "devtunnel not found."
    if [[ "$OSTYPE" == "darwin"* ]] && command -v brew &>/dev/null; then
      echo -n "   Install via Homebrew? (Y/n) "
      read -r ans
      if [ "$ans" != "n" ]; then
        brew install --cask devtunnel
        echo ""
        warn "You need to login to devtunnel."
        devtunnel user login
      else
        warn "Skipping devtunnel. Will start in local-only mode."
        TUNNEL=false
      fi
    elif [[ "$OSTYPE" == "linux"* ]]; then
      echo -n "   Install via official script? (Y/n) "
      read -r ans
      if [ "$ans" != "n" ]; then
        curl -sL https://aka.ms/DevTunnelCliInstall | bash
        echo ""
        warn "You need to login to devtunnel."
        devtunnel user login
      else
        warn "Skipping devtunnel. Will start in local-only mode."
        TUNNEL=false
      fi
    else
      warn "Install devtunnel manually: https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/"
      warn "Starting in local-only mode."
      TUNNEL=false
    fi
  fi
fi

# ── 4. Check cloudflared (optional, for Teams integration) ──
step "Checking cloudflared (for Teams integration)..."
if command -v cloudflared &>/dev/null; then
  ok "cloudflared found in PATH"
else
  warn "cloudflared not found (optional - only needed for Teams integration)."
  if [[ "$OSTYPE" == "darwin"* ]] && command -v brew &>/dev/null; then
    echo -n "   Install via Homebrew? (Y/n) "
    read -r ans
    if [ "$ans" != "n" ]; then
      brew install cloudflared
      ok "cloudflared installed"
    else
      warn "Skipping cloudflared. Teams webhook integration will not be available."
    fi
  elif [[ "$OSTYPE" == "linux"* ]]; then
    echo -n "   Install via official script? (Y/n) "
    read -r ans
    if [ "$ans" != "n" ]; then
      curl -sL https://pkg.cloudflare.com/cloudflared-stable-linux-amd64.deb -o /tmp/cloudflared.deb && sudo dpkg -i /tmp/cloudflared.deb
      ok "cloudflared installed"
    else
      warn "Skipping cloudflared. Teams webhook integration will not be available."
    fi
  else
    warn "Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  fi
fi

step "Installing project dependencies..."
cd "$SCRIPT_DIR"
npm install --silent 2>/dev/null || npm install
ok "Dependencies installed"

# ── Start ──
if [ "$SKIP_START" = true ]; then
  echo ""
  echo -e "\033[32m================================================\033[0m"
  echo -e "\033[32m   Setup complete!\033[0m"
  echo -e "\033[32m================================================\033[0m"
  echo ""
  echo "   To start locally:              npm start"
  echo "   To start with tunnel:          npm run start:tunnel"
  echo "   To start with auto-reconnect:  npm run start:tunnel:auto"
  echo "   For Teams webhook tunnel:      npm run cloudflare"
  echo ""
  exit 0
fi

echo ""
echo -e "\033[32m================================================\033[0m"
echo -e "\033[32m   Setup complete — starting bridge...\033[0m"
echo -e "\033[32m================================================\033[0m"
echo ""

cd "$SCRIPT_DIR"
if [ "$TUNNEL" = true ]; then
  echo "   Starting with devtunnel (remote access)..."
  echo "   A QR code will appear — scan it to open on your phone."
  echo ""
  npm run start:tunnel:auto
else
  echo "   Starting in local mode..."
  echo "   Open http://localhost:3847 in your browser."
  echo ""
  npm start
fi
