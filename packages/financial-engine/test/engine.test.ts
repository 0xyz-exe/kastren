import { describe, expect, it } from 'vitest';
import { accountBalance, budgetUsage, cashFlow, savingsProgress, type Entry } from '../src/index';
const rows: Entry[] = [
  { type: 'income', amountMinor: 500000n, accountId: 'a', currency: 'IDR' },
  { type: 'expense', amountMinor: 100000n, accountId: 'a', currency: 'IDR' },
  { type: 'transfer', amountMinor: 50000n, accountId: 'a', toAccountId: 'b', currency: 'IDR' },
];
describe('integer minor-unit financial engine', () => {
  it('balances income, expenses and both transfer legs', () => {
    expect(accountBalance(25000n, 'a', 'IDR', rows)).toBe(375000n);
    expect(accountBalance(0n, 'b', 'IDR', rows)).toBe(50000n);
  });
  it('excludes transfers from cash flow', () => expect(cashFlow(rows)).toEqual({ income: 500000n, expense: 100000n }));
  it('calculates utilization and savings progress', () => {
    expect(budgetUsage(125n, 500n)).toEqual({ remainingMinor: 375n, percent: 25 });
    expect(savingsProgress(250n, 1000n)).toBe(25);
  });
  it('rejects invalid amounts and mixed currencies', () => {
    expect(() => accountBalance(0n, 'a', 'IDR', [{ type: 'income', amountMinor: -1n, accountId: 'a', currency: 'IDR' }])).toThrow();
    expect(() => accountBalance(0n, 'a', 'IDR', [{ type: 'income', amountMinor: 1n, accountId: 'a', currency: 'USD' }])).toThrow();
  });
});
