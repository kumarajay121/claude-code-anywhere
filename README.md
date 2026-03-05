# Claude Code Web Bridge

A lightweight Node.js web server that gives you a beautiful chat UI for [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), accessible from any device — your phone, tablet, or another laptop — via a browser.

No frameworks. No build step. One setup script and you're talking to Claude Code remotely.

## Quick Start (Recommended)

Clone the repo in devbox and run the setup script — it checks prerequisites, installs anything missing, and starts the bridge:

**Windows (PowerShell):**
```powershell
git clone <repo-url>
cd claude-code-web-bridge
.\setup.ps1
```

**macOS / Linux:**
```bash
git clone <repo-url>
cd claude-code-web-bridge
chmod +x setup.sh
./setup.sh
```

By default, the setup script starts with **remote access** — you get a public HTTPS URL and a QR code to scan from your phone.

To start **without tunnel** (localhost only):
```powershell
# Windows
.\setup.ps1 -LocalOnly

# macOS / Linux
./setup.sh --local-only
```

The setup script will:
1. Check for Node.js v18+ (offers to install if missing)
2. Check for Claude Code CLI (offers to install + guides authentication)
3. Check for devtunnel (offers to install + login if missing)
4. Run `npm install`
5. Start the bridge with tunnel, QR code, and public URL

> After the first run, you can skip the setup script and just use `npm start` or `npm run start:tunnel`.

## Features

- **Remote access** — use Claude Code from your phone or any device via devtunnel
- **Microsoft Teams integration** — @mention Claude in a Teams channel via Outgoing Webhook
- **Multi-chat** — multiple independent conversations, each with its own working directory
- **Session persistence** — chats survive server restarts
- **Busy/queue/interrupt** — send follow-up messages while Claude is working
- **Live preview** — see partial output while Claude is processing
- **Notifications** — Windows desktop toast, in-page toast with sound, and Web Push notifications
- **Markdown rendering** — headings, lists, tables, code blocks with syntax highlighting
- **Voice input/output** — dictate messages and hear responses read aloud
- **Copy buttons** — one-click copy on code blocks and full messages
- **Terminal import** — discover and take over Claude sessions running in your terminal
- **QR code** — scan in terminal or sidebar to open on your phone instantly

## Manual Setup

If you prefer to set things up yourself instead of using the setup script:

### Prerequisites

1. **Node.js v18+** — [nodejs.org](https://nodejs.org/) or `winget install OpenJS.NodeJS.LTS`
2. **Claude Code CLI** — install and authenticate:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude   # run once to sign in
   ```
3. **(Optional) devtunnel** — only for remote access:
   ```bash
   winget install Microsoft.devtunnel   # Windows
   brew install --cask devtunnel        # macOS
   curl -sL https://aka.ms/DevTunnelCliInstall | bash   # Linux
   ```
   Then: `devtunnel user login`

### Install & Run

```bash
git clone <repo-url>
cd claude-code-web-bridge
npm install
```

**Local only** — open [http://localhost:3847](http://localhost:3847):
```bash
npm start
```

**With remote access** — public HTTPS URL + QR code:
```bash
npm run start:tunnel
```

**Auto-reconnecting tunnel** — for long sessions:
```bash
npm run start:tunnel:auto
```

## Usage

### Creating a chat

1. Click **"+ New Chat"** in the sidebar
2. Enter a name and working directory (both optional — defaults to where you ran the server)
3. Start typing — Claude will work in that directory

### Changing working directory

Each chat has its own working directory. Change it anytime:
```
/cwd C:\projects\my-app
```

### Quick actions

The bar above the input has shortcuts: `/help`, `git status`, `git diff`, `changes?`, `/status`

### Voice

- **Input:** Click the mic button to dictate. Click again to stop — sends automatically.
- **Output:** Hover any Claude response and click **"Read"** to hear it aloud.

### Managing chats

In the sidebar: **Rename**, **Close** (can resume later), **Archive**, **Delete**, or **Resume** a timed-out chat.

### Terminal import

The **Terminal** section in the sidebar shows Claude sessions running in your actual terminal. Click **Import** (idle sessions) or **Stop & Import** (running sessions) to take them over in the web UI.

## Microsoft Teams Integration

Chat with Claude directly from a Teams channel using Outgoing Webhooks. Claude's responses appear as channel messages, triggering **native Teams notifications** on all your devices (desktop + mobile).

> **Why two tunnels?** Devtunnel has an anti-phishing interstitial page that blocks server-to-server webhook calls from Teams. Cloudflare tunnel is used alongside devtunnel specifically for the Teams webhook — it forwards requests directly without interstitials.

### Prerequisites

Install `cloudflared`:
```bash
winget install Cloudflare.cloudflared   # Windows
brew install cloudflared                 # macOS
```

### Setup

You'll run **two terminals** side by side:

**Terminal 1 — Cloudflare tunnel** (start once, keep running):
```bash
npm run cloudflare
```
This prints a stable URL like `https://xxx.trycloudflare.com`. The URL stays the same as long as this process runs. You can restart the bridge in Terminal 2 without losing this URL.

**Terminal 2 — Bridge + devtunnel** (for web UI + QR code):
```bash
npm run start:tunnel
```

### One-time Teams setup

**Step 1: Create an Outgoing Webhook**
1. Open Teams → go to the channel where you want Claude
2. Click `...` next to the channel name → **Manage channel**
3. Go to **Apps** tab → **Create an outgoing webhook**
4. Fill in:
   - **Name**: `ClaudeCode`
   - **Callback URL**: `https://<cloudflare-url>/api/teams-webhook` (use the URL from Terminal 1)
   - **Description**: Chat with Claude Code
5. Click **Create** → copy the **HMAC security token**

**Step 2: Create an Incoming Webhook (via Workflow) for long responses**
1. In the same channel, click `...` → **Workflows**
2. Choose **"Send webhook alerts to a channel"**
3. Pick the same channel → Create → copy the **webhook URL**

**Step 3: Add tokens to `.env`**
```bash
TEAMS_WEBHOOK_SECRET=<HMAC-token-from-step-1>
TEAMS_INCOMING_WEBHOOK_URL=<URL-from-step-2>
```
No restart needed — the bridge reads `.env` dynamically.

**Step 4:** Type `@ClaudeCode <your question>` in the channel.

### How it works
- **Quick tasks** (< 8s): Claude responds inline in the channel
- **Long tasks** (> 8s): Returns "Working on it..." immediately, posts the full response via Incoming Webhook when done
- **Session persistence**: Each Teams user gets their own Claude session — context is preserved across messages
- **Native notifications**: Channel messages trigger Teams notifications on desktop and mobile

## Optional Configuration

If you need to customize, create a `.env` file in the project root:

```bash
cp .env.TEMPLATE .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_WORKING_DIR` | current directory | Default working directory for new chats |
| `BRIDGE_PORT` | `3847` | Port the web server listens on |
| `CLAUDE_PATH` | auto-discovered | Explicit path to `claude` binary if auto-discovery fails |
| `TEAMS_WEBHOOK_SECRET` | — | HMAC token from Teams Outgoing Webhook setup |
| `TEAMS_INCOMING_WEBHOOK_URL` | — | Workflow webhook URL for posting long responses back to Teams |
| `VAPID_PUBLIC_KEY` | — | Web Push VAPID public key (auto-generated by setup) |
| `VAPID_PRIVATE_KEY` | — | Web Push VAPID private key (auto-generated by setup) |

> Most users don't need this. The bridge auto-discovers Claude from `~/.claude/local/`, `~/.local/bin/`, npm global, or PATH.

## Troubleshooting

### "spawn claude.exe ENOENT"
Claude CLI is not in PATH or the expected locations. Fix:
```bash
# Verify Claude is installed
claude --version

# If installed but not found, set the path explicitly in .env:
CLAUDE_PATH=C:\Users\<you>\.claude\local\claude.exe
```

### "No conversation found with session ID"
The session expired on Claude's side. Create a new chat.

### 502 Bad Gateway on devtunnel
Port protocol mismatch. Fix:
```bash
devtunnel port delete claude-bridge -p 3847
devtunnel port create claude-bridge -p 3847 --protocol http
```

### Microphone not working
- Requires **Chrome, Edge, or Safari** (Firefox doesn't support Web Speech API)
- Must be on **HTTPS** (devtunnel) or **localhost** — plain HTTP on other origins won't work
- Check browser permissions for microphone access

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed architecture documentation including data flow diagrams, module deep dives, API reference, and session lifecycle.

## License

MIT
