#!/usr/bin/env node
/**
 * Starts a Cloudflare tunnel for Teams webhook support.
 *
 * Run this ONCE separately from the bridge. The URL stays stable as long as
 * this process is running — you can restart the bridge without losing the URL.
 *
 * Usage:
 *   node src/start-cloudflare.js
 *   npm run cloudflare
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = process.env.BRIDGE_PORT || '3847';

function findCloudflared() {
  const candidates = [
    path.join('C:', 'Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
    path.join('C:', 'Program Files', 'cloudflared', 'cloudflared.exe'),
    path.join(os.homedir(), '.cloudflared', 'cloudflared.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Try PATH
  return 'cloudflared';
}

const cfBin = findCloudflared();
console.log(`Starting Cloudflare tunnel → http://localhost:${PORT}`);
console.log('Keep this running. The URL stays stable until you stop it.\n');

const proc = spawn(cfBin, ['tunnel', '--url', `http://localhost:${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let urlShown = false;
function handleOutput(chunk) {
  const text = chunk.toString();
  process.stderr.write(text);

  if (!urlShown) {
    const match = text.match(/(https:\/\/[^\s]+trycloudflare\.com)/);
    if (match) {
      urlShown = true;
      const cfUrl = match[1].replace(/\/+$/, '');

      // Save URL to file
      const cfFile = path.join(os.homedir(), '.claude-web-bridge', 'cf-url.txt');
      try { fs.mkdirSync(path.dirname(cfFile), { recursive: true }); } catch {}
      fs.writeFileSync(cfFile, cfUrl, 'utf8');

      console.log(`\n\x1b[38;5;45m======================================================\x1b[0m`);
      console.log(`\x1b[38;5;45m   Cloudflare Tunnel — for Teams webhook\x1b[0m`);
      console.log(`\x1b[38;5;45m======================================================\x1b[0m`);
      console.log(`\n  \x1b[1m${cfUrl}\x1b[0m`);
      console.log(`\n  Teams Outgoing Webhook callback URL:`);
      console.log(`  \x1b[1;32m${cfUrl}/api/teams-webhook\x1b[0m`);
      console.log(`\n  \x1b[2mThis URL is stable as long as this process runs.\x1b[0m`);
      console.log(`  \x1b[2mYou can restart the bridge without losing this URL.\x1b[0m\n`);
    }
  }
}

proc.stdout.on('data', handleOutput);
proc.stderr.on('data', handleOutput);

proc.on('exit', (code) => {
  console.log(`\nCloudflare tunnel exited (code ${code})`);
  try { fs.unlinkSync(path.join(os.homedir(), '.claude-web-bridge', 'cf-url.txt')); } catch {}
  process.exit(code || 0);
});

process.on('SIGINT', () => { proc.kill('SIGTERM'); });
process.on('SIGTERM', () => { proc.kill('SIGTERM'); });
