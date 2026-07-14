import { describe, it, expect } from 'vitest';
import { Mission } from '../src/kernel.js';
import { defaultConfig } from '../src/types.js';
import { AiSdkDriver, type TurnDriver, type TurnInput, type TurnOutput } from '../src/driver.js';
import { scriptedModel } from './helpers.js';

/** Wraps a driver, recording the formatted `newText` batch it receives each turn. */
class RecordingDriver implements TurnDriver {
  received: string[] = [];
  constructor(private inner: TurnDriver) {}
  async turn(input: TurnInput): Promise<TurnOutput> {
    this.received.push(input.newText);
    return this.inner.turn(input);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

describe('Mission.instruct', () => {
  it('unknown node id is refused', async () => {
    const mission = new Mission('do a thing', defaultConfig(), {
      driverFactory: () => new AiSdkDriver(scriptedModel([{ text: '' }])),
    });
    const resultPromise = mission.start();
    await sleep(20);
    expect(mission.instruct('nonexistent', 'hello')).toEqual({ ok: false, reason: 'no such node' });
    mission.cancel('test done');
    await resultPromise;
  });

  it('instructing a node whose own task has already completed is refused — even while the mission itself is still running', async () => {
    // captain delegates to two crew; crew-1 delivers immediately (its task completes)
    // while crew-2 stays open, so the captain (and the mission) keeps running.
    const captainSteps = [
      { toolName: 'delegate', input: { role: 'a', charter: 'c', task: 't' } },
      { toolName: 'delegate', input: { role: 'b', charter: 'c', task: 't' } },
      { text: 'awaiting crew' },
    ];
    const crew1Steps = [{ toolName: 'deliver', input: { text: 'r1' } }, { text: '' }];
    const crew2Steps = [{ text: '' }]; // never delivers — keeps the captain's task open
    const scripts = [captainSteps, crew1Steps, crew2Steps];
    let callIndex = 0;
    const driverFactory = () => new AiSdkDriver(scriptedModel(scripts[callIndex++]));
    const mission = new Mission('do a thing', defaultConfig(), { driverFactory });

    const resultPromise = mission.start();
    await sleep(20);

    expect(mission.state().status).toBe('running'); // mission itself is not done
    expect(mission.state().tasks['t2'].state).toBe('completed'); // crew-1's task is terminal
    expect(mission.instruct('a-2', 'also do more')).toEqual({ ok: false, reason: 'node finished' });

    mission.cancel('test done');
    await resultPromise;
  });

  it('injects an INSTRUCT into a live working node: logged once, wakes the node with the instruction text', async () => {
    const captainSteps = [
      { text: '' }, // turn 1 (ORDER): ends with empty text — stays 'working', no auto-deliver, node goes idle
      { toolName: 'deliver', input: { text: 'FINAL: covering pediatric ICUs too' } },
      { text: '' }, // turn 2 (INSTRUCT): delivers to the operator, finishing the mission
    ];
    const recorder = new RecordingDriver(new AiSdkDriver(scriptedModel(captainSteps)));
    const mission = new Mission('survey ICU capacity', defaultConfig(), { driverFactory: () => recorder });

    const resultPromise = mission.start();
    await sleep(20); // let turn 1 finish so the captain is idle and 'working'

    const s1 = mission.state();
    expect(s1.tasks['t1'].state).toBe('working');

    const out = mission.instruct('captain', 'also cover pediatric ICUs');
    expect(out).toEqual({ ok: true });

    const res = await resultPromise;
    expect(res.status).toBe('completed');
    expect(res.result).toBe('FINAL: covering pediatric ICUs too');

    // logged exactly once
    const instructEvents = mission.log.events.filter(e => e.type === 'message' && (e.data as any).kind === 'INSTRUCT');
    expect(instructEvents).toHaveLength(1);
    expect(instructEvents[0].data).toMatchObject({
      kind: 'INSTRUCT', from: 'operator', to: 'captain', taskId: 't1', text: 'also cover pediatric ICUs',
    });

    // the node's next turn actually received the instruction as input
    expect(recorder.received).toHaveLength(2);
    expect(recorder.received[1]).toContain('[INSTRUCT from operator');
    expect(recorder.received[1]).toContain('also cover pediatric ICUs');

    // INSTRUCT never touched task state directly (only the subsequent explicit
    // deliver call did) — no stray task.state event was appended by instruct().
    const stateEventsAfterInstruct = mission.log.events.filter(
      e => e.type === 'task.state' && (e.data as any).taskId === 't1',
    );
    // submitted -> working (ORDER) -> completed (deliver); INSTRUCT added no entry.
    expect(stateEventsAfterInstruct.map(e => (e.data as any).state)).toEqual(['submitted', 'working', 'completed']);
  });

  it('mission over: instruct is refused once the mission has finished, even for a node whose own task never reached a terminal state', async () => {
    const captain = scriptedModel([{ text: '' }]); // ends turn 1 idle, task stays 'working'
    const mission = new Mission('do a thing', defaultConfig(), { driverFactory: () => new AiSdkDriver(captain) });
    const resultPromise = mission.start();
    await sleep(20);
    expect(mission.state().tasks['t1'].state).toBe('working');
    mission.cancel('operator aborted');
    await resultPromise;
    expect(mission.instruct('captain', 'too late')).toEqual({ ok: false, reason: 'mission over' });
  });
});
