#!/bin/bash
# Claude Code -> Microsoft Teams Notification Hook
# Sends a Teams message when Claude is waiting for user input
#
# Required environment variable:
#   CLAUDE_TEAMS_WEBHOOK_URL - Your Teams Incoming Webhook (via Workflow) URL
#
# Run setup-hooks.sh to install automatically, or see README.md for manual setup.

# Load environment variable from shell profile if not already set
if [ -z "${CLAUDE_TEAMS_WEBHOOK_URL:-}" ]; then
  [ -f ~/.bashrc ] && source ~/.bashrc
  [ -f ~/.zshrc ] && source ~/.zshrc
fi

TEAMS_WEBHOOK_URL="${CLAUDE_TEAMS_WEBHOOK_URL:-}"

if [ -z "$TEAMS_WEBHOOK_URL" ]; then
  echo "Error: CLAUDE_TEAMS_WEBHOOK_URL environment variable is not set." >&2
  echo "Run: export CLAUDE_TEAMS_WEBHOOK_URL=\"<your-webhook-url>\"" >&2
  exit 1
fi

# Read the hook input from stdin
INPUT=$(cat)

# Build and send the payload using Node.js
PAYLOAD=$(echo "$INPUT" | node -e '
const fs = require("fs");
let input = "";
process.stdin.on("data", c => input += c);
process.stdin.on("end", () => {
    let data = {};
    try { data = JSON.parse(input); } catch(e) {}

    const hookEvent = data.hook_event_name || "unknown";
    const notificationType = data.notification_type || "unknown";
    const sessionId = data.session_id || "unknown";
    const cwd = data.cwd || "unknown";
    const transcriptPath = data.transcript_path || "";
    let hookMessage = data.message || "";

    // For Stop events, read last assistant message from transcript file
    if (hookEvent === "Stop" && !hookMessage && transcriptPath) {
        try {
            const lines = fs.readFileSync(transcriptPath, "utf8").trim().split("\n");
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const entry = JSON.parse(lines[i]);
                    if (entry.type === "assistant" && entry.message && entry.message.content) {
                        const content = entry.message.content;
                        if (Array.isArray(content)) {
                            const texts = content
                                .filter(b => b.type === "text" && b.text)
                                .map(b => b.text);
                            if (texts.length) {
                                hookMessage = texts.join(" ");
                                break;
                            }
                        } else if (typeof content === "string" && content) {
                            hookMessage = content;
                            break;
                        }
                    }
                } catch(e) {}
            }
        } catch(e) {}
    }

    // Build title and message based on event type
    let title, message;
    if (hookEvent === "Stop") {
        title = "Here is response from claude, It's your turn";
        message = hookMessage || "Claude has finished and needs your input to continue.";
    } else if (notificationType === "elicitation_dialog") {
        title = "Claude needs your decision";
        message = hookMessage || "Claude is asking you to choose between options.";
    } else if (notificationType === "permission_prompt") {
        title = "Claude needs permission";
        message = hookMessage || "Claude is requesting permission to perform an action.";
    } else {
        title = "Claude needs attention";
        message = hookMessage || "Claude is waiting for you.";
    }

    // Truncate long messages
    if (message.length > 500) {
        message = message.substring(0, 500) + "...";
    }

    // Build Adaptive Card
    const body = [
        { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", color: "Attention" },
        { type: "TextBlock", text: message, wrap: true }
    ];

    body.push({
        type: "FactSet",
        facts: [
            { title: "Directory", value: cwd },
            { title: "Session", value: sessionId }
        ]
    });

    const card = {
        type: "AdaptiveCard",
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        version: "1.4",
        body: body
    };

    const payload = {
        type: "message",
        attachments: [{
            contentType: "application/vnd.microsoft.card.adaptive",
            content: card
        }]
    };

    console.log(JSON.stringify(payload));
});
')

# If payload generation failed, use a simple default
if [ -z "$PAYLOAD" ]; then
  PAYLOAD='{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","content":{"type":"AdaptiveCard","$schema":"http://adaptivecards.io/schemas/adaptive-card.json","version":"1.4","body":[{"type":"TextBlock","text":"Claude needs attention","weight":"Bolder","size":"Medium","color":"Attention"},{"type":"TextBlock","text":"Claude is waiting for you.","wrap":true}]}}]}'
fi

# Send to Teams (fire-and-forget, don't block Claude)
echo "$PAYLOAD" | curl -s -o /dev/null -X POST \
  -H "Content-Type: application/json" \
  -d @- \
  "$TEAMS_WEBHOOK_URL" &

exit 0
