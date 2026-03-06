---
name: setup
description: Set up and run the Claude Code Web Bridge end to end — installs prerequisites, configures environment variables, sets up Teams notification hook, and starts the server.
---

# Instructions

When the user runs `/setup`, perform the following steps in order. Do NOT ask questions unless a step explicitly says to. Run commands from the project root directory.

## Step 1: Detect platform

Detect if running on Windows (PowerShell available) or macOS/Linux. Use this to determine how to set environment variables:
- **Windows**: Use `powershell.exe -Command "[System.Environment]::SetEnvironmentVariable('NAME', 'VALUE', 'User')"` for persistence
- **macOS/Linux**: Append `export NAME="VALUE"` to `~/.bashrc` or `~/.zshrc`

## Step 2: Check prerequisites

Check each prerequisite and report status. If missing, offer to install:

1. **Node.js v18+**: Run `node --version`. If missing or too old:
   - Windows: `winget install OpenJS.NodeJS.LTS`
   - macOS: `brew install node`
   - Linux: `curl -fsSL https://fnm.vercel.app/install | bash && fnm install 18`

2. **Claude Code CLI**: Check these paths in order, then PATH:
   - `~/.claude/local/claude` or `~/.claude/local/claude.exe`
   - `~/.local/bin/claude` or `~/.local/bin/claude.exe`
   - `which claude` or `where claude`
   - If missing: `npm install -g @anthropic-ai/claude-code`, then remind user to run `claude` to authenticate

3. **devtunnel** (optional, for remote access): Check PATH for `devtunnel`.
   - Windows: `winget install Microsoft.devtunnel`
   - macOS: `brew install --cask devtunnel`
   - Linux: `curl -sL https://aka.ms/DevTunnelCliInstall | bash`
   - After install: `devtunnel user login`

4. **cloudflared** (optional, for Teams webhook): Check PATH for `cloudflared`.
   - Windows: `winget install Cloudflare.cloudflared`
   - macOS: `brew install cloudflared`

## Step 3: Install dependencies

```bash
npm install
```

## Step 4: Start Cloudflare tunnel (for Teams integration)

Before configuring Teams environment variables, start the Cloudflare tunnel so the user has the callback URL needed for creating the Teams Outgoing Webhook.

Ask: "Do you want to set up Teams integration? This requires a Cloudflare tunnel. (Y/n)"

If yes:
1. Start the Cloudflare tunnel in the background:
   ```bash
   npm run cloudflare
   ```
   Use `run_in_background` for this command.

2. Wait a few seconds, then read the Cloudflare URL from `~/.claude-web-bridge/cf-url.txt`.

3. Display the Cloudflare URL prominently and tell the user:
   - "Your Cloudflare tunnel URL: `<URL>`"
   - "Your Teams webhook callback URL: `<URL>/api/teams-webhook`"
   - "You'll need this callback URL in the next step when creating the Teams Outgoing Webhook."
   - "IMPORTANT: Keep this terminal/process running. The URL stays stable as long as the Cloudflare tunnel process is alive. If you stop it, you'll get a new URL and need to update the Teams webhook."

If no, skip this step.

## Step 5: Configure environment variables

Ask the user for each value. If the environment variable is already set, show it and skip. For each value provided, persist it using the platform-appropriate method from Step 1.

Ask in this order:

1. **TEAMS_WEBHOOK_SECRET** — First explain the steps to create the outgoing webhook:
   - "To create a Teams Outgoing Webhook:"
   - "  1. Open Teams -> go to the channel where you want Claude"
   - "  2. Click '...' next to the channel name -> Manage channel"
   - "  3. Go to Apps tab -> Create an outgoing webhook"
   - "  4. Fill in:"
   - "     - Name: ClaudeCode"
   - "     - Callback URL: `<CLOUDFLARE_URL>/api/teams-webhook`" (use the URL from Step 4 if available, otherwise tell them to get it from `npm run cloudflare`)
   - "     - Description: Chat with Claude Code"
   - "  5. Click Create -> copy the HMAC security token"
   - "Enter the HMAC security token from the step above. Press Enter to skip."

2. **TEAMS_INCOMING_WEBHOOK_URL** — First explain:
   - "To create a Teams Incoming Webhook (for long responses):"
   - "  1. In the same Teams channel, click '...' -> Workflows"
   - "  2. Choose 'Post to a channel when a webhook request is received'"
   - "  3. Pick the same channel -> Create -> copy the webhook URL"
   - "Enter the webhook URL. Press Enter to skip."

3. **VAPID keys** — Ask "Generate VAPID keys for web push notifications? (Y/n)". If yes, run:
   ```bash
   node -e "const wp=require('web-push');const k=wp.generateVAPIDKeys();console.log(JSON.stringify(k));"
   ```
   Save both `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.

4. **CLAUDE_TEAMS_WEBHOOK_URL** — "Enter your Teams webhook URL for Claude Code CLI notifications (same as TEAMS_INCOMING_WEBHOOK_URL if you want notifications in the same channel). Press Enter to skip."

## Step 6: Set up Teams notification hook

1. Create the hooks directory:
   ```bash
   mkdir -p ~/.claude/hooks
   ```

2. Copy the hook script:
   ```bash
   cp hooks/notify-teams.sh ~/.claude/hooks/notify-teams.sh
   chmod +x ~/.claude/hooks/notify-teams.sh
   ```

3. Read the user's existing `~/.claude/settings.json` (if it exists). Merge the following hooks config into it, preserving all other settings:

   ```json
   {
     "hooks": {
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
     }
   }
   ```

## Step 7: Test notification

If `CLAUDE_TEAMS_WEBHOOK_URL` is set, send a test notification:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","content":{"type":"AdaptiveCard","$schema":"http://adaptivecards.io/schemas/adaptive-card.json","version":"1.4","body":[{"type":"TextBlock","text":"Setup successful!","weight":"Bolder","size":"Medium","color":"Good"},{"type":"TextBlock","text":"Claude Code Web Bridge is configured. You will receive Teams notifications when Claude needs your attention.","wrap":true}]}}]}' \
  "$CLAUDE_TEAMS_WEBHOOK_URL"
```

Report whether it succeeded (HTTP 200 or 202) or failed.

## Step 8: Print summary and start the server

Print a summary of everything that was configured:
- Prerequisites: which are installed
- Environment variables: which are configured
- Teams notification hook: installed or skipped
- Test notification: sent or skipped

Then ask the user which mode to start in:
1. **Local only** (localhost:3847) — `npm start`
2. **With tunnel** (remote access + QR code) — `npm run start:tunnel`
3. **With auto-reconnecting tunnel** — `npm run start:tunnel:auto`
4. **Don't start** (just finish setup)

IMPORTANT: Start the server command in the background using `run_in_background`. Do NOT print any text after starting the server.

## Step 9: Show QR code and public URL

After starting the server with tunnel, wait a few seconds for the tunnel to establish, then read the public URL from `~/.claude-web-bridge/public-url.txt`.

Once you have the URL, generate and display the QR code by running:

```bash
node -e "import('./src/qr-terminal.js').then(m => console.log(m.qrToTerminal(process.argv[1])))" "<PUBLIC_URL>"
```

Replace `<PUBLIC_URL>` with the actual URL from the file.

Then print:
- The public URL (bold/prominent)
- The QR code output
- "Open this URL on any device to chat with Claude."

If the mode is local-only, just print: "Open http://localhost:3847 in your browser."

If the user chose "Don't start", skip this step entirely.
