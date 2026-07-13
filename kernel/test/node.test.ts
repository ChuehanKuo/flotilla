import { describe, it, expect, vi } from 'vitest';
import { EventLog } from '../src/log.js';
import { AgentNode } from '../src/node.js';
import { makeCoordinationTools } from '../src/tools/coordination.js';
import { scriptedModel, failingThenTextModel } from './helpers.js';

function deps(model: any, tools: any, log = new EventLog('m-t')) {
  return {
    model, tools, log,
    maxStepsPerTurn: 12,
    beforeModelCall: vi.fn(),
    onUsage: vi.fn(),
    onTurnEnd: vi.fn(),
    onModelFailure: vi.fn(),
    abortSignal: new AbortController().signal,
    _log: log,
  };
}
const spec = { id: 'crew-1', parentId: 'captain', role: 'scan', charter: 'You scan.', taskId: 't2', depth: 2, captain: false };
const order = { kind: 'ORDER' as const, from: 'captain', to: 'crew-1', taskId: 't2', text: 'scan metrics' };
const flush = () => new Promise(r => setTimeout(r, 50));

describe('AgentNode', () => {
  it('runs a turn: tool call then final text, reporting usage and turn end', async () => {
    const api = { delegate: vi.fn(), emitMessage: vi.fn() };
    const tools = makeCoordinationTools({ nodeId: 'crew-1', taskId: 't2', parentId: 'captain', captain: false }, api);
    const model = scriptedModel([
      { toolName: 'report', input: { text: 'starting' } },
      { text: 'done scanning' },
    ]);
    const d = deps(model, tools);
    const node = new AgentNode(spec, d);
    node.enqueue(order);
    await flush();
    expect(api.emitMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'REPORT', text: 'starting' }));
    expect(d.onUsage).toHaveBeenCalled();
    expect(d.onTurnEnd).toHaveBeenCalledWith('crew-1', 'done scanning');
    expect(node.busy).toBe(false);
  });

  it('retries a failed model call once, then succeeds silently', async () => {
    const d = deps(failingThenTextModel(1, 'recovered'), {});
    const node = new AgentNode(spec, d);
    node.enqueue(order);
    await flush();
    expect(d.onModelFailure).not.toHaveBeenCalled();
    expect(d.onTurnEnd).toHaveBeenCalledWith('crew-1', 'recovered');
  });

  it('reports failure after the retry also fails', async () => {
    const d = deps(failingThenTextModel(2, 'never'), {});
    const node = new AgentNode(spec, d);
    node.enqueue(order);
    await flush();
    expect(d.onModelFailure).toHaveBeenCalledWith('crew-1', expect.stringContaining('simulated API error'));
  });

  it('messages arriving mid-turn run as a follow-up turn on the same transcript', async () => {
    const d = deps(scriptedModel([{ text: 'turn one' }, { text: 'turn two' }]), {});
    const node = new AgentNode(spec, d);
    node.enqueue(order);
    node.enqueue({ kind: 'ANSWER', from: 'captain', to: 'crew-1', taskId: 't2', text: 'proceed' });
    await flush();
    expect(d.onTurnEnd).toHaveBeenCalledTimes(2);
    expect(d.onTurnEnd).toHaveBeenLastCalledWith('crew-1', 'turn two');
  });
});
