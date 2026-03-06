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

# ── 5. Configure environment variables ──
step "Configuring environment variables..."
echo "   These values are needed for Teams integration and push notifications."
echo "   Press Enter to skip any value you don't have yet."

# Detect shell profile
SHELL_PROFILE=""
if [ -f "$HOME/.zshrc" ]; then
  SHELL_PROFILE="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  SHELL_PROFILE="$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
  SHELL_PROFILE="$HOME/.bash_profile"
fi

add_env_var() {
  local var_name="$1"
  local var_prompt="$2"
  local current_val="${!var_name:-}"

  if [ -n "$current_val" ]; then
    ok "$var_name is already set"
    return
  fi

  read -rp "   $var_prompt: " input_val
  if [ -n "$input_val" ]; then
    export "$var_name=$input_val"
    if [ -n "$SHELL_PROFILE" ]; then
      if ! grep -q "$var_name" "$SHELL_PROFILE" 2>/dev/null; then
        echo "export $var_name=\"$input_val\"" >> "$SHELL_PROFILE"
      fi
    fi
    ok "$var_name saved"
  else
    warn "Skipped $var_name"
  fi
}

echo ""
echo "   -- Teams Integration --"
add_env_var "TEAMS_WEBHOOK_SECRET" "Teams Outgoing Webhook HMAC secret"
add_env_var "TEAMS_INCOMING_WEBHOOK_URL" "Teams Incoming Webhook URL (via Workflow)"

echo ""
echo "   -- Push Notifications (auto-generated if empty) --"
if [ -z "${VAPID_PUBLIC_KEY:-}" ] || [ -z "${VAPID_PRIVATE_KEY:-}" ]; then
  echo -n "   Generate VAPID keys for web push notifications? (Y/n) "
  read -r ans
  if [ "$ans" != "n" ]; then
    VAPID_KEYS=$(node -e "const wp=require('web-push');const k=wp.generateVAPIDKeys();console.log(k.publicKey+' '+k.privateKey);" 2>/dev/null || echo "")
    if [ -n "$VAPID_KEYS" ]; then
      VAPID_PUB=$(echo "$VAPID_KEYS" | cut -d' ' -f1)
      VAPID_PRIV=$(echo "$VAPID_KEYS" | cut -d' ' -f2)
      export VAPID_PUBLIC_KEY="$VAPID_PUB"
      export VAPID_PRIVATE_KEY="$VAPID_PRIV"
      if [ -n "$SHELL_PROFILE" ]; then
        if ! grep -q "VAPID_PUBLIC_KEY" "$SHELL_PROFILE" 2>/dev/null; then
          echo "export VAPID_PUBLIC_KEY=\"$VAPID_PUB\"" >> "$SHELL_PROFILE"
          echo "export VAPID_PRIVATE_KEY=\"$VAPID_PRIV\"" >> "$SHELL_PROFILE"
        fi
      fi
      ok "VAPID keys generated and saved"
    else
      warn "Could not generate VAPID keys (run npm install first). Skipping."
    fi
  else
    warn "Skipped VAPID keys"
  fi
else
  ok "VAPID keys already set"
fi

echo ""
echo "   -- Optional --"
add_env_var "CLAUDE_TEAMS_WEBHOOK_URL" "Claude Code notify hook webhook URL (for CLI notifications)"

if [ -n "$SHELL_PROFILE" ]; then
  ok "Environment variables saved to $SHELL_PROFILE"
  echo "   Run: source $SHELL_PROFILE  (to load in current session)"
fi

step "Installing project dependencies..."
cd "$SCRIPT_DIR"
npm install --silent 2>/dev/null || npm install
ok "Dependencies installed"

# ── 6. Teams Notification Hook (optional) ──
step "Teams notification hook..."
echo "   Get notified in Teams when Claude needs your attention (stops, asks permission, etc.)"
echo -n "   Set up Teams notification hook? (Y/n) "
read -r ans
if [ "$ans" != "n" ]; then
  if [ -f "$SCRIPT_DIR/hooks/setup-hooks.sh" ]; then
    chmod +x "$SCRIPT_DIR/hooks/setup-hooks.sh"
    bash "$SCRIPT_DIR/hooks/setup-hooks.sh"
  else
    fail "hooks/setup-hooks.sh not found"
  fi
else
  warn "Skipping Teams notification hook. Run hooks/setup-hooks.sh later to set it up."
fi

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
