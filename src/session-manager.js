import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const SESSIONS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.claude-web-bridge');
const SESSIONS_FILE = path.join(SESSIONS_DIR, 'sessions.json');
const DEFAULT_TIMEOUT_HOURS = 72; // 3 days

/**
 * Manages multiple Claude sessions with persistence, timeout, and resume.
 *
 * Lifecycle: active -> timed-out -> (resume back to active, or delete)
 * Sessions auto-timeout after inactivity. Timed-out sessions can be resumed
 * since Claude CLI retains its own internal state via --resume.
 */
export class SessionManager {
  constructor(options = {}) {
    this.timeoutHours = options.timeoutHours || DEFAULT_TIMEOUT_HOURS;
    this.sessions = new Map();
    this.messageHistory = new Map(); // sessionId -> messages[]
    this._ensureDir();
    this._load();
    this._cleanupInterval = setInterval(() => this._autoTimeout(), 5 * 60 * 1000);
  }

  _ensureDir() {
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
  }

  _load() {
    try {
      if (fs.existsSync(SESSIONS_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
        for (const s of data.sessions || []) {
          this.sessions.set(s.id, s);
        }
        for (const [id, msgs] of Object.entries(data.messageHistory || {})) {
          this.messageHistory.set(id, msgs);
        }
      }
    } catch {
      // Start fresh if corrupt
    }
  }

  _save() {
    const data = {
      sessions: Array.from(this.sessions.values()),
      messageHistory: Object.fromEntries(this.messageHistory),
    };
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  }

  _autoTimeout() {
    const now = Date.now();
    const cutoff = this.timeoutHours * 60 * 60 * 1000;
    let changed = false;
    for (const s of this.sessions.values()) {
      if (s.status === 'active' && (now - new Date(s.lastActive).getTime()) > cutoff) {
        s.status = 'timed-out';
        changed = true;
      }
    }
    if (changed) this._save();
  }

  /** Create a new session. Returns the session object. */
  create(name, options = {}) {
    const id = randomUUID();
    const session = {
      id,
      name: name || `Session ${this.sessions.size + 1}`,
      status: 'active',
      created: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      messageCount: 0,
      workingDir: options.workingDir || null,
    };
    this.sessions.set(id, session);
    this.messageHistory.set(id, []);
    this._save();
    return session;
  }

  /** Get or create the default active session. */
  getOrCreateDefault() {
    const active = Array.from(this.sessions.values())
      .filter(s => s.status === 'active')
      .sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));
    if (active.length > 0) return active[0];
    return this.create('Default');
  }

  /** Get a session by ID. */
  get(id) {
    return this.sessions.get(id) || null;
  }

  /** List all sessions, sorted by lastActive desc. */
  list(includeTimedOut = true, includeArchived = false) {
    return Array.from(this.sessions.values())
      .filter(s => {
        if (s.status === 'archived') return includeArchived;
        return includeTimedOut || s.status === 'active';
      })
      .sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));
  }

  /** Touch a session (update lastActive, increment messageCount). */
  touch(id) {
    const s = this.sessions.get(id);
    if (s) {
      s.lastActive = new Date().toISOString();
      s.messageCount++;
      if (s.status === 'timed-out') s.status = 'active';
      this._save();
    }
  }

  /** Resume a timed-out session. */
  resume(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.status = 'active';
    s.lastActive = new Date().toISOString();
    this._save();
    return s;
  }

  /** Rename a session. */
  rename(id, name) {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.name = name;
    this._save();
    return s;
  }

  /** Close a session (manual). */
  close(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.status = 'closed';
    this._save();
    return s;
  }

  /** Delete a session permanently. */
  delete(id) {
    this.sessions.delete(id);
    this.messageHistory.delete(id);
    this._save();
  }

  /** Add a message to session history. */
  addMessage(sessionId, role, text) {
    if (!this.messageHistory.has(sessionId)) {
      this.messageHistory.set(sessionId, []);
    }
    const msgs = this.messageHistory.get(sessionId);
    msgs.push({ role, text, time: new Date().toISOString() });
    if (msgs.length > 200) msgs.splice(0, msgs.length - 200);
    this.touch(sessionId);
  }

  /** Get message history for a session. */
  getMessages(sessionId) {
    return this.messageHistory.get(sessionId) || [];
  }

  destroy() {
    clearInterval(this._cleanupInterval);
  }
}
