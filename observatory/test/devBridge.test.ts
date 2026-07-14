import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const BRIDGE_PATH = join(fileURLToPath(import.meta.url), '..', '..', 'src', 'devBridge.mjs');

function seedMission(missionsDir: string, missionId: string, lines: string[]) {
  const dir = join(missionsDir, missionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), lines.map(l => l + '\n').join(''));
  return join(dir, 'events.jsonl');
}

function waitForListeningPort(child: ChildProcessByStdio<null, Readable, Readable>): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const m = buf.match(/BRIDGE_LISTENING (\d+)/);
      if (m) {
        child.stdout.off('data', onData);
        resolve(Number(m[1]));
      }
    };
    child.stdout.on('data', onData);
    child.on('exit', code => reject(new Error(`bridge exited early (code ${code}); stdout: ${buf}`)));
    setTimeout(() => reject(new Error(`bridge never printed BRIDGE_LISTENING; stdout so far: ${buf}`)), 8000);
  });
}

describe('devBridge.mjs (real process, real WS round-trip)', () => {
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    child?.kill('SIGTERM');
    child = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('sends the current file contents as a snapshot, then streams a newly-appended line', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flota-bridge-test-'));
    const missionsDir = join(tmpDir, 'missions');
    const seedEvent = { eventId: 'e1', seq: 1, ts: '2026-07-14T00:00:00.000Z', missionId: 'm-seed', type: 'mission.started', data: { order: 'seed' } };
    const eventsFile = seedMission(missionsDir, 'm-seed', [JSON.stringify(seedEvent)]);

    const proc = spawn(process.execPath, [BRIDGE_PATH, '--port', '0', '--missions-dir', missionsDir, '--mission', 'm-seed'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    let stderr = '';
    proc.stderr.on('data', c => (stderr += c.toString()));

    const port = await waitForListeningPort(proc);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages: any[] = [];
    const gotSnapshot = new Promise<void>((resolve, reject) => {
      ws.on('message', data => {
        const msg = JSON.parse(String(data));
        messages.push(msg);
        if (msg.kind === 'snapshot') resolve();
      });
      ws.on('error', reject);
    });
    await gotSnapshot;

    expect(messages[0]).toMatchObject({ kind: 'snapshot', missionId: 'm-seed', events: [seedEvent] });

    // now append a new line to the log the bridge is tailing, and expect it
    // to be broadcast as a discrete `event` message
    const newEvent = { eventId: 'e2', seq: 2, ts: '2026-07-14T00:00:01.000Z', missionId: 'm-seed', type: 'node.spawned', data: { nodeId: 'captain', role: 'captain', taskId: 't1' } };
    const gotEvent = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for appended event; stderr: ${stderr}`)), 8000);
      ws.on('message', data => {
        const msg = JSON.parse(String(data));
        if (msg.kind === 'event') {
          clearTimeout(timer);
          messages.push(msg);
          resolve();
        }
      });
    });
    appendFileSync(eventsFile, JSON.stringify(newEvent) + '\n');
    await gotEvent;

    const eventMsg = messages.find(m => m.kind === 'event');
    expect(eventMsg).toMatchObject({ kind: 'event', missionId: 'm-seed', event: newEvent });

    ws.close();
  }, 15000);
});
