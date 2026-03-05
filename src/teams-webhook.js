/**
 * Teams Outgoing Webhook handler.
 *
 * Flow:
 *   1. User @mentions the webhook in a Teams channel
 *   2. Teams POSTs to /api/teams-webhook with HMAC signature
 *   3. We verify the signature, strip the @mention, run Claude
 *   4. If Claude responds within 8s → return inline
 *   5. If not → return "Working on it..." and post full response
 *      via Incoming Webhook (Workflow) when done
 */

import crypto from 'crypto';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const USER_MAP_FILE = path.join(os.homedir(), '.claude-web-bridge', 'teams-user-map.json');
const TIMEOUT_MS = 8000; // Teams expects response within ~10s, we use 8s to be safe

// --- HMAC Verification ---
export function verifyHmac(bufBody, secret) {
  const msgBuf = bufBody;
  const msgHash = 'HMAC ' + crypto
    .createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(msgBuf)
    .digest('base64');
  return msgHash;
}

// --- User → Session mapping (persisted) ---
class TeamsUserMap {
  constructor() {
    this.map = {};
    try {
      this.map = JSON.parse(fs.readFileSync(USER_MAP_FILE, 'utf8'));
    } catch {}
  }
  get(userName) { return this.map[userName]; }
  set(userName, sessionId) {
    this.map[userName] = sessionId;
    try {
      fs.mkdirSync(path.dirname(USER_MAP_FILE), { recursive: true });
      fs.writeFileSync(USER_MAP_FILE, JSON.stringify(this.map, null, 2), 'utf8');
    } catch {}
  }
}

const userMap = new TeamsUserMap();

// --- Post to Incoming Webhook (Workflow) for long responses ---
function postToIncomingWebhook(url, text) {
  if (!url) return;
  // Truncate if too long for Teams message
  const truncated = text.length > 3000 ? text.substring(0, 3000) + '\n\n_(truncated)_' : text;
  // Power Automate Workflow webhooks expect this format
  const payload = JSON.stringify({
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [{
          type: 'TextBlock',
          text: truncated,
          wrap: true,
        }],
      },
    }],
  });
  console.log('[teams] Posting to incoming webhook, payload length:', payload.length);

  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const req = mod.request(u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, (resp) => {
    let body = '';
    resp.on('data', c => body += c);
    resp.on('end', () => {
      if (resp.statusCode >= 400) {
        console.error(`[teams] Incoming webhook responded with ${resp.statusCode}: ${body.substring(0, 300)}`);
      } else {
        console.log(`[teams] Incoming webhook OK (${resp.statusCode})`);
      }
    });
  });
  req.on('error', (e) => console.error('[teams] Incoming webhook error:', e.message));
  req.write(payload);
  req.end();
}

// --- Main handler ---
// Read secret from .env file dynamically (no restart needed after updating .env)
function readEnvValue(key) {
  try {
    const envPath = path.join(process.cwd(), '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return match ? match[1].trim() : process.env[key] || '';
  } catch {
    return process.env[key] || '';
  }
}

export function setupTeamsWebhook(sessions, getRunnerFn, workingDir) {
  console.log('[teams] Webhook endpoint active on /api/teams-webhook');
  console.log('[teams] Secret is read dynamically from .env — no restart needed after updating');

  return async function handleWebhook(req, res) {
    // Read secret dynamically from .env (no restart needed)
    const secret = readEnvValue('TEAMS_WEBHOOK_SECRET');
    const incomingUrl = readEnvValue('TEAMS_INCOMING_WEBHOOK_URL');

    if (!secret) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', text: 'TEAMS_WEBHOOK_SECRET not configured in .env yet.' }));
      return;
    }

    // Read body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bufBody = Buffer.concat(chunks);
    const bodyStr = bufBody.toString('utf8');

    // Verify HMAC
    const authHeader = req.headers['authorization'] || '';
    const expectedHmac = verifyHmac(bufBody, secret);
    console.log('[teams] Auth header:', authHeader.substring(0, 30) + '...');
    console.log('[teams] Expected:   ', expectedHmac.substring(0, 30) + '...');
    if (authHeader !== expectedHmac) {
      // Also try without "HMAC " prefix comparison (some Teams versions differ)
      const authClean = authHeader.replace(/^HMAC\s+/i, '');
      const expectedClean = expectedHmac.replace(/^HMAC\s+/i, '');
      if (authClean !== expectedClean) {
        console.error('[teams] HMAC verification failed');
        console.error('[teams] Body (first 200):', bodyStr.substring(0, 200));
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'message', text: 'Unauthorized: HMAC verification failed' }));
        return;
      }
    }

    let activity;
    try {
      activity = JSON.parse(bodyStr);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', text: 'Invalid JSON' }));
      return;
    }

    // Extract message text — strip HTML tags and @mentions
    let text = (activity.text || '').trim();
    // Teams wraps mentions in <at>BotName</at>
    text = text.replace(/<at>.*?<\/at>/gi, '');
    // Strip all remaining HTML tags
    text = text.replace(/<[^>]*>/g, '');
    // Decode HTML entities
    text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    // Remove leading commas/punctuation left after stripping @mention
    text = text.replace(/^[\s,;:]+/, '').trim();

    if (!text) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', text: 'Please include a message after @mentioning me.' }));
      return;
    }

    const userName = activity.from?.name || 'teams-user';
    console.log(`[teams] Message from ${userName}: ${text.substring(0, 100)}`);

    // Resolve or create session for this user
    let sessionId = userMap.get(userName);
    let session = sessionId ? sessions.get(sessionId) : null;

    if (!session || session.status !== 'active') {
      // Create new session
      session = sessions.create(`Teams: ${userName}`, workingDir);
      sessionId = session.id;
      userMap.set(userName, sessionId);
      console.log(`[teams] Created session ${sessionId} for ${userName}`);
    }

    const runner = getRunnerFn(sessionId);
    sessions.addMessage(sessionId, 'user', text);

    // If runner is busy, queue the message
    if (runner.busy) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', text: '⏳ Claude is still working on the previous request. Your message has been noted — please wait.' }));
      return;
    }

    // Race: Claude response vs timeout
    let responded = false;

    const claudePromise = runner.run(text).then((response) => {
      sessions.addMessage(sessionId, 'bot', response);
      return response;
    }).catch((err) => {
      const errMsg = `Error: ${err.message}`;
      sessions.addMessage(sessionId, 'bot', errMsg);
      return errMsg;
    });

    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS));

    const result = await Promise.race([claudePromise, timeoutPromise]);

    if (result !== null) {
      // Claude responded within timeout
      const reply = result.length > 3000 ? result.substring(0, 3000) + '\n\n_(truncated — full response in next message)_' : result;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', text: reply }));

      // If truncated, also post full response via incoming webhook
      if (result.length > 3000 && incomingUrl) {
        postToIncomingWebhook(incomingUrl, `**Response to ${userName}:**\n\n${result}`);
      }
    } else {
      // Timeout — return working message, post full response later
      responded = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', text: '⏳ Working on it... I\'ll post the response in this channel when done.' }));

      // Wait for Claude to finish and post via incoming webhook
      claudePromise.then((response) => {
        if (incomingUrl) {
          postToIncomingWebhook(incomingUrl, `**@${userName}** — here's the response:\n\n${response}`);
        } else {
          console.log(`[teams] Long response ready but no TEAMS_INCOMING_WEBHOOK_URL configured`);
        }
      });
    }
  };
}
