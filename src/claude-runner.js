import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Resolve the claude CLI binary path.
 * Checks CLAUDE_PATH env, then ~/.claude/local/claude, then ~/.local/bin/claude, then PATH.
 */
function resolveClaudePath() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;

  const isWin = process.platform === 'win32';
  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', 'local', isWin ? 'claude.exe' : 'claude'),
    path.join(home, '.local', 'bin', isWin ? 'claude.exe' : 'claude'),
  ];

  // On Windows, also check npm global
  if (isWin) {
    const appData = process.env.APPDATA;
    if (appData) candidates.push(path.join(appData, 'npm', 'claude.cmd'));
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p.replace(/\\/g, '/');
  }
  return 'claude'; // fallback to PATH
}

const CLAUDE_EXE = resolveClaudePath();
console.log(`[claude-runner] Claude binary: ${CLAUDE_EXE}`);
const DEFAULT_TIMEOUT_MS = 0; // No timeout — claude manages its own lifecycle

/**
 * Manages Claude CLI execution with session persistence.
 */
export class ClaudeRunner {
  constructor(options = {}) {
    this.sessionId = options.sessionId || randomUUID();
    this.workingDir = options.workingDir || process.cwd();
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.model = options.model || null;
    this.claudePath = options.claudePath || CLAUDE_EXE;
    this.busy = false;
    this.startedAt = null;
    this._activeProc = null;
    this._partialOutput = '';
    this._pendingFollowUp = null; // { prompt, resolve, reject } — single queued follow-up
    this._hasConversation = false; // true after first successful message (so --resume works)
  }

  /** How long the current request has been running (ms), or 0. */
  get elapsed() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  /** Get partial stdout output collected so far (while running). */
  get partialOutput() {
    return this._partialOutput;
  }

  /** The queued follow-up prompt text, or null. */
  get queuedPrompt() {
    return this._pendingFollowUp?.prompt || null;
  }

  /**
   * Queue a follow-up message. Overwrites any existing queued message.
   * Returns a promise that resolves with the follow-up's response.
   */
  queueFollowUp(prompt) {
    if (this._pendingFollowUp) {
      this._pendingFollowUp.resolve('[Replaced by newer follow-up]');
    }
    return new Promise((resolve, reject) => {
      this._pendingFollowUp = { prompt, resolve, reject };
    });
  }

  /** Cancel the queued follow-up. Returns true if there was one. */
  cancelFollowUp() {
    if (this._pendingFollowUp) {
      this._pendingFollowUp.resolve('[Cancelled by user]');
      this._pendingFollowUp = null;
      return true;
    }
    return false;
  }

  /**
   * Interrupt the current request and immediately run a new prompt.
   * Kills the running process, waits briefly, then sends the new message.
   */
  async interrupt(prompt) {
    const partial = this._partialOutput;
    this.cancelFollowUp();
    this.cancel();
    await new Promise(r => setTimeout(r, 1000));
    const prefix = partial
      ? `[NOTE: Your previous request was interrupted. Last output before interruption:\n${partial.slice(-500)}\n]\n\n`
      : '[NOTE: Your previous request was interrupted before producing output.]\n\n';
    return this.run(prefix + prompt);
  }

  cancel() {
    if (this._activeProc) {
      this._activeProc.kill('SIGTERM');
      this._activeProc = null;
      this.busy = false;
      this.startedAt = null;
      return true;
    }
    return false;
  }

  /**
   * Execute a prompt via Claude CLI in non-interactive mode.
   * Only one message at a time per session — rejects if busy.
   * Returns the agent's text response.
   */
  async run(prompt) {
    if (this.busy) {
      return '⏳ Claude is still processing the previous request. Please wait for it to finish before sending another message.';
    }

    this.busy = true;
    this.startedAt = Date.now();
    try {
      return await this._execute(prompt);
    } finally {
      this.busy = false;
      this.startedAt = null;
      this._activeProc = null;
      this._partialOutput = '';
      // Process queued follow-up if any
      if (this._pendingFollowUp) {
        const { prompt: followUp, resolve, reject } = this._pendingFollowUp;
        this._pendingFollowUp = null;
        this.run(followUp).then(resolve).catch(reject);
      }
    }
  }

  async _execute(prompt) {
    const args = [
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--output-format', 'json',
    ];

    // Only use --resume after the first successful exchange (Claude needs an existing conversation)
    if (this._hasConversation) {
      args.push('--resume', this.sessionId);
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    return new Promise((resolve, reject) => {
      const env = { ...process.env, NO_COLOR: '1' };
      // Remove env vars that prevent Claude from launching inside another Claude session
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_SESSION;
      delete env.CLAUDE_CODE_ENTRYPOINT;

      // Strip stray quotes from cwd (user may have typed "C:\path" in the UI prompt)
      const cwd = this.workingDir.replace(/^"|"$/g, '');

      const proc = spawn(this.claudePath, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: this.claudePath.endsWith('.cmd'),
      });
      this._activeProc = proc;
      this._partialOutput = '';

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        // Try to show partial text from JSON result field for live preview
        this._partialOutput = stdout.trim();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = this.timeoutMs > 0 ? setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Claude timed out after ${this.timeoutMs / 1000}s`));
      }, this.timeoutMs) : null;

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (code === 0) {
          // Parse JSON output to extract result text and session_id
          try {
            const json = JSON.parse(stdout.trim());
            // Capture session_id for --resume on subsequent messages
            if (json.session_id) {
              this.sessionId = json.session_id;
              this._hasConversation = true;
            }
            resolve(json.result || '(No output from Claude)');
          } catch {
            // Fallback if JSON parsing fails
            resolve(stdout.trim() || '(No output from Claude)');
          }
        } else {
          resolve(`Claude exited with code ${code}.\n${(stderr || stdout).trim()}`);
        }
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(new Error(`Failed to start Claude: ${err.message}`));
      });
    });
  }
}
