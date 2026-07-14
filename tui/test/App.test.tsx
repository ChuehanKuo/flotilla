import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Mission, defaultConfig, type TurnDriver, type TurnInput, type TurnOutput } from '@flota/kernel';
import { App } from '../src/App.js';

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

interface Step { tool?: 'deliver' | 'escalate'; args?: Record<string, unknown>; text?: string }

// A minimal scripted TurnDriver: each turn() call plays the next step. Calling
// a coordination tool's execute() directly (deliver/escalate) drives real
// Mission routing exactly as the model calling that tool would, without
// pulling in the AI SDK's mock model machinery — this package has no
// dependency on 'ai', and shouldn't need one just to test the TUI shell.
class ScriptedDriver implements TurnDriver {
  private i = 0;
  constructor(private steps: Step[]) {}
  async turn(input: TurnInput): Promise<TurnOutput> {
    const step = this.steps[Math.min(this.i++, this.steps.length - 1)]!;
    if (step.tool) {
      const t = (input.tools as Record<string, { execute: (args: unknown, opts: unknown) => Promise<unknown> }>)[step.tool]!;
      await t.execute(step.args ?? {}, {});
    }
    return { text: step.text ?? '', responseMessages: [], usage: { inputTokens: 10, outputTokens: 5 }, billing: 'subscription' };
  }
}

function newMission(steps: Step[]): Mission {
  return new Mission('test order', defaultConfig(), { driverFactory: () => new ScriptedDriver(steps) });
}

describe('App', () => {
  it('renders the captain row with its driver badge', async () => {
    const mission = newMission([{ text: '' }]); // never delivers — stays running for the test
    const resultPromise = mission.start();

    const { lastFrame, unmount } = render(<App mission={mission} />);
    await sleep(10);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('captain');
    expect(frame).toContain('claude-code');

    unmount();
    mission.cancel('test done');
    await resultPromise;
  });

  it('"i" + typed text + Enter calls mission.instruct with the typed text', async () => {
    const mission = newMission([{ text: '' }]);
    const resultPromise = mission.start();
    const instructSpy = vi.spyOn(mission, 'instruct');

    const { stdin, unmount } = render(<App mission={mission} />);
    await sleep(10); // let the captain-row auto-select effect land

    stdin.write('i');
    for (const ch of 'go faster') stdin.write(ch);
    stdin.write('\r');
    await sleep(10);

    expect(instructSpy).toHaveBeenCalledWith('captain', 'go faster');

    unmount();
    mission.cancel('test done');
    await resultPromise;
  });

  it('shows an escalation in the inbox, and answering it calls answerEscalation', async () => {
    const mission = newMission([
      { tool: 'escalate', args: { question: 'which venue scope?' } },
      { text: '' },
    ]);
    const resultPromise = mission.start();
    const answerSpy = vi.spyOn(mission, 'answerEscalation');

    const { lastFrame, stdin, unmount } = render(<App mission={mission} />);
    await sleep(10);

    expect(lastFrame() ?? '').toContain('which venue scope?');

    stdin.write('a');
    for (const ch of 'scope to ICU only') stdin.write(ch);
    stdin.write('\r');
    await sleep(10);

    expect(answerSpy).toHaveBeenCalledWith('t1', 'scope to ICU only');

    unmount();
    mission.cancel('test done');
    await resultPromise;
  });

  it('echoes typed input in the InputBar frame mid-typing, before Enter', async () => {
    const mission = newMission([{ text: '' }]);
    const resultPromise = mission.start();

    const { lastFrame, stdin, unmount } = render(<App mission={mission} />);
    await sleep(10);

    stdin.write('i');
    // type only half the intended text and check the frame NOW — pins that
    // the buffer renders live, per keystroke, not just once at submit time.
    for (const ch of 'go fas') stdin.write(ch);
    await sleep(10);

    expect(lastFrame() ?? '').toContain('go fas');

    unmount();
    mission.cancel('test done');
    await resultPromise;
  });
});
