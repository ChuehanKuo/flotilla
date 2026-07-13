import { describe, it, expect, vi } from 'vitest';
import { makeCoordinationTools } from '../src/tools/coordination.js';

const opts = { toolCallId: 't', messages: [] as any[] };

function fakeApi() {
  return { delegate: vi.fn().mockReturnValue('spawned crew-1 (task t2)'), emitMessage: vi.fn() };
}

describe('coordination tools', () => {
  it('captain gets delegate+answer, crew gets report; both get deliver+escalate', () => {
    const cap = makeCoordinationTools({ nodeId: 'captain', taskId: 't1', parentId: 'operator', captain: true }, fakeApi());
    const crew = makeCoordinationTools({ nodeId: 'crew-1', taskId: 't2', parentId: 'captain', captain: false }, fakeApi());
    expect(Object.keys(cap).sort()).toEqual(['answer', 'delegate', 'deliver', 'escalate']);
    expect(Object.keys(crew).sort()).toEqual(['deliver', 'escalate', 'report']);
  });

  it('delegate relays kernel refusals verbatim to the model', async () => {
    const api = fakeApi();
    api.delegate.mockReturnValue('refused: depth cap reached');
    const cap = makeCoordinationTools({ nodeId: 'captain', taskId: 't1', parentId: 'operator', captain: true }, api) as any;
    const out = await cap.delegate.execute({ role: 'x', charter: 'y', task: 'z' }, opts);
    expect(out).toBe('refused: depth cap reached');
  });

  it('deliver and escalate emit correctly-addressed messages', async () => {
    const api = fakeApi();
    const crew = makeCoordinationTools({ nodeId: 'crew-1', taskId: 't2', parentId: 'captain', captain: false }, api) as any;
    await crew.deliver.execute({ text: 'result text' }, opts);
    await crew.escalate.execute({ question: 'which scope?' }, opts);
    expect(api.emitMessage).toHaveBeenNthCalledWith(1, { kind: 'DELIVER', from: 'crew-1', to: 'captain', taskId: 't2', text: 'result text' });
    expect(api.emitMessage).toHaveBeenNthCalledWith(2, { kind: 'ESCALATE', from: 'crew-1', to: 'captain', taskId: 't2', text: 'which scope?' });
  });

  it('answer targets the escalating task, not the captain task', async () => {
    const api = fakeApi();
    const cap = makeCoordinationTools({ nodeId: 'captain', taskId: 't1', parentId: 'operator', captain: true }, api) as any;
    await cap.answer.execute({ taskId: 't2', text: 'include both' }, opts);
    expect(api.emitMessage).toHaveBeenCalledWith({ kind: 'ANSWER', from: 'captain', to: '', taskId: 't2', text: 'include both' });
  });
});
