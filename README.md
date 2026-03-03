# Claude Code Web Bridge

A lightweight Node.js web server that gives you a beautiful chat UI for [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), accessible from any device — your phone, tablet, or another laptop — via a browser.

No frameworks. No build step. Just `npm start` and you're talking to Claude Code remotely.

## Features

- **Remote access** — use Claude Code from your phone or any device via devtunnel
- **Multi-chat** — multiple independent conversations, each with its own working directory
- **Session persistence** — chats survive server restarts
- **Busy/queue/interrupt** — send follow-up messages while Claude is working
- **Live preview** — see partial output while Claude is processing
- **Markdown rendering** — headings, lists, tables, code blocks with syntax highlighting
- **Voice input/output** — dictate messages and hear responses read aloud
- **Copy buttons** — one-click copy on code blocks and full messages
- **Terminal import** — discover and take over Claude sessions running in your terminal
- **QR code** — scan in terminal or sidebar to open on your phone instantly

## Prerequisites

### 1. Node.js (v18 or later)

Check if you have it:
```bash
node --version
```
If not installed, download from [nodejs.org](https://nodejs.org/) or:
```bash
# Windows
winget install OpenJS.NodeJS.LTS

# macOS
brew install node
```

### 2. Claude Code CLI

Install and authenticate:
```bash
npm install -g @anthropic-ai/claude-code
```

Then run it once to complete authentication:
```bash
claude
```

Follow the prompts to sign in with your Anthropic account. You must have an active Claude Pro/Team/Enterprise subscription, or API access.

### 3. devtunnel (optional — only for remote access)

Only needed if you want to access from your phone or another device.

```bash
# Windows
winget install Microsoft.devtunnel

# macOS
brew install --cask devtunnel

# Linux
curl -sL https://aka.ms/DevTunnelCliInstall | bash
```

Then login with your Microsoft account:
```bash
devtunnel user login
```

## Setup

### 1. Clone the repo

```bash
git clone <repo-url>
cd claude-code-web-bridge
```

### 2. Install dependencies

```bash
npm install
```

That's it. No `.env` file is needed — the bridge auto-discovers the Claude binary and uses sensible defaults.

### 3. Start the bridge

**Option A — Local only** (same machine):
```bash
npm start
```
Open [http://localhost:3847](http://localhost:3847) in your browser.

**Option B — With remote access** (access from phone/tablet):
```bash
npm run start:tunnel
```
A public HTTPS URL and QR code will appear in your terminal. Open that URL on any device.

**Option C — Auto-reconnecting tunnel** (for long sessions):
```bash
npm run start:tunnel:auto
```
Same as Option B, but auto-restarts the tunnel if it disconnects.

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

> Most users don't need this. The bridge auto-discovers Claude from `~/.claude/local/`, `~/.local/bin/`, npm global, or PATH.

## Troubleshooting

### "spawn claude.exe ENOENT"
Claude CLI is not in PATH or the expected locations. Fix:
```bash
# Verify Claude is installed
claude --version

# If installed but not found, set the path explicitly
# Create a .env file with:
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
