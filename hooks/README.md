# Claude Code Teams Notification Hook

Get notified in Microsoft Teams when Claude Code needs your attention — when it stops, asks for permission, or needs a decision.

## What You Get

An Adaptive Card notification in your Teams channel with:
- **What happened** — stopped, needs permission, or needs a decision
- **Claude's message** — the last thing Claude said
- **Session info** — working directory and session ID

## Quick Setup

Run the setup script — it handles everything:

```bash
cd hooks
chmod +x setup-hooks.sh
./setup-hooks.sh
```

The script will:
1. Copy the hook script to `~/.claude/hooks/`
2. Ask for your Teams webhook URL
3. Save the URL to your shell profile
4. Configure Claude Code hooks in `~/.claude/settings.json`
5. Send a test notification to verify it works

## Prerequisites

- **Node.js** (used to build the Adaptive Card payload)
- **curl** (used to send the webhook request)
- **A Teams Incoming Webhook URL** — see below

### Creating a Teams Webhook URL

1. Open **Microsoft Teams** and go to the channel you want notifications in
2. Click **`...`** next to the channel name -> **Workflows**
3. Choose **"Post to a channel when a webhook request is received"**
4. Pick the channel -> **Create** -> copy the **webhook URL**

## Manual Setup

If you prefer to set things up yourself:

### 1. Copy the hook script

```bash
mkdir -p ~/.claude/hooks
cp notify-teams.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/notify-teams.sh
```

### 2. Set the webhook URL

Add to your `~/.bashrc` or `~/.zshrc`:

```bash
export CLAUDE_TEAMS_WEBHOOK_URL="<your-webhook-url>"
```

Then reload: `source ~/.bashrc`

### 3. Configure Claude Code hooks

Add this to `~/.claude/settings.json`:

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

## Uninstall

```bash
./setup-hooks.sh --uninstall
```

Then manually remove the `CLAUDE_TEAMS_WEBHOOK_URL` line from your shell profile.

## Hook Events

| Event | Trigger | Notification Title |
|-------|---------|-------------------|
| `Stop` | Claude finishes and waits for input | "Claude is waiting for your response" |
| `Notification` (elicitation_dialog) | Claude asks you to choose | "Claude needs your decision" |
| `Notification` (permission_prompt) | Claude needs tool permission | "Claude needs permission" |
