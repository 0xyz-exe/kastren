export type Entry = { type: 'income' | 'expense' | 'transfer'; amountMinor: bigint; accountId: string; toAccountId?: string; currency: string };
export function accountBalance(openingMinor: bigint, accountId: string, currency: string, entries: Entry[]): bigint {
  return entries.reduce((balance, entry) => {
    if (entry.currency !== currency) throw new Error('Mixed currencies require an explicit conversion rate.');
    if (entry.amountMinor <= 0n) throw new Error('Amounts must be positive integer minor units.');
    if (entry.type === 'income' && entry.accountId === accountId) return balance + entry.amountMinor;
    if (entry.type === 'expense' && entry.accountId === accountId) return balance - entry.amountMinor;
    if (entry.type === 'transfer' && entry.accountId === accountId) return balance - entry.amountMinor;
    if (entry.type === 'transfer' && entry.toAccountId === accountId) return balance + entry.amountMinor;
    return balance;
  }, openingMinor);
}
export function cashFlow(entries: Entry[]) {
  return entries.reduce((s, e) => e.type === 'income' ? { income: s.income + e.amountMinor, expense: s.expense } : e.type === 'expense' ? { income: s.income, expense: s.expense + e.amountMinor } : s, { income: 0n, expense: 0n });
}
export function budgetUsage(spentMinor: bigint, limitMinor: bigint) {
  if (limitMinor <= 0n || spentMinor < 0n) throw new Error('Budget must be positive and spend non-negative.');
  return { remainingMinor: limitMinor - spentMinor, percent: Number(spentMinor * 10000n / limitMinor) / 100 };
}
export function savingsProgress(currentMinor: bigint, targetMinor: bigint) {
  if (currentMinor < 0n || targetMinor <= 0n) throw new Error('Savings amounts are invalid.');
  return Number(currentMinor * 10000n / targetMinor) / 100;
}
