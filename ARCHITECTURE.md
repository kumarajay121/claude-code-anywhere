# Architecture Wiki — Claude Code Web Bridge

## Table of Contents

1. [Overview](#overview)
2. [High-Level Architecture](#high-level-architecture)
3. [Request Lifecycle](#request-lifecycle)
4. [File Structure](#file-structure)
5. [Module Deep Dive](#module-deep-dive)
   - [web-bridge.js — HTTP Server & API](#web-bridgejs--http-server--api)
   - [claude-runner.js — CLI Process Manager](#claude-runnerjs--cli-process-manager)
   - [session-manager.js — Persistence Layer](#session-managerjs--persistence-layer)
   - [system-sessions.js — Terminal Session Discovery](#system-sessionsjs--terminal-session-discovery)
   - [start-with-tunnel.js — Launcher & Tunnel Manager](#start-with-tunneljs--launcher--tunnel-manager)
   - [qr-terminal.js — QR Code Generator](#qr-terminaljs--qr-code-generator)
   - [public/index.html — Chat UI](#publicindexhtml--chat-ui)
6. [Data Flow Diagrams](#data-flow-diagrams)
7. [Session Lifecycle](#session-lifecycle)
8. [Message Handling Modes](#message-handling-modes)
9. [API Reference](#api-reference)
10. [Storage & Persistence](#storage--persistence)
11. [Security Model](#security-model)
12. [Deployment Modes](#deployment-modes)

---

## Overview

Claude Code Web Bridge is a lightweight Node.js HTTP server that acts as a **bridge** between a browser-based chat UI and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code). It lets you chat with Claude from any device — phone, tablet, or another computer — through a simple web interface.

**Key design principles:**
- Zero external UI frameworks (no React, no build step)
- Minimal dependencies (only `dotenv` for optional config)
- One process per message (Claude CLI is spawned per prompt, not long-running)
- File-based persistence (sessions survive server restarts)
- Pure JavaScript QR code generation (no external libraries)

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        User's Device                            │
│                  (Phone / Tablet / Browser)                      │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  index.html (Chat UI)                     │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │  │
│  │  │ Sidebar  │  │  Chat    │  │  Voice   │  │ Markdown │ │  │
│  │  │ Manager  │  │  Window  │  │  I/O     │  │ Renderer │ │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │  │
│  └──────────────────────────┬────────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────────┘
                              │
                    HTTP / HTTPS (devtunnel)
                              │
┌─────────────────────────────┼───────────────────────────────────┐
│                     Bridge Server                                │
│                                                                 │
│  ┌──────────────────────────┴────────────────────────────────┐  │
│  │              web-bridge.js (HTTP Server)                   │  │
│  │        Port 3847 — REST API + Static File Serving         │  │
│  └────┬──────────────┬───────────────┬───────────────────────┘  │
│       │              │               │                          │
│  ┌────┴─────┐  ┌─────┴──────┐  ┌────┴──────────┐               │
│  │ claude-  │  │ session-   │  │ system-       │               │
│  │ runner   │  │ manager    │  │ sessions      │               │
│  │ .js      │  │ .js        │  │ .js           │               │
│  └────┬─────┘  └─────┬──────┘  └────┬──────────┘               │
│       │              │               │                          │
│       │         ┌────┴─────┐    ┌────┴──────────┐               │
│       │         │ sessions │    │ ~/.claude/    │               │
│       │         │ .json    │    │ projects/     │               │
│       │         └──────────┘    └───────────────┘               │
│       │                                                         │
│  ┌────┴──────────────────────────────────────────────────────┐  │
│  │              Claude CLI (spawned per message)              │  │
│  │   claude -p "prompt" --output-format json --resume <id>   │  │
│  └────┬──────────────────────────────────────────────────────┘  │
│       │                                                         │
│  ┌────┴──────────────────────────────────────────────────────┐  │
│  │                 Your Codebase / Filesystem                 │  │
│  │            (reads files, writes code, runs commands)       │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Request Lifecycle

Here's what happens when you type a message and press Send:

```
 Browser                    web-bridge.js              claude-runner.js           Claude CLI
    │                            │                            │                       │
    │  POST /api/message         │                            │                       │
    │  { message, sessionId }    │                            │                       │
    ├───────────────────────────>│                            │                       │
    │                            │                            │                       │
    │                            │  Check slash command?      │                       │
    │                            │  (/help, /status, /cwd)    │                       │
    │                            │──── Yes ──> Return result  │                       │
    │                            │                            │                       │
    │                            │  Check session lock?       │                       │
    │                            │  (external process using   │                       │
    │                            │   this session?)           │                       │
    │                            │──── Locked ──> 409 error   │                       │
    │                            │                            │                       │
    │                            │  runner.run(message)       │                       │
    │                            ├───────────────────────────>│                       │
    │                            │                            │                       │
    │                            │                            │  spawn("claude",      │
    │                            │                            │   ["-p", prompt,      │
    │                            │                            │    "--resume", id])   │
    │                            │                            ├──────────────────────>│
    │                            │                            │                       │
    │                            │                            │   (Claude reads files,│
    │  GET /api/sessions/:id     │                            │    writes code,       │
    │  (polling for progress)    │                            │    runs commands...)  │
    │<─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ >│  partialOutput             │                       │
    │  { busy: true,             │<─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│   stdout (partial)   │
    │    partialOutput: "..." }  │                            │<─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
    │                            │                            │                       │
    │                            │                            │   JSON response       │
    │                            │                            │<──────────────────────│
    │                            │                            │                       │
    │                            │  { response, sessionId }   │                       │
    │                            │<───────────────────────────│                       │
    │                            │                            │                       │
    │  200 { response }          │                            │                       │
    │<───────────────────────────│                            │                       │
    │                            │                            │                       │
    │  Render markdown           │                            │                       │
    │  in chat bubble            │                            │                       │
    ▼                            ▼                            ▼                       ▼
```

**Polling mechanism:** While Claude is working, the browser polls `GET /api/sessions/:id` every 2 seconds to fetch:
- `busy` — whether Claude is still processing
- `elapsed` — how long the request has been running
- `partialOutput` — raw stdout collected so far (for live preview)

---

## File Structure

```
claude-code-web-bridge/
├── package.json                 # Project config, npm scripts
├── README.md                    # User-facing documentation
├── ARCHITECTURE.md              # This file
├── .env.TEMPLATE                # Environment variable template
│
├── src/
│   ├── web-bridge.js            # HTTP server, REST API, routing
│   ├── claude-runner.js         # Spawns Claude CLI, manages busy/queue/interrupt
│   ├── session-manager.js       # CRUD for chat sessions, file persistence
│   ├── system-sessions.js       # Discovers Claude processes running in terminals
│   ├── start-with-tunnel.js     # Launcher: bridge + devtunnel + QR code
│   ├── qr-terminal.js           # Pure JS QR code generator (zero dependencies)
│   │
│   └── public/
│       └── index.html           # Complete chat UI (HTML + CSS + JS, single file)
│
└── ~/.claude-web-bridge/        # Runtime data directory (auto-created)
    ├── sessions.json            # All sessions + message history
    └── public-url.txt           # Public devtunnel URL (written by tunnel script)
```

---

## Module Deep Dive

### web-bridge.js — HTTP Server & API

**Role:** The central hub. Creates an HTTP server on port 3847, routes API requests, serves the static UI, and coordinates all other modules.

**Key responsibilities:**
- Serves `index.html` for `GET /`
- Routes all `/api/*` endpoints to the appropriate handler
- Maintains a `Map<sessionId, ClaudeRunner>` for active runners
- Tracks busy sessions via a `Set<sessionId>`
- Handles slash commands (`/help`, `/status`, `/cwd`, `/export`) locally without spawning Claude
- Checks session locks before allowing messages (prevents conflicts with terminal sessions)
- Provides QR code data via `/api/qr`

**Architecture pattern:** Single-file HTTP server using Node.js built-in `http` module. No Express, no middleware framework. URL routing is done with simple `if` chains and regex matching.

```
Incoming Request
      │
      ├── GET /              → serve index.html
      ├── GET /api/qr        → generate QR code data
      ├── GET /api/sessions   → list all chats
      ├── POST /api/sessions  → create new chat
      ├── POST /api/message   → send message to Claude
      ├── GET /api/sessions/:id          → chat status + partial output
      ├── GET /api/sessions/:id/messages → message history
      ├── POST /api/sessions/:id/cancel  → kill running Claude process
      ├── POST /api/sessions/:id/resume  → reactivate timed-out chat
      ├── PUT /api/sessions/:id/rename   → rename chat
      ├── POST /api/sessions/:id/close   → deactivate chat
      ├── POST /api/sessions/:id/archive → move to archive
      ├── DELETE /api/sessions/:id       → permanently delete
      ├── GET /api/system-sessions       → list terminal CLI sessions
      └── POST /api/system-sessions/import → import terminal session
```

---

### claude-runner.js — CLI Process Manager

**Role:** Wraps the Claude CLI binary. Each chat session gets one `ClaudeRunner` instance that manages spawning, queueing, interrupting, and cancelling Claude processes.

**Key concepts:**

| Concept | Description |
|---------|-------------|
| **One-at-a-time** | Only one Claude process runs per session. If busy, the message is queued or rejected. |
| **Session resume** | First message omits `--resume`. After getting a `session_id` from Claude's JSON output, all subsequent messages include `--resume <id>`. |
| **Partial output** | While Claude is running, `stdout` is collected incrementally. The bridge exposes this via the status endpoint for live preview. |
| **Queue** | A single follow-up message can be queued. When the current request finishes, the queued message runs automatically. |
| **Interrupt** | Kills the running process (`SIGTERM`), captures partial output, then immediately runs the new message with a context note about the interruption. |

**Claude CLI flags used:**

```bash
claude -p "prompt"                    # Non-interactive prompt mode
       --dangerously-skip-permissions # No confirmation prompts
       --output-format json           # Structured JSON response
       --resume <session_id>          # Continue same conversation
```

**Process spawning flow:**

```
ClaudeRunner.run(prompt)
      │
      ├── busy? → return "still processing" message
      │
      ├── set busy = true
      │
      ├── _execute(prompt)
      │     │
      │     ├── Build args: [-p, prompt, --dangerously-skip-permissions, ...]
      │     ├── If hasConversation → add [--resume, sessionId]
      │     ├── spawn(claudePath, args, { cwd: workingDir })
      │     ├── Collect stdout/stderr
      │     ├── On close → parse JSON → extract result + session_id
      │     └── Return response text
      │
      ├── set busy = false
      │
      └── If pendingFollowUp exists → run it automatically
```

**Binary resolution order:**
1. `CLAUDE_PATH` environment variable
2. `~/.claude/local/claude(.exe)`
3. `~/.local/bin/claude(.exe)`
4. `%APPDATA%/npm/claude.cmd` (Windows only)
5. `claude` (fallback to PATH)

---

### session-manager.js — Persistence Layer

**Role:** CRUD operations for chat sessions with file-based persistence. All sessions and their message histories are stored in a single JSON file.

**Session states:**

```
                  create()
                    │
                    ▼
               ┌─────────┐
               │  active  │◄──────── resume()
               └────┬─────┘
                    │
          ┌─────────┼──────────┐
          │         │          │
     close()   auto-timeout  archive()
          │    (72h inactivity) │
          ▼         │          ▼
     ┌────────┐     │    ┌──────────┐
     │ closed │     │    │ archived │
     └────────┘     ▼    └──────────┘
               ┌──────────┐
               │ timed-out│
               └──────────┘
```

**Storage format** (`~/.claude-web-bridge/sessions.json`):

```json
{
  "sessions": [
    {
      "id": "uuid-v4",
      "name": "My Chat",
      "status": "active",
      "created": "2025-01-15T10:30:00.000Z",
      "lastActive": "2025-01-15T11:45:00.000Z",
      "messageCount": 24,
      "workingDir": "C:\\projects\\my-app"
    }
  ],
  "messageHistory": {
    "uuid-v4": [
      { "role": "user", "text": "Hello", "time": "2025-01-15T10:30:05.000Z" },
      { "role": "bot", "text": "Hi! How can I help?", "time": "2025-01-15T10:30:12.000Z" }
    ]
  }
}
```

**Auto-timeout:** A background interval runs every 5 minutes, checking for sessions inactive beyond the timeout threshold (default: 72 hours). Timed-out sessions can be resumed.

**Message cap:** Each session retains the last 200 messages. Older messages are trimmed from the front.

---

### system-sessions.js — Terminal Session Discovery

**Role:** Discovers Claude CLI sessions running in your actual terminal (not spawned by the bridge). Enables "import" functionality — take over a terminal session into the web UI.

**How it works:**

```
1. Query running processes
   │
   │  PowerShell: Get-CimInstance Win32_Process
   │  Filter: CommandLine contains "claude" AND "--resume"
   │
   ▼
2. Extract session IDs from command lines
   │
   │  Regex: --resume[=\s]+([0-9a-f-]{36})
   │
   ▼
3. Scan ~/.claude/projects/ for .jsonl transcript files
   │
   │  Match session IDs to project directories
   │  Decode directory names back to filesystem paths
   │
   ▼
4. Return session list with:
   - Session ID
   - Running/idle status
   - PID (if running)
   - Project path
   - Last modified timestamp
```

**Session lock detection:** Before sending a message, the bridge checks if the target session has an external process using it. If a terminal Claude is running with `--resume <same-id>`, the bridge refuses the message to prevent conflicts.

**Import options:**
- **Import** — for idle sessions (no running process)
- **Stop & Import** — sends `SIGTERM` to the terminal process, waits up to 5 seconds, then imports

---

### start-with-tunnel.js — Launcher & Tunnel Manager

**Role:** Orchestrates starting both the bridge server and a Microsoft devtunnel for remote HTTPS access.

**Startup sequence:**

```
1. Start bridge server (spawn web-bridge.js)
      │
      ▼
2. Wait 2 seconds (let bridge initialize)
      │
      ▼
3. Ensure tunnel exists
   │  devtunnel create <name> --allow-anonymous
   │  devtunnel port create <name> -p 3847 --protocol http
   │  (both ignore errors if already exist)
      │
      ▼
4. Start tunnel
   │  devtunnel host <name>
      │
      ▼
5. Watch stdout for public URL
   │  Regex: https://...devtunnels.ms...
      │
      ▼
6. On URL detected:
   ├── Write URL to ~/.claude-web-bridge/public-url.txt
   ├── Print URL to terminal
   └── Display QR code in terminal (Unicode block chars)
```

**Auto-reconnect:** If `--auto-reconnect` flag is set and the tunnel dies:
- Wait `--reconnect-delay` seconds (default: 5)
- Restart the tunnel
- Repeat up to `--max-retries` times (default: unlimited)

**Graceful shutdown (Ctrl+C):**
1. Clean up `public-url.txt`
2. Kill tunnel process
3. Kill bridge process
4. Exit after 3s grace period

---

### qr-terminal.js — QR Code Generator

**Role:** Pure JavaScript implementation of QR Code Model 2. Generates QR codes for URLs without any external dependencies.

**Algorithm pipeline:**

```
Input text (URL)
      │
      ▼
1. Version selection (1-10 based on data length)
      │
      ▼
2. Data encoding (Byte mode)
   │  4-bit mode indicator + 8/16-bit count + data bytes
   │  Terminator + padding bytes (0xEC, 0x11 alternating)
      │
      ▼
3. Reed-Solomon error correction
   │  GF(256) arithmetic → generator polynomial → EC codewords
   │  Split into blocks → encode each → interleave
      │
      ▼
4. Matrix construction
   │  Finder patterns (3 corners)
   │  Alignment patterns (version ≥ 2)
   │  Timing patterns (row 6, column 6)
   │  Dark module
      │
      ▼
5. Data placement (zigzag pattern from bottom-right)
      │
      ▼
6. Mask application (pattern 0: (row + col) % 2 == 0)
      │
      ▼
7. Format info (BCH encoding, XOR mask)
      │
      ▼
Output: { grid: boolean[][], size: number }
```

**Two rendering modes:**
- **Terminal:** Unicode half-block characters (`▀▄█` and space) — 2 modules per character vertically
- **Browser:** Canvas API rendering via `/api/qr` endpoint — bridge returns grid data, UI draws on `<canvas>`

---

### public/index.html — Chat UI

**Role:** Complete single-page chat application. All HTML, CSS, and JavaScript in one file — no build step, no bundler, no framework.

**UI components:**

```
┌────────────────────────────────────────────────────┐
│ ┌──────────┐ ┌───────────────────────────────────┐ │
│ │          │ │ Header                      [≡]   │ │
│ │ Sidebar  │ │  Chat name + session ID           │ │
│ │          │ ├───────────────────────────────────┤ │
│ │ [+ New]  │ │                                   │ │
│ │          │ │  Welcome Screen (if empty)        │ │
│ │ Chat 1   │ │    or                             │ │
│ │ Chat 2   │ │  Message Thread                   │ │
│ │ Chat 3 ◄─┤ │    ┌─────────────────────┐       │ │
│ │          │ │    │ 🤖 Claude response   │       │ │
│ │ ──────── │ │    │ with markdown        │       │ │
│ │ Terminal │ │    │ [Copy] [Read]        │       │ │
│ │ Sessions │ │    └─────────────────────┘       │ │
│ │          │ │              ┌──────────────┐     │ │
│ │ ──────── │ │              │ Your message │     │ │
│ │ QR Code  │ │              └──────────────┘     │ │
│ │ [scan]   │ ├───────────────────────────────────┤ │
│ │          │ │ Quick actions bar                  │ │
│ │          │ │ [/help] [git status] [changes?]    │ │
│ │          │ ├───────────────────────────────────┤ │
│ │          │ │ [🎤] [  Type a message...   ] [→] │ │
│ └──────────┘ └───────────────────────────────────┘ │
└────────────────────────────────────────────────────┘
```

**Key JavaScript systems:**

| System | Description |
|--------|-------------|
| **Session management** | `loadSessions()`, `switchSession()`, `renderSessions()` — CRUD via API calls |
| **Message sending** | `sendMsg()` → `sendWithMode()` — handles busy detection, queue, interrupt |
| **Heartbeat polling** | `heartbeatPoll()` — 2s interval checking busy state + partial output |
| **Markdown renderer** | `renderMarkdown()` — headings, bold, italic, lists, tables, links, blockquotes, code blocks |
| **Syntax highlighting** | CSS-class-based regex coloring for keywords, strings, comments, numbers |
| **Voice input** | Web Speech API (`SpeechRecognition`) — mic button, auto-send on stop |
| **Voice output** | `SpeechSynthesis` — per-message "Read" button on bot responses |
| **Welcome screen** | Shown when chat has 0 messages, 4 suggestion cards that send prompts |
| **QR display** | Canvas-drawn QR code in sidebar, fetched from `/api/qr` |

**Markdown rendering pipeline:**

```
Raw text from Claude
      │
      ▼
1. Extract fenced code blocks (```lang ... ```)
   └── Replace with placeholders
      │
      ▼
2. Process inline markdown
   ├── **bold** → <strong>
   ├── *italic* → <em>
   ├── ~~strike~~ → <del>
   ├── `code` → <code>
   ├── [text](url) → <a>
   └── --- → <hr>
      │
      ▼
3. Process block elements
   ├── # Headings (H1-H4)
   ├── > Blockquotes
   ├── - / * Unordered lists
   ├── 1. Ordered lists
   └── | Tables |
      │
      ▼
4. Restore code blocks with:
   ├── Language label pill
   ├── Copy button
   └── Syntax highlighting (regex-based)
      │
      ▼
HTML output → injected into .msg element
```

---

## Data Flow Diagrams

### New Chat Creation

```
UI                          API                        SessionManager
│                            │                            │
│  POST /api/sessions        │                            │
│  { name, workingDir }      │                            │
├───────────────────────────>│                            │
│                            │  sessions.create(name)     │
│                            ├───────────────────────────>│
│                            │                            │  Generate UUID
│                            │                            │  Create session object
│                            │                            │  Initialize message array
│                            │                            │  Write sessions.json
│                            │  { session }               │
│                            │<───────────────────────────│
│  201 { session }           │                            │
│<───────────────────────────│                            │
│                            │                            │
│  switchSession(id)         │                            │
│  Show welcome screen       │                            │
```

### Terminal Session Import

```
UI                     API                  system-sessions.js      SessionManager
│                       │                        │                       │
│  GET /api/system-     │                        │                       │
│  sessions             │                        │                       │
├──────────────────────>│                        │                       │
│                       │  listRecent()          │                       │
│                       ├───────────────────────>│                       │
│                       │                        │  PowerShell query     │
│                       │                        │  for claude.exe       │
│                       │                        │  processes            │
│                       │                        │                       │
│                       │                        │  Scan ~/.claude/      │
│                       │                        │  projects/*.jsonl     │
│                       │                        │                       │
│                       │  [sessions]            │                       │
│                       │<───────────────────────│                       │
│  { sessions }         │                        │                       │
│<──────────────────────│                        │                       │
│                       │                        │                       │
│  "Stop & Import"      │                        │                       │
│  POST /api/system-    │                        │                       │
│  sessions/import      │                        │                       │
│  { sessionId, killPid}│                        │                       │
├──────────────────────>│                        │                       │
│                       │  process.kill(pid)     │                       │
│                       │  (wait for exit)       │                       │
│                       │                        │                       │
│                       │  sessions.set(id, ...) │                       │
│                       ├──────────────────────────────────────────────>│
│                       │                        │                       │
│  201 { session }      │                        │                       │
│<──────────────────────│                        │                       │
```

---

## Session Lifecycle

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Session States                                │
│                                                                      │
│  ┌──────────┐    close()    ┌────────┐                               │
│  │          ├──────────────>│ closed │                               │
│  │          │               └────────┘                               │
│  │  active  │                                                        │
│  │          │    archive()  ┌──────────┐    import (from system)     │
│  │          ├──────────────>│ archived ├──────────────┐              │
│  │          │               └──────────┘              │              │
│  └──┬───▲───┘                                         │              │
│     │   │                                             │              │
│     │   │ resume()                                    │              │
│     │   │                                             ▼              │
│     │   │           ┌───────────┐              ┌──────────┐          │
│     │   └───────────┤ timed-out │              │  active  │          │
│     │               └───────────┘              └──────────┘          │
│     │                     ▲                                          │
│     │  72h inactivity     │                                          │
│     └─────────────────────┘                                          │
│                                                                      │
│  delete() → permanently removes session + message history            │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Message Handling Modes

When a user sends a message while Claude is already processing:

```
                    User sends message
                          │
                          ▼
                   Is Claude busy?
                    /          \
                  No            Yes
                  │              │
                  ▼              ▼
             run(prompt)    What mode?
                          /     |     \
                       default queue  interrupt
                         │      │       │
                         ▼      ▼       ▼
                       202    Wait    Kill current
                      {busy}  for     process,
                              finish, run new
                              then    message
                              run     with context
                              queued  note
                              msg
```

| Mode | Behavior | Use Case |
|------|----------|----------|
| **Default** | Returns `202 { busy: true }` | UI shows "Claude is thinking..." with cancel option |
| **Queue** | Stores message, auto-runs after current finishes | "Send anyway — run after current task" |
| **Interrupt** | Kills current process, runs new message immediately | "Stop what you're doing and do this instead" |

---

## API Reference

### Sessions

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/sessions` | — | `{ sessions: [...] }` | List all chats with lock status |
| `POST` | `/api/sessions` | `{ name, workingDir }` | `{ session }` | Create new chat |
| `GET` | `/api/sessions/:id` | — | `{ session, busy, elapsed, partialOutput }` | Chat details + status |
| `DELETE` | `/api/sessions/:id` | — | `{ ok: true }` | Permanently delete |
| `GET` | `/api/sessions/:id/messages` | — | `{ messages: [...] }` | Message history |
| `PUT` | `/api/sessions/:id/rename` | `{ name }` | `{ session }` | Rename chat |
| `POST` | `/api/sessions/:id/resume` | — | `{ session }` | Reactivate timed-out chat |
| `POST` | `/api/sessions/:id/close` | — | `{ session }` | Deactivate chat |
| `POST` | `/api/sessions/:id/archive` | — | `{ ok: true }` | Move to archive |
| `POST` | `/api/sessions/:id/cancel` | — | `{ cancelled: bool }` | Kill running Claude process |

### Messaging

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `POST` | `/api/message` | `{ message, sessionId, mode }` | `{ response, sessionId }` | Send message to Claude |

`mode` can be: omitted (default), `"queue"`, or `"interrupt"`.

### System Sessions

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/system-sessions` | — | `{ sessions: [...] }` | List terminal Claude sessions |
| `POST` | `/api/system-sessions/import` | `{ sessionId, name, killPid }` | `{ session }` | Import terminal session |

### Utility

| Method | Endpoint | Response | Description |
|--------|----------|----------|-------------|
| `GET` | `/api/qr` | `{ url, grid, size }` | QR code data for the access URL |
| `GET` | `/api/status` | `{ status, activeSession, totalSessions, uptime }` | Global bridge status |

---

## Storage & Persistence

All runtime data lives in `~/.claude-web-bridge/`:

```
~/.claude-web-bridge/
├── sessions.json       # All sessions + message history (written on every change)
└── public-url.txt      # Current devtunnel public URL (written by start-with-tunnel.js)
```

**Claude's own data** (read-only by the bridge):

```
~/.claude/
└── projects/
    └── <encoded-path>/
        └── <session-id>.jsonl    # Claude's conversation transcripts
```

The bridge reads these `.jsonl` files to discover existing terminal sessions but never writes to them.

---

## Security Model

| Aspect | Details |
|--------|---------|
| **Claude permissions** | All sessions run with `--dangerously-skip-permissions` — Claude can read/write files and run commands without confirmation |
| **Network access** | Bridge listens on `0.0.0.0:3847` (all interfaces). Without devtunnel, only accessible on LAN. |
| **Tunnel access** | devtunnel is created with `--allow-anonymous` — anyone with the URL can access |
| **No authentication** | The bridge has no login/password. Security relies on the devtunnel URL being secret. |
| **Session isolation** | Each chat has its own working directory and Claude session. One chat cannot access another's Claude conversation. |
| **Session locking** | The bridge detects if a terminal Claude is using the same session ID and refuses messages to prevent conflicts. |
| **CORS** | `Access-Control-Allow-Origin: *` — any origin can make API calls |

**Recommendation:** For sensitive environments, use `--allow-org` instead of `--allow-anonymous` to restrict devtunnel access to your Azure AD tenant.

---

## Deployment Modes

### 1. Local Only (`npm start`)

```
Browser ──── http://localhost:3847 ──── web-bridge.js ──── Claude CLI
```

- Access only from the same machine
- No tunnel, no public URL, no QR code

### 2. With Tunnel (`npm run start:tunnel`)

```
Phone ──── https://abc.devtunnels.ms ──── devtunnel ──── web-bridge.js ──── Claude CLI
```

- Public HTTPS URL via Microsoft devtunnel
- QR code shown in terminal and sidebar
- Anonymous access (anyone with URL)

### 3. Auto-Reconnecting Tunnel (`npm run start:tunnel:auto`)

Same as mode 2, but automatically restarts the tunnel if it disconnects. Ideal for long-running sessions.

```
Tunnel dies → wait 5s → reconnect → repeat (unlimited retries)
```
