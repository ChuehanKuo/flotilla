import { describe, it, expect } from 'vitest';
import { BudgetTracker, BudgetExceededError } from '../src/budget.js';

const pricing = { m1: { inputPerMTok: 3, outputPerMTok: 15 } };

describe('BudgetTracker', () => {
  it('computes cost from token usage', () => {
    const b = new BudgetTracker(pricing, 5);
    const cost = b.addUsage('n1', 'm1', { inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(cost).toBeCloseTo(3 + 1.5);
    expect(b.totalUsd).toBeCloseTo(4.5);
    expect(b.nodeUsd('n1')).toBeCloseTo(4.5);
  });

  it('unknown model costs 0 but does not throw', () => {
    const b = new BudgetTracker(pricing, 5);
    expect(b.addUsage('n1', 'mystery', { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
  });

  it('assertUnderCap throws once the cap is reached', () => {
    const b = new BudgetTracker(pricing, 1);
    b.assertUnderCap(); // fine at 0 spend
    b.addUsage('n1', 'm1', { inputTokens: 400_000, outputTokens: 0 }); // $1.20
    expect(() => b.assertUnderCap()).toThrow(BudgetExceededError);
  });
});
