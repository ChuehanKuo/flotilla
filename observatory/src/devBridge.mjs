#!/usr/bin/env node
// Tiny dev-only WebSocket bridge: tails a mission's events.jsonl and streams
// new lines to connected observatory clients in real time. This is a
// stand-in for O3's Tauri Rust file-watcher during `vite dev` — it speaks
// the same wire protocol (see eventSource.ts's createLiveSource), so the
// frontend's live mode doesn't change when the Tauri shell lands.
//
// Run (from repo root):
//   node observatory/src/devBridge.mjs
//   node observatory/src/devBridge.mjs --port 4317 --missions-dir ./missions
//   node observatory/src/devBridge.mjs --mission m-abc123   # pin one mission
//
// Env fallbacks (same precedence, CLI flags win): FLOTA_BRIDGE_PORT,
// FLOTA_MISSIONS_DIR, FLOTA_MISSION_ID.
//
// With no --mission, it auto-follows the newest mission under
// <missions-dir> (by events.jsonl mtime), switching (and re-broadcasting a
// fresh snapshot) whenever a newer one appears — so leaving the bridge
// running and starting a new `flota run` just works.
//
// Binds 127.0.0.1 only. This is a dev tool, not for network exposure.

import { parseArgs } from 'node:util';
import { existsSync, readdirSync, statSync, readFileSync, openSync, readSync, closeSync, watchFile, unwatchFile } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..'); // observatory/src -> observatory -> repo root

const { values: argv } = parseArgs({
  options: {
    port: { type: 'string' },
    'missions-dir': { type: 'string' },
    mission: { type: 'string' },
  },
  allowPositionals: true,
});

const PORT = Number(argv.port ?? process.env.FLOTA_BRIDGE_PORT ?? 4317);
const MISSIONS_DIR = resolve(argv['missions-dir'] ?? process.env.FLOTA_MISSIONS_DIR ?? join(REPO_ROOT, 'missions'));
const PINNED_MISSION = argv.mission ?? process.env.FLOTA_MISSION_ID ?? undefined;
const AUTO_FOLLOW_INTERVAL_MS = 1500;
const TAIL_INTERVAL_MS = 250;

function listMissions() {
  if (!existsSync(MISSIONS_DIR)) return [];
  return readdirSync(MISSIONS_DIR)
    .map(id => ({ id, file: join(MISSIONS_DIR, id, 'events.jsonl') }))
    .filter(m => existsSync(m.file))
    .map(m => ({ ...m, mtimeMs: statSync(m.file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function pickTarget() {
  if (PINNED_MISSION) {
    const file = join(MISSIONS_DIR, PINNED_MISSION, 'events.jsonl');
    return existsSync(file) ? { id: PINNED_MISSION, file } : null;
  }
  const [newest] = listMissions();
  return newest ? { id: newest.id, file: newest.file } : null;
}

// Tolerate a truncated/mid-write line rather than dying — mirrors
// EventLog.load's parse guard in kernel/src/log.ts.
function parseCompleteLines(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

/** @type {{ id: string, file: string, offset: number, pending: string, events: unknown[] } | null} */
let current = null;
let watchedFile = null;

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

// Reads the whole file and splits it into complete lines vs. a possibly
// mid-write trailing partial line, so we never lose or misparse a line that
// was captured half-written.
function readWhole(file) {
  const text = readFileSync(file, 'utf8');
  const lastNewline = text.lastIndexOf('\n');
  const complete = lastNewline === -1 ? '' : text.slice(0, lastNewline);
  const pending = lastNewline === -1 ? text : text.slice(lastNewline + 1);
  const offset = Buffer.byteLength(complete, 'utf8') + (lastNewline === -1 ? 0 : 1);
  return { events: parseCompleteLines(complete), offset, pending };
}

function switchTo(target) {
  if (watchedFile) {
    unwatchFile(watchedFile);
    watchedFile = null;
  }
  if (!target) {
    current = null;
    return;
  }
  const { events, offset, pending } = readWhole(target.file);
  current = { id: target.id, file: target.file, offset, pending, events };
  watchedFile = target.file;
  watchFile(target.file, { interval: TAIL_INTERVAL_MS }, tail);
  broadcast({ kind: 'snapshot', missionId: current.id, events: current.events });
  console.log(`[bridge] following mission ${current.id} (${current.events.length} events so far)`);
}

function tail() {
  if (!current) return;
  let size;
  try {
    size = statSync(current.file).size;
  } catch {
    return; // file briefly missing (e.g. mid mission-dir setup); next poll retries
  }
  if (size === current.offset) return;
  if (size < current.offset) {
    // truncated/rotated (unexpected for events.jsonl, which only appends) — re-read fresh
    switchTo({ id: current.id, file: current.file });
    return;
  }
  const fd = openSync(current.file, 'r');
  const buf = Buffer.alloc(size - current.offset);
  readSync(fd, buf, 0, buf.length, current.offset);
  closeSync(fd);
  current.offset = size;
  const chunk = current.pending + buf.toString('utf8');
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline === -1) {
    current.pending = chunk; // no complete line yet — wait for the next poll
    return;
  }
  const complete = chunk.slice(0, lastNewline);
  current.pending = chunk.slice(lastNewline + 1);
  for (const event of parseCompleteLines(complete)) {
    current.events.push(event);
    broadcast({ kind: 'event', missionId: current.id, event });
  }
}

function autoFollow() {
  if (PINNED_MISSION) return;
  const target = pickTarget();
  if (target && target.id !== current?.id) switchTo(target);
}

wss.on('connection', ws => {
  if (current) ws.send(JSON.stringify({ kind: 'snapshot', missionId: current.id, events: current.events }));
  else ws.send(JSON.stringify({ kind: 'error', message: 'no mission log found yet — waiting for one to start' }));
});

wss.on('listening', () => {
  const addr = wss.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  // machine-parseable line first (tests/tooling grep for this), human line second
  console.log(`BRIDGE_LISTENING ${port}`);
  console.log(
    `[bridge] ws://127.0.0.1:${port} · missions dir: ${MISSIONS_DIR} · ` +
      (PINNED_MISSION ? `pinned mission: ${PINNED_MISSION}` : 'auto-following newest mission'),
  );
});

switchTo(pickTarget());
const followTimer = setInterval(autoFollow, AUTO_FOLLOW_INTERVAL_MS);

function shutdown() {
  clearInterval(followTimer);
  if (watchedFile) unwatchFile(watchedFile);
  wss.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
