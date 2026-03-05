import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ClaudeRunner } from './claude-runner.js';
import { SessionManager } from './session-manager.js';
import { listRecentSystemSessions, isSessionRunningExternally } from './system-sessions.js';
import { generateQR } from './qr-terminal.js';
import { setupTeamsWebhook } from './teams-webhook.js';

// Load .env if present
try { await import('dotenv/config'); } catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.BRIDGE_PORT || '3847', 10);
const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || process.cwd();
const CLAUDE_PATH = process.env.CLAUDE_PATH || undefined;

import os from 'os';
import { execFile } from 'child_process';
import webpush from 'web-push';

const sessions = new SessionManager({ timeoutHours: 4 });
const runners = new Map(); // sessionId -> ClaudeRunner
const busySessions = new Set();

// Windows toast notification — shows native desktop notification when Claude responds
function sendDesktopNotification(title, body) {
  if (process.platform !== 'win32') return;
  const safeTitle = title.replace(/'/g, "''").replace(/`/g, '``');
  const safeBody = (body || '').substring(0, 200).replace(/'/g, "''").replace(/`/g, '``').replace(/\n/g, ' ');
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = @"
<toast duration="short">
  <visual>
    <binding template="ToastGeneric">
      <text>${safeTitle}</text>
      <text>${safeBody}</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Default"/>
</toast>
"@
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Code Bridge')
$toast.Show([Windows.UI.Notifications.ToastNotification]::new($doc))
`;
  execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 5000 }, (err) => {
    if (err) console.error('[notify] Toast error:', err.message);
  });
}

// Web Push notifications — works on any device with a browser, no external app needed
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const pushSubscriptions = new Set();
const pushSubFile = path.join(os.homedir(), '.claude-web-bridge', 'push-subs.json');

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:claude-bridge@localhost', VAPID_PUBLIC, VAPID_PRIVATE);
  // Load saved subscriptions
  try {
    const saved = JSON.parse(fs.readFileSync(pushSubFile, 'utf8'));
    saved.forEach(s => pushSubscriptions.add(JSON.stringify(s)));
    console.log(`[push] Loaded ${saved.length} push subscription(s)`);
  } catch {}
}

function savePushSubscriptions() {
  const subs = [...pushSubscriptions].map(s => JSON.parse(s));
  try {
    fs.mkdirSync(path.dirname(pushSubFile), { recursive: true });
    fs.writeFileSync(pushSubFile, JSON.stringify(subs), 'utf8');
  } catch {}
}

function sendWebPush(title, body) {
  if (!VAPID_PUBLIC || pushSubscriptions.size === 0) return;
  const payload = JSON.stringify({ title, body: body || '' });
  for (const subStr of pushSubscriptions) {
    const sub = JSON.parse(subStr);
    webpush.sendNotification(sub, payload).catch((err) => {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired — remove it
        pushSubscriptions.delete(subStr);
        savePushSubscriptions();
      }
      console.error('[push] Error:', err.statusCode || err.message);
    });
  }
}

// Email notification via Outlook COM — triggers native Outlook notification on phone
// Set NOTIFY_EMAIL in .env (auto-discovered from Outlook if not set)
let notifyEmail = process.env.NOTIFY_EMAIL || '';
let emailCooldown = false;

function sendEmailNotification(title, body) {
  if (!notifyEmail || emailCooldown) return;
  // Throttle: max one email per 30 seconds to avoid spamming
  emailCooldown = true;
  setTimeout(() => { emailCooldown = false; }, 30000);

  const safeTitle = title.replace(/'/g, "''");
  const safeBody = (body || '').substring(0, 300).replace(/'/g, "''").replace(/\n/g, "`r`n");
  const ps = `
$ol = New-Object -ComObject Outlook.Application
$mail = $ol.CreateItem(0)
$mail.To = '${notifyEmail}'
$mail.Subject = '${safeTitle}'
$mail.Body = '${safeBody}'
$mail.Send()
`;
  execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 10000 }, (err) => {
    if (err) console.error('[email-notify] Error:', err.message);
    else console.log(`[email-notify] Sent to ${notifyEmail}`);
  });
}

// Auto-discover email from Outlook if not set
if (!notifyEmail) {
  const discoverPs = `
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace('MAPI')
  $acct = $ns.Accounts | Select-Object -First 1
  if ($acct) { Write-Output $acct.SmtpAddress }
} catch {}
`;
  execFile('powershell', ['-NoProfile', '-Command', discoverPs], { timeout: 10000 }, (err, stdout) => {
    if (!err && stdout.trim()) {
      notifyEmail = stdout.trim();
      console.log(`[email-notify] Auto-discovered email: ${notifyEmail}`);
    }
  });
}

function getBridgePids() {
  const pids = new Set();
  for (const runner of runners.values()) {
    if (runner._activeProc && runner._activeProc.pid) {
      pids.add(runner._activeProc.pid);
    }
  }
  return pids;
}

function getRunner(sessionId) {
  if (!runners.has(sessionId)) {
    const session = sessions.get(sessionId);
    runners.set(sessionId, new ClaudeRunner({
      sessionId,
      workingDir: session?.workingDir || WORKING_DIR,
      claudePath: CLAUDE_PATH,
    }));
  }
  return runners.get(sessionId);
}

// Initialize Teams Outgoing Webhook handler
const teamsWebhookHandler = setupTeamsWebhook(sessions, getRunner, WORKING_DIR);

function serveStatic(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Security-Policy': "frame-ancestors https://teams.microsoft.com https://*.teams.microsoft.com https://*.skype.com https://*.office.com https://*.microsoft.com https://localhost *",
      'X-Tunnel-Skip-AntiPhishing-Page': 'true',
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

const SLASH_COMMANDS = {
  '/help': () => {
    return `**Available commands:**\n• \`/status\` — session info + resume command\n• \`/cwd [path]\` — show or change working directory\n• \`/export\` — export session as markdown\n• \`/help\` — this message\n\n**Session actions:**\n• **Close** — deactivate session (can resume later)\n• **Archive** — remove from sidebar, still in System CLI\n• **Delete** — remove from sidebar (session state on disk is kept)\n• **Import** — bring an idle CLI session into the bridge\n• **Stop & Import** — kill terminal process, then import\n\n_All sessions run with --dangerously-skip-permissions._\n_To continue on your PC: \`claude --resume <session-id>\`_`;
  },
  '/status': (runner, _, session) => {
    return `**Session:** ${session.name}\n**Working Dir:** \`${runner.workingDir}\`\n**Messages:** ${session.messageCount}\n**Session ID:** \`${session.id}\`\n\n**Resume locally:**\n\`\`\`\nclaude --resume ${session.id}\n\`\`\``;
  },
  '/cwd': (runner, arg, session, sessions) => {
    if (!arg) return `**Working directory:** \`${runner.workingDir}\``;
    if (!fs.existsSync(arg)) return `Path not found: \`${arg}\``;
    runner.workingDir = arg;
    session.workingDir = arg;
    sessions._save();
    return `Working directory changed to \`${arg}\``;
  },
  '/export': (runner, _, session, sessions) => {
    const msgs = sessions.getMessages(session.id);
    const lines = [`# ${session.name}`, `Session ID: \`${session.id}\``, `Created: ${session.created}`, `Working Dir: \`${runner.workingDir}\``, ''];
    for (const m of msgs) {
      const t = new Date(m.time).toLocaleTimeString();
      lines.push(m.role === 'user' ? `**You** (${t}): ${m.text}` : `**Claude** (${t}):\n${m.text}`);
      lines.push('');
    }
    return lines.join('\n');
  },
};

function handleSlashCommand(message, runner, session) {
  const [cmd, ...rest] = message.trim().split(/\s+/);
  const handler = SLASH_COMMANDS[cmd.toLowerCase()];
  if (!handler) return null;
  return handler(runner, rest.join(' '), session, sessions);
}

async function handleMessage(req, res) {
  const { message, sessionId, mode } = await readBody(req);
  if (!message?.trim()) return jsonResponse(res, 400, { error: 'Empty message' });

  const session = sessions.get(sessionId);
  if (!session) return jsonResponse(res, 404, { error: 'Session not found' });
  if (session.status !== 'active') return jsonResponse(res, 400, { error: `Session is ${session.status}. Resume it first.` });

  const runner = getRunner(sessionId);

  // Handle slash commands locally (no Claude spawn)
  if (message.startsWith('/')) {
    const result = handleSlashCommand(message, runner, session);
    if (result) {
      sessions.addMessage(sessionId, 'user', message);
      sessions.addMessage(sessionId, 'bot', result);
      return jsonResponse(res, 200, { response: result, sessionId });
    }
  }

  // Session lock: refuse if another claude process is using this session
  const externalProc = isSessionRunningExternally(session.id, getBridgePids());
  if (externalProc) {
    const msg = `Session locked — another process (PID ${externalProc.pid}) is using this session in a terminal. Stop it first with "Stop & Import" from the System CLI section, or close the terminal session.`;
    sessions.addMessage(sessionId, 'user', message);
    sessions.addMessage(sessionId, 'bot', msg);
    return jsonResponse(res, 409, { error: msg, sessionId });
  }

  sessions.addMessage(sessionId, 'user', message);

  // If claude is busy, handle based on mode
  if (runner.busy) {
    if (mode === 'interrupt') {
      console.log(`\n[${new Date().toLocaleTimeString()}] [${session.name}] INTERRUPT: ${message}`);
      busySessions.add(sessionId);
      try {
        const response = await runner.interrupt(message);
        sessions.addMessage(sessionId, 'bot', response);
        console.log(`[${new Date().toLocaleTimeString()}] [${session.name}] ${response.substring(0, 100)}...`);
        return jsonResponse(res, 200, { response, sessionId });
      } catch (err) {
        sessions.addMessage(sessionId, 'bot', `Error: ${err.message}`);
        return jsonResponse(res, 500, { error: err.message });
      } finally {
        busySessions.delete(sessionId);
      }
    } else if (mode === 'queue') {
      console.log(`\n[${new Date().toLocaleTimeString()}] [${session.name}] QUEUED: ${message}`);
      busySessions.add(sessionId);
      try {
        const response = await runner.queueFollowUp(message);
        sessions.addMessage(sessionId, 'bot', response);
        console.log(`[${new Date().toLocaleTimeString()}] [${session.name}] ${response.substring(0, 100)}...`);
        return jsonResponse(res, 200, { response, sessionId });
      } catch (err) {
        sessions.addMessage(sessionId, 'bot', `Error: ${err.message}`);
        return jsonResponse(res, 500, { error: err.message });
      } finally {
        busySessions.delete(sessionId);
      }
    } else {
      return jsonResponse(res, 202, { busy: true, elapsed: runner.elapsed, sessionId });
    }
  }

  console.log(`\n[${new Date().toLocaleTimeString()}] [${session.name}] ${message}`);

  // Fire-and-forget: start Claude in background, return immediately
  busySessions.add(sessionId);
  runner.run(message).then((response) => {
    sessions.addMessage(sessionId, 'bot', response);
    console.log(`[${new Date().toLocaleTimeString()}] [${session.name}] ${response.substring(0, 100)}...`);
    sendDesktopNotification('Claude has responded', response.substring(0, 150));
    sendWebPush('Claude has responded', response.substring(0, 200));
    sendEmailNotification('Claude has responded — please check', response.substring(0, 300));
  }).catch((err) => {
    sessions.addMessage(sessionId, 'bot', `Error: ${err.message}`);
    sendDesktopNotification('Claude error', err.message);
    sendWebPush('Claude error', err.message);
    sendEmailNotification('Claude error', err.message);
  }).finally(() => {
    busySessions.delete(sessionId);
  });

  // Return immediately — client polls GET /api/sessions/:id for result
  return jsonResponse(res, 202, { accepted: true, sessionId });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Static files
  if (req.method === 'GET' && url.pathname === '/') {
    return serveStatic(res, path.join(__dirname, 'public', 'index.html'), 'text/html');
  }
  if (req.method === 'GET' && url.pathname === '/sw.js') {
    return serveStatic(res, path.join(__dirname, 'public', 'sw.js'), 'application/javascript');
  }

  // --- QR code API ---
  if (req.method === 'GET' && url.pathname === '/api/qr') {
    try {
      // Prefer the public devtunnel URL if available
      let accessUrl = null;
      const publicUrlFile = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude-web-bridge', 'public-url.txt');
      try { accessUrl = fs.readFileSync(publicUrlFile, 'utf8').trim(); } catch {}
      if (!accessUrl) {
        const reqHost = req.headers.host || `localhost:${PORT}`;
        const proto = req.headers['x-forwarded-proto'] || 'http';
        accessUrl = `${proto}://${reqHost}`;
      }
      const { grid, size } = generateQR(accessUrl);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ url: accessUrl, grid, size }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // --- Session API ---

  // List system CLI sessions
  if (req.method === 'GET' && url.pathname === '/api/system-sessions') {
    const systemSessions = listRecentSystemSessions(20);
    const bridgeIds = new Set(sessions.list().map(s => s.id));
    for (const s of systemSessions) {
      s.imported = bridgeIds.has(s.id);
    }
    return jsonResponse(res, 200, { sessions: systemSessions });
  }

  // Import a system session into the bridge
  if (req.method === 'POST' && url.pathname === '/api/system-sessions/import') {
    const { sessionId, name, killPid } = await readBody(req);
    if (killPid) {
      try {
        process.kill(killPid, 'SIGTERM');
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          try { process.kill(killPid, 0); } catch { break; }
        }
      } catch {}
    }
    const systemSessions = listRecentSystemSessions(50);
    const sys = systemSessions.find(s => s.id === sessionId);
    if (!sys) return jsonResponse(res, 404, { error: 'System session not found' });
    const existing = sessions.get(sessionId);
    if (existing) {
      if (existing.status === 'archived') {
        existing.status = 'active';
        existing.lastActive = new Date().toISOString();
        sessions._save();
        return jsonResponse(res, 200, { session: existing, message: 'Restored from archive' });
      }
      return jsonResponse(res, 200, { session: existing, message: 'Already imported' });
    }
    const session = {
      id: sessionId,
      name: name || sys.summary || `Imported: ${sessionId.substring(0, 8)}`,
      status: 'active',
      created: sys.createdAt || new Date().toISOString(),
      lastActive: sys.updatedAt || new Date().toISOString(),
      messageCount: 0,
      workingDir: sys.cwd,
    };
    sessions.sessions.set(sessionId, session);
    sessions.messageHistory.set(sessionId, []);
    sessions._save();
    return jsonResponse(res, 201, { session });
  }

  // List bridge sessions (with lock status)
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const list = sessions.list(true);
    const bridgePids = getBridgePids();
    for (const s of list) {
      if (busySessions.has(s.id)) {
        s.locked = null;
      } else {
        const ext = isSessionRunningExternally(s.id, bridgePids);
        s.locked = ext ? ext.pid : null;
      }
    }
    return jsonResponse(res, 200, { sessions: list });
  }

  // Create session
  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    const { name, workingDir } = await readBody(req);
    const session = sessions.create(name, { workingDir });
    return jsonResponse(res, 201, { session });
  }

  // Session actions: /api/sessions/:id/:action
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.+))?$/);
  if (sessionMatch) {
    const [, id, action] = sessionMatch;

    if (req.method === 'GET' && !action) {
      const s = sessions.get(id);
      if (!s) return jsonResponse(res, 404, { error: 'Session not found' });
      const runner = getRunner(id);
      return jsonResponse(res, 200, {
        session: s, busy: runner.busy, elapsed: runner.elapsed,
        partialOutput: runner.busy ? runner.partialOutput : null,
        queuedPrompt: runner.queuedPrompt,
      });
    }

    if (req.method === 'PUT' && action === 'rename') {
      const { name } = await readBody(req);
      const s = sessions.rename(id, name);
      return s ? jsonResponse(res, 200, { session: s }) : jsonResponse(res, 404, { error: 'Not found' });
    }

    if (req.method === 'POST' && action === 'resume') {
      const s = sessions.resume(id);
      return s ? jsonResponse(res, 200, { session: s }) : jsonResponse(res, 404, { error: 'Not found' });
    }

    if (req.method === 'POST' && action === 'cancel') {
      const runner = runners.get(id);
      if (runner) {
        runner.cancelFollowUp();
        if (runner.cancel()) {
          sessions.addMessage(id, 'bot', 'Request cancelled by user.');
          return jsonResponse(res, 200, { cancelled: true });
        }
      }
      return jsonResponse(res, 200, { cancelled: false, message: 'No active request' });
    }

    if (req.method === 'POST' && action === 'cancel-queue') {
      const runner = runners.get(id);
      if (runner?.cancelFollowUp()) {
        return jsonResponse(res, 200, { cancelled: true });
      }
      return jsonResponse(res, 200, { cancelled: false, message: 'No queued message' });
    }

    if (req.method === 'POST' && action === 'close') {
      const s = sessions.close(id);
      runners.delete(id);
      return s ? jsonResponse(res, 200, { session: s }) : jsonResponse(res, 404, { error: 'Not found' });
    }

    if (req.method === 'POST' && action === 'archive') {
      const s = sessions.get(id);
      if (s) {
        s.status = 'archived';
        sessions._save();
      }
      runners.delete(id);
      return jsonResponse(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && !action) {
      sessions.delete(id);
      runners.delete(id);
      return jsonResponse(res, 200, { ok: true });
    }

    if (req.method === 'GET' && action === 'messages') {
      return jsonResponse(res, 200, { messages: sessions.getMessages(id) });
    }
  }

  // Send message (requires sessionId in body)
  if (req.method === 'POST' && url.pathname === '/api/message') {
    return handleMessage(req, res);
  }

  // Web Push — get VAPID public key
  if (req.method === 'GET' && url.pathname === '/api/push/vapid-key') {
    return jsonResponse(res, 200, { key: VAPID_PUBLIC });
  }

  // Web Push — subscribe
  if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
    return readBody(req, (body) => {
      try {
        const sub = JSON.parse(body);
        pushSubscriptions.add(JSON.stringify(sub));
        savePushSubscriptions();
        console.log(`[push] New subscription registered (total: ${pushSubscriptions.size})`);
        return jsonResponse(res, 200, { ok: true });
      } catch (e) {
        return jsonResponse(res, 400, { error: e.message });
      }
    });
  }

  // Teams Outgoing Webhook — receives @mentions from Teams channel
  if (req.method === 'POST' && url.pathname === '/api/teams-webhook') {
    if (teamsWebhookHandler) {
      return teamsWebhookHandler(req, res);
    }
    return jsonResponse(res, 404, { error: 'Teams webhook not configured. Set TEAMS_WEBHOOK_SECRET in .env' });
  }

  // Teams notification — forward to Workflow webhook for personal notification
  if (req.method === 'POST' && url.pathname === '/api/teams-notify') {
    const TEAMS_NOTIFY_URL = process.env.TEAMS_NOTIFY_WEBHOOK_URL;
    if (!TEAMS_NOTIFY_URL) return jsonResponse(res, 200, { skipped: true });
    return readBody(req, (body) => {
      try {
        const { title, body: text } = JSON.parse(body);
        const payload = JSON.stringify({ type: 'message', text: `**${title}**\n\n${text || ''}` });
        const u = new URL(TEAMS_NOTIFY_URL);
        const mod = u.protocol === 'https:' ? require('https') : require('http');
        const r = mod.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (resp) => {
          resp.resume();
        });
        r.on('error', (e) => console.error('[teams-notify] Error:', e.message));
        r.write(payload);
        r.end();
        return jsonResponse(res, 200, { sent: true });
      } catch (e) {
        return jsonResponse(res, 400, { error: e.message });
      }
    });
  }

  // Global status
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const defaultSession = sessions.getOrCreateDefault();
    const runner = getRunner(defaultSession.id);
    return jsonResponse(res, 200, {
      status: runner.busy ? 'busy' : 'ready',
      activeSession: defaultSession,
      totalSessions: sessions.list().length,
      uptime: process.uptime(),
    });
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const defaultSession = sessions.getOrCreateDefault();
  const localUrl = `http://localhost:${PORT}`;

  console.log(`
\x1b[38;5;141m======================================================\x1b[0m
\x1b[38;5;141m   Claude Code Web Bridge\x1b[0m \x1b[2m— Running!\x1b[0m
\x1b[38;5;141m======================================================\x1b[0m

  \x1b[1mLocal:\x1b[0m   ${localUrl}
  \x1b[1mChat:\x1b[0m    ${defaultSession.name} (${defaultSession.id.substring(0, 8)}...)
  \x1b[1mWorkDir:\x1b[0m ${WORKING_DIR}
  \x1b[1mTimeout:\x1b[0m ${sessions.timeoutHours}h inactivity -> auto-close

  \x1b[2mUse \x1b[0mnpm run start:tunnel\x1b[2m for a public URL with QR code.\x1b[0m

  Press Ctrl+C to stop.
`);
});

// HTTPS server for Teams tab (Teams requires https for iframe embedding)
const HTTPS_PORT = parseInt(process.env.BRIDGE_HTTPS_PORT || '3848', 10);
const certDir = path.join(__dirname, '..', 'certs');
const certPath = path.join(certDir, 'cert.pem');
const keyPath = path.join(certDir, 'key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const httpsServer = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  }, server._events.request); // reuse the same request handler

  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`  \x1b[1mHTTPS:\x1b[0m  https://localhost:${HTTPS_PORT}  \x1b[2m(for Teams tab)\x1b[0m`);
  });
}
