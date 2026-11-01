import { api } from './api';

export type OfflineMutation = {
  id: string;
  endpoint: string;
  method: 'POST' | 'PUT' | 'DELETE';
  body: Record<string, unknown>;
  createdAt: string;
};

const OUTBOX_KEY = 'kastren_offline_outbox';
const CACHE_ACCOUNTS_KEY = 'kastren_cache_accounts';
const CACHE_CATEGORIES_KEY = 'kastren_cache_categories';
const CACHE_TRANSACTIONS_KEY = 'kastren_cache_transactions';
const CACHE_SUMMARY_KEY = 'kastren_cache_summary';

export function getOutbox(): OfflineMutation[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(OUTBOX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveOutbox(mutations: OfflineMutation[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(mutations));
}

export function enqueueMutation(mutation: Omit<OfflineMutation, 'id' | 'createdAt'>): OfflineMutation {
  const item: OfflineMutation = {
    ...mutation,
    id: `mutation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString()
  };
  const current = getOutbox();
  current.push(item);
  saveOutbox(current);
  return item;
}

export function removeMutation(id: string): void {
  const current = getOutbox().filter((m) => m.id !== id);
  saveOutbox(current);
}

export async function flushOutbox(
  onProgress?: (pendingCount: number) => void
): Promise<{ success: number; failed: number }> {
  const mutations = getOutbox();
  if (mutations.length === 0) return { success: 0, failed: 0 };

  let successCount = 0;
  let failedCount = 0;

  for (const m of [...mutations]) {
    try {
      await api(m.endpoint, {
        method: m.method,
        body: JSON.stringify(m.body)
      });
      removeMutation(m.id);
      successCount++;
    } catch (err) {
      failedCount++;
      // If it is a 4xx validation failure, remove the poisoned mutation and proceed with remaining queue
      if (err && typeof err === 'object' && 'status' in err && Number(err.status) >= 400 && Number(err.status) < 500) {
        removeMutation(m.id);
        onProgress?.(getOutbox().length);
        continue;
      }
      break; // Pause outbox processing on network dropout or 5xx server error
    }
    onProgress?.(getOutbox().length);
  }

  return { success: successCount, failed: failedCount };
}

export function setCachedData(key: 'accounts' | 'categories' | 'transactions' | 'summary', data: unknown): void {
  if (typeof window === 'undefined') return;
  const map = {
    accounts: CACHE_ACCOUNTS_KEY,
    categories: CACHE_CATEGORIES_KEY,
    transactions: CACHE_TRANSACTIONS_KEY,
    summary: CACHE_SUMMARY_KEY
  };
  window.localStorage.setItem(map[key], JSON.stringify(data));
}

export function getCachedData<T>(key: 'accounts' | 'categories' | 'transactions' | 'summary'): T | null {
  if (typeof window === 'undefined') return null;
  const map = {
    accounts: CACHE_ACCOUNTS_KEY,
    categories: CACHE_CATEGORIES_KEY,
    transactions: CACHE_TRANSACTIONS_KEY,
    summary: CACHE_SUMMARY_KEY
  };
  try {
    const raw = window.localStorage.getItem(map[key]);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function isOnline(): boolean {
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}
