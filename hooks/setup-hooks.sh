#!/bin/bash
#
# Setup script for Claude Code Teams Notification Hook
#
# What it does:
#   1. Copies notify-teams.sh to ~/.claude/hooks/
#   2. Prompts for your Teams webhook URL
#   3. Adds CLAUDE_TEAMS_WEBHOOK_URL to your shell profile
#   4. Adds hook configuration to ~/.claude/settings.json
#
# Usage:
#   ./setup-hooks.sh
#   ./setup-hooks.sh --uninstall
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SCRIPT="notify-teams.sh"
HOOK_SOURCE="$SCRIPT_DIR/$HOOK_SCRIPT"
HOOK_DEST="$HOME/.claude/hooks/$HOOK_SCRIPT"
SETTINGS_FILE="$HOME/.claude/settings.json"

step()  { printf "\n\033[36m>> %s\033[0m\n" "$1"; }
ok()    { printf "   \033[32m[OK]\033[0m %s\n" "$1"; }
warn()  { printf "   \033[33m[!]\033[0m %s\n" "$1"; }
fail()  { printf "   \033[31m[X]\033[0m %s\n" "$1"; }

# ── Uninstall ──
if [ "${1:-}" = "--uninstall" ]; then
  echo ""
  echo -e "\033[35m================================================\033[0m"
  echo -e "\033[35m   Claude Code Teams Hook — Uninstall\033[0m"
  echo -e "\033[35m================================================\033[0m"

  if [ -f "$HOOK_DEST" ]; then
    rm "$HOOK_DEST"
    ok "Removed $HOOK_DEST"
  else
    warn "Hook script not found at $HOOK_DEST"
  fi

  echo ""
  warn "Manual cleanup needed:"
  echo "   1. Remove the 'hooks' section from $SETTINGS_FILE"
  echo "   2. Remove the CLAUDE_TEAMS_WEBHOOK_URL line from your shell profile (~/.bashrc or ~/.zshrc)"
  echo ""
  exit 0
fi

# ── Install ──
echo ""
echo -e "\033[35m================================================\033[0m"
echo -e "\033[35m   Claude Code Teams Notification Hook — Setup\033[0m"
echo -e "\033[35m================================================\033[0m"

# ── 1. Copy hook script ──
step "Installing hook script..."
mkdir -p "$HOME/.claude/hooks"
cp "$HOOK_SOURCE" "$HOOK_DEST"
chmod +x "$HOOK_DEST"
ok "Copied to $HOOK_DEST"

# ── 2. Get webhook URL ──
step "Configuring Teams webhook URL..."
if [ -n "${CLAUDE_TEAMS_WEBHOOK_URL:-}" ]; then
  ok "CLAUDE_TEAMS_WEBHOOK_URL is already set"
  WEBHOOK_URL="$CLAUDE_TEAMS_WEBHOOK_URL"
else
  echo ""
  echo "   You need a Teams Incoming Webhook URL (via Workflow)."
  echo "   To create one:"
  echo "     1. Open Teams -> go to the channel you want notifications in"
  echo "     2. Click '...' next to the channel name -> Workflows"
  echo "     3. Choose 'Post to a channel when a webhook request is received'"
  echo "     4. Pick the channel -> Create -> copy the webhook URL"
  echo ""
  read -rp "   Paste your Teams webhook URL: " WEBHOOK_URL

  if [ -z "$WEBHOOK_URL" ]; then
    fail "No URL provided. You can set it later:"
    echo "   export CLAUDE_TEAMS_WEBHOOK_URL=\"<your-url>\""
    echo "   Then add it to your shell profile (~/.bashrc or ~/.zshrc)"
  else
    # Detect shell profile
    SHELL_PROFILE=""
    if [ -f "$HOME/.zshrc" ]; then
      SHELL_PROFILE="$HOME/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then
      SHELL_PROFILE="$HOME/.bashrc"
    elif [ -f "$HOME/.bash_profile" ]; then
      SHELL_PROFILE="$HOME/.bash_profile"
    fi

    if [ -n "$SHELL_PROFILE" ]; then
      # Check if already present
      if grep -q "CLAUDE_TEAMS_WEBHOOK_URL" "$SHELL_PROFILE" 2>/dev/null; then
        warn "CLAUDE_TEAMS_WEBHOOK_URL already exists in $SHELL_PROFILE — skipping"
      else
        echo "" >> "$SHELL_PROFILE"
        echo "# Claude Code Teams webhook for notify hook" >> "$SHELL_PROFILE"
        echo "export CLAUDE_TEAMS_WEBHOOK_URL=\"$WEBHOOK_URL\"" >> "$SHELL_PROFILE"
        ok "Added to $SHELL_PROFILE"
      fi
      # Export for current session
      export CLAUDE_TEAMS_WEBHOOK_URL="$WEBHOOK_URL"
    else
      warn "Could not find shell profile. Add this to your shell config manually:"
      echo "   export CLAUDE_TEAMS_WEBHOOK_URL=\"$WEBHOOK_URL\""
    fi
  fi
fi

# ── 3. Configure Claude Code settings ──
step "Configuring Claude Code hooks..."

HOOKS_CONFIG='{
  "Stop": [
    {
      "matcher": "",
      "hooks": [
        {
          "type": "command",
          "command": "bash ~/.claude/hooks/notify-teams.sh"
        }
      ]
    }
  ],
  "Notification": [
    {
      "matcher": "elicitation_dialog",
      "hooks": [
        {
          "type": "command",
          "command": "bash ~/.claude/hooks/notify-teams.sh"
        }
      ]
    },
    {
      "matcher": "permission_prompt",
      "hooks": [
        {
          "type": "command",
          "command": "bash ~/.claude/hooks/notify-teams.sh"
        }
      ]
    }
  ]
}'

if [ ! -f "$SETTINGS_FILE" ]; then
  # Create new settings file with hooks
  echo "{\"hooks\": $HOOKS_CONFIG}" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>console.log(JSON.stringify(JSON.parse(d),null,2)));
  ' > "$SETTINGS_FILE"
  ok "Created $SETTINGS_FILE with hooks"
else
  # Merge hooks into existing settings
  EXISTING=$(cat "$SETTINGS_FILE")
  echo "$EXISTING" | node -e "
    const hooks = $HOOKS_CONFIG;
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      const settings = JSON.parse(d);
      settings.hooks = hooks;
      console.log(JSON.stringify(settings, null, 2));
    });
  " > "${SETTINGS_FILE}.tmp" && mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"
  ok "Updated hooks in $SETTINGS_FILE"
fi

# ── 4. Test ──
step "Testing notification..."
if [ -n "${WEBHOOK_URL:-}" ]; then
  TEST_PAYLOAD='{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","content":{"type":"AdaptiveCard","$schema":"http://adaptivecards.io/schemas/adaptive-card.json","version":"1.4","body":[{"type":"TextBlock","text":"Hook setup successful!","weight":"Bolder","size":"Medium","color":"Good"},{"type":"TextBlock","text":"You will now receive Teams notifications when Claude needs your attention.","wrap":true}]}}]}'

  HTTP_CODE=$(echo "$TEST_PAYLOAD" | curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d @- \
    "$WEBHOOK_URL")

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ]; then
    ok "Test notification sent! Check your Teams channel."
  else
    warn "Test notification returned HTTP $HTTP_CODE — verify your webhook URL is correct."
  fi
else
  warn "Skipping test — no webhook URL configured."
fi

echo ""
echo -e "\033[32m================================================\033[0m"
echo -e "\033[32m   Setup complete!\033[0m"
echo -e "\033[32m================================================\033[0m"
echo ""
echo "   You'll now get Teams notifications when Claude:"
echo "     - Stops and waits for your input"
echo "     - Needs permission to run a tool"
echo "     - Asks you to make a decision"
echo ""
echo "   To uninstall:  ./setup-hooks.sh --uninstall"
echo ""
