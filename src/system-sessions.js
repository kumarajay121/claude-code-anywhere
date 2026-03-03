import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const CLAUDE_PROJECTS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'projects');

/**
 * Discovers active Claude CLI sessions running on this system.
 * Cross-references running claude processes with session IDs.
 */
export function discoverSystemSessions() {
  const running = getRunningClaudeSessions();
  const sessions = [];

  for (const [sessionId, procInfo] of running) {
    sessions.push({
      id: sessionId,
      pid: procInfo.pid,
      summary: '(running session)',
      cwd: procInfo.cwd || 'unknown',
      source: 'terminal',
    });
  }

  return sessions;
}

/**
 * Lists recent Claude sessions by scanning ~/.claude/projects/ directories.
 * Returns the most recent N sessions.
 */
export function listRecentSystemSessions(limit = 20) {
  const running = getRunningClaudeSessions();
  const sessions = [];

  // Scan ~/.claude/projects/ for session state
  if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    try {
      const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const projDir of projectDirs) {
        const projPath = path.join(CLAUDE_PROJECTS_DIR, projDir.name);
        // Look for .jsonl session files (Claude stores transcripts as .jsonl)
        try {
          const files = fs.readdirSync(projPath)
            .filter(f => f.endsWith('.jsonl') && /^[0-9a-f-]{36}\.jsonl$/i.test(f));

          for (const file of files) {
            const sessionId = file.replace('.jsonl', '');
            const filePath = path.join(projPath, file);
            const stat = fs.statSync(filePath);
            const isRunning = running.has(sessionId);

            // Try to decode the project name from the directory name
            const projectName = decodeProjectDirName(projDir.name);

            sessions.push({
              id: sessionId,
              pid: isRunning ? running.get(sessionId).pid : null,
              status: isRunning ? 'running' : 'idle',
              summary: projectName || projDir.name,
              cwd: projectName || projDir.name,
              branch: 'unknown',
              createdAt: stat.birthtime?.toISOString() || null,
              updatedAt: stat.mtime?.toISOString() || null,
            });
          }
        } catch {
          // Skip unreadable project dirs
        }
      }
    } catch {
      // Projects dir not readable
    }
  }

  return sessions
    .filter(s => s.updatedAt)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, limit);
}

/**
 * Decode Claude's project directory name format.
 * Claude encodes paths like: C--Users-kumaajay-Desktop-project
 */
function decodeProjectDirName(dirName) {
  // Replace leading drive letter pattern and dashes back to path separators
  return dirName
    .replace(/^([A-Z])--/, '$1:\\')
    .replace(/-/g, '\\');
}

/**
 * Check if a specific session has a running claude process (not spawned by the bridge).
 */
export function isSessionRunningExternally(sessionId, bridgePids = new Set()) {
  const running = getRunningClaudeSessions();
  const proc = running.get(sessionId);
  if (!proc) return null;
  if (bridgePids.has(proc.pid)) return null;
  return proc;
}

function getRunningClaudeSessions() {
  const map = new Map(); // sessionId -> { pid, cwd }
  try {
    const output = execSync(
      "Get-CimInstance Win32_Process -Filter \"name='claude.exe' or name='node.exe'\" | Where-Object { $_.CommandLine -like '*claude*--resume*' } | Select-Object ProcessId, CommandLine | ConvertTo-Json",
      { shell: 'powershell.exe', encoding: 'utf-8', timeout: 5000 }
    );
    if (!output.trim()) return map;
    const procs = JSON.parse(output);
    const list = Array.isArray(procs) ? procs : [procs];
    for (const proc of list) {
      if (!proc.CommandLine) continue;
      const allResumes = [...proc.CommandLine.matchAll(/--resume[=\s]+([0-9a-f-]{36})/gi)];
      for (const m of allResumes) {
        map.set(m[1], {
          pid: proc.ProcessId,
          cwd: null,
        });
      }
    }
  } catch {
    // PowerShell not available or no processes
  }
  return map;
}
