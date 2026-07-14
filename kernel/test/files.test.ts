import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFileTools } from '../src/tools/files.js';

const opts = { toolCallId: 't', messages: [] as any[] };

describe('file tools sandbox', () => {
  it('writes, lists, reads inside the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'flota-ws-'));
    const tools = makeFileTools(ws) as any;
    await tools.write_file.execute({ path: 'notes/a.md', content: 'hello' }, opts);
    const listing = await tools.list_files.execute({}, opts);
    expect(listing).toContain('notes/a.md');
    const content = await tools.read_file.execute({ path: 'notes/a.md' }, opts);
    expect(content).toBe('hello');
  });

  it('rejects path escapes', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'flota-ws-'));
    const tools = makeFileTools(ws) as any;
    const r1 = await tools.write_file.execute({ path: '../evil.txt', content: 'x' }, opts);
    const r2 = await tools.read_file.execute({ path: '/etc/passwd' }, opts);
    expect(r1).toBe('error: path escapes workspace');
    expect(r2).toBe('error: path escapes workspace');
  });
});
