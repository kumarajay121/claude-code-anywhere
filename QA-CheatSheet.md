# Claude Code Anywhere — Q&A Cheat Sheet

## 1. Security & Access

**Q: How is this secured? Anyone with the URL can access Claude on your machine?**
> The devtunnel URL is randomly generated and not publicly listed — it's essentially a secret URL. Additionally, devtunnel supports access controls (Microsoft Entra login). For extra security, you can run in `--local-only` mode and access only from your own network. The tunnel URL changes every time you restart unless you pin it.

**Q: Does this expose my file system?**
> Only through Claude Code CLI, which already has its own permission model — it asks before editing files, running commands, etc. The web bridge doesn't add any new file access; it's just a UI layer on top of what Claude Code already does.

---

## 2. Architecture & Design Choices

**Q: Why not just use the Anthropic API directly? Why go through Claude Code CLI?**
> Claude Code CLI gives you agentic capabilities — file editing, bash execution, git operations, multi-step reasoning — all with built-in safety guardrails. The raw API doesn't have any of that. We're leveraging the full power of the CLI, not just chat.

**Q: Why no React/Angular? Why vanilla HTML/JS?**
> Zero build step, zero dependencies for the frontend. You clone, run `npm install` (2 dependencies total), and it works. No webpack, no bundler, no framework version conflicts. This keeps it simple, fast to set up, and easy to modify.

**Q: Why Node.js and not Python/Go?**
> Claude Code CLI is a Node.js tool itself. Staying in the same ecosystem means we can spawn it as a child process natively, share the same runtime, and keep dependencies minimal (only `dotenv` and `web-push`).

---

## 3. Teams Integration

**Q: How does the Teams integration work exactly?**
> Two-way: (1) **Outgoing Webhook** — you @mention Claude in a Teams channel, Teams sends the message to our Cloudflare tunnel, we forward it to Claude CLI, and post the response back via an **Incoming Webhook**. (2) **Notification Hook** — when Claude stops or needs permission, a hook script sends an Adaptive Card to Teams so you know to come back.

**Q: Why both devtunnel AND Cloudflare tunnel?**
> They serve different purposes. **Devtunnel** exposes the web UI for browser access (phone/tablet). **Cloudflare tunnel** provides the HTTPS endpoint that Teams Outgoing Webhooks require (Teams needs a public URL with a valid SSL cert). You can use either or both.

---

## 4. Practical Usage

**Q: What's the real use case? When would I actually use this?**
> Three main scenarios: (1) You kick off a long Claude task on your desktop, walk away, and monitor/respond from your phone. (2) You're in a meeting and want to ask Claude to investigate something without opening your laptop. (3) You want teammates to interact with Claude in a shared Teams channel for pair programming or code reviews.

**Q: Can multiple people use it at the same time?**
> Yes — the bridge supports multi-chat sessions. Each session is independent with its own working directory. Multiple browser tabs or users can have separate conversations simultaneously.

**Q: Does it work offline or only with internet?**
> With devtunnel/Cloudflare, you need internet. In `--local-only` mode, it works on your local network (localhost:3847). But Claude Code CLI itself requires internet to reach the Anthropic API.

---

## 5. Reliability & Edge Cases

**Q: What happens if Claude is mid-task and you send another message?**
> The bridge has a built-in queue system. If Claude is busy, your message gets queued and sent automatically when Claude finishes. You can also interrupt — send a message while Claude is working and it will interrupt the current task.

**Q: What if the tunnel drops? Do I lose my conversation?**
> No. Sessions are persisted on disk. The `--auto-reconnect` flag automatically re-establishes the tunnel. When you reconnect, all your chat history is still there.

**Q: Does it support voice?**
> Yes — built-in voice input (speech-to-text via browser API) and voice output (text-to-speech). You can dictate messages from your phone and hear responses read aloud.

---

## 6. Comparison & Alternatives

**Q: How is this different from Claude.ai or the Anthropic web app?**
> Claude.ai is a general chat. This gives you **Claude Code** — an agentic coding assistant that can read/write files, run terminal commands, create commits, and operate on your actual codebase. It's like having VS Code Copilot but accessible from your phone.

**Q: Why not just SSH into your machine and run Claude CLI in terminal?**
> You can, but the experience is terrible on a phone — tiny terminal, no markdown rendering, no syntax highlighting, no copy buttons, no notifications. The web UI is purpose-built for mobile with touch-friendly controls.

---

## 7. FHL-Specific / Presentation Questions

**Q: How long did this take to build?**
> This was built during FHL (Fix Hack Learn). The core web bridge, Teams integration, notifications, and mobile-friendly UI were all done within the FHL timeframe — demonstrating how productive you can be when Claude Code is your pair programmer.

**Q: What's next for this project?**
> Key areas: (1) Authentication layer (Entra ID SSO), (2) Teams bot with action buttons for inline responses, (3) File upload/download support, (4) Shared team sessions, (5) Integration with Azure DevOps for PR reviews directly from Teams.

**Q: Can this be used for production/team-wide deployment?**
> Currently it's a single-user bridge running on your machine. For team deployment, you'd want to add authentication, run it on a shared VM or container, and add proper access controls. The architecture is simple enough to extend.
