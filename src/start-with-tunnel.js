#!/usr/bin/env node
/**
 * Starts the Claude Code Web Bridge + devtunnel with optional auto-reconnect.
 *
 * Usage:
 *   node src/start-with-tunnel.js                          # bridge only (no tunnel)
 *   node src/start-with-tunnel.js --tunnel claude-bridge    # bridge + tunnel
 *   node src/start-with-tunnel.js --tunnel claude-bridge --auto-reconnect  # + auto-reconnect
 *
 * Flags:
 *   --tunnel <name>       Start devtunnel with this tunnel name
 *   --allow-org           Allow anyone with the link (default: your Microsoft account only)
 *   --auto-reconnect      Restart devtunnel automatically if it dies (requires --tunnel)
 *   --reconnect-delay <s> Seconds to wait before reconnecting (default: 5)
 *   --max-retries <n>     Max consecutive reconnect attempts before giving up (default: 0 = unlimited)
 */

import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { qrToTerminal } from './qr-terminal.js';

// Load .env if present
try { await import('dotenv/config'); } catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findDevtunnel() {
  const name = process.platform === 'win32' ? 'devtunnel.exe' : 'devtunnel';
  const candidates = [
    path.join(os.homedir(), '.claude', name),
    path.join(os.homedir(), '.local', 'bin', name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'devtunnel';
}

// Parse args
const args = process.argv.slice(2);
function getFlag(name) { return args.includes(name); }
function getArg(name, defaultVal) {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

const tunnelName = getArg('--tunnel', null);
const allowOrg = getFlag('--allow-org');
const autoReconnect = getFlag('--auto-reconnect');
const reconnectDelay = parseInt(getArg('--reconnect-delay', '5'), 10) * 1000;
const maxRetries = parseInt(getArg('--max-retries', '0'), 10);

// --- Start the bridge server ---
console.log('Starting Claude Code Web Bridge...');
const bridge = spawn(process.execPath, [path.join(__dirname, 'web-bridge.js')], {
  stdio: 'inherit',
  env: process.env,
});

bridge.on('exit', (code) => {
  console.log(`\nBridge exited with code ${code}`);
  process.exit(code || 1);
});

// --- Start devtunnel (if requested) ---
let tunnelProc = null;
let retryCount = 0;
let tunnelStopping = false;

function ensureTunnelExists() {
  const devtunnelBin = findDevtunnel();
  const port = process.env.BRIDGE_PORT || '3847';
  // anonymous access required for Teams tab iframe embedding (private blocks iframes)
  // Security: the tunnel URL is a random string that's hard to guess
  try {
    execSync(`"${devtunnelBin}" create ${tunnelName} --allow-anonymous`, { stdio: 'pipe', shell: true });
    console.log(`Created tunnel "${tunnelName}"`);
  } catch {
    // Tunnel likely already exists — that's fine
  }

  // Add port mapping (ignore error if already exists)
  try {
    execSync(`"${devtunnelBin}" port create ${tunnelName} -p ${port} --protocol http`, { stdio: 'pipe', shell: true });
    console.log(`Added port ${port} to tunnel "${tunnelName}"`);
  } catch {
    // Port mapping likely already exists
  }
}

function startTunnel() {
  if (!tunnelName) return;
  if (tunnelStopping) return;

  ensureTunnelExists();

  const accessLabel = allowOrg ? 'anonymous access (anyone with link)' : 'private (your Microsoft account only)';
  console.log(`\nStarting devtunnel "${tunnelName}" (${accessLabel})...`);
  const tunnelArgs = ['host', tunnelName];
  const devtunnelBin = findDevtunnel();
  tunnelProc = spawn(devtunnelBin, tunnelArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  let tunnelUrlShown = false;

  tunnelProc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);

    // Detect the tunnel URL from devtunnel output
    if (!tunnelUrlShown) {
      const urlMatch = text.match(/(https:\/\/[^\s]+devtunnels\.ms[^\s]*)/);
      if (urlMatch) {
        tunnelUrlShown = true;
        const publicUrl = urlMatch[1].replace(/\/+$/, '');
        // Write public URL to file so the bridge server can serve it in QR
        const urlFile = path.join(os.homedir(), '.claude-web-bridge', 'public-url.txt');
        try { fs.mkdirSync(path.dirname(urlFile), { recursive: true }); } catch {}
        fs.writeFileSync(urlFile, publicUrl, 'utf8');

        console.log(`\n\x1b[38;5;141m======================================================\x1b[0m`);
        console.log(`\x1b[38;5;141m   Public URL — scan to access from anywhere\x1b[0m`);
        console.log(`\x1b[38;5;141m======================================================\x1b[0m`);
        console.log(`\n  \x1b[1m${publicUrl}\x1b[0m\n`);
        try {
          console.log(qrToTerminal(publicUrl).split('\n').map(l => '    ' + l).join('\n'));
        } catch (e) {
          console.log(`  (QR generation failed: ${e.message})`);
        }
        console.log(`\n  \x1b[2mOpen this URL on any device to chat with Claude.\x1b[0m\n`);
      }
    }
  });

  tunnelProc.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  tunnelProc.on('spawn', () => {
    retryCount = 0;
    console.log(`Devtunnel "${tunnelName}" connected`);
  });

  tunnelProc.on('error', (err) => {
    console.error(`\nDevtunnel error: ${err.message}`);
    handleTunnelExit(1);
  });

  tunnelProc.on('exit', (code) => {
    if (tunnelStopping) return;
    console.log(`\nDevtunnel exited with code ${code}`);
    handleTunnelExit(code);
  });
}

function handleTunnelExit(code) {
  tunnelProc = null;
  if (!autoReconnect) {
    console.log('   Devtunnel stopped. Use --auto-reconnect to restart automatically.');
    return;
  }

  retryCount++;
  if (maxRetries > 0 && retryCount > maxRetries) {
    console.log(`   Max retries (${maxRetries}) reached. Giving up on devtunnel.`);
    console.log('   Bridge is still running on localhost.');
    return;
  }

  const delaySec = reconnectDelay / 1000;
  console.log(`   Reconnecting in ${delaySec}s... (attempt ${retryCount}${maxRetries > 0 ? '/' + maxRetries : ''})`);
  setTimeout(startTunnel, reconnectDelay);
}

if (tunnelName) {
  setTimeout(startTunnel, 2000);
} else {
  console.log('No --tunnel flag. Bridge running on localhost only.');
  console.log('   Add --tunnel <name> to start devtunnel automatically.');
}

// Graceful shutdown
function shutdown() {
  tunnelStopping = true;
  console.log('\nShutting down...');
  // Clean up public URL file
  try { fs.unlinkSync(path.join(os.homedir(), '.claude-web-bridge', 'public-url.txt')); } catch {}
  if (tunnelProc) {
    tunnelProc.kill('SIGTERM');
  }
  bridge.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
