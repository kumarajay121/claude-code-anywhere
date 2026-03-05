import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ClaudeRunner } from './claude-runner.js';
import { SessionManager } from './session-manager.js';
import { listRecentSystemSessions, isSessionRunningExternally } from './system-sessions.js';
import { generateQR } from './qr-terminal.js';

// Load .env if present
try { await import('dotenv/config'); } catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.BRIDGE_PORT || '3847', 10);
const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || process.cwd();
const CLAUDE_PATH = process.env.CLAUDE_PATH || undefined;

const sessions = new SessionManager({ timeoutHours: 4 });
const runners = new Map(); // sessionId -> ClaudeRunner
const busySessions = new Set();

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

function serveStatic(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': contentType });
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
  }).catch((err) => {
    sessions.addMessage(sessionId, 'bot', `Error: ${err.message}`);
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
