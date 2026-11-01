import { describe, it, expect, beforeEach, vi } from 'vitest';
import { enqueueMutation, flushOutbox, getOutbox, saveOutbox } from './offline.js';
import * as apiModule from './api.js';

const storage = new Map<string, string>();
const mockLocalStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear()
};
(globalThis as unknown as { window: unknown }).window = {
  localStorage: mockLocalStorage
};

describe('Offline outbox queue resilience', () => {
  beforeEach(() => {
    storage.clear();
    saveOutbox([]);
    vi.restoreAllMocks();
  });

  it('enqueues mutations and persists them', () => {
    const item = enqueueMutation({
      endpoint: '/transactions',
      method: 'POST',
      body: { amountMinor: 5000 }
    });
    const outbox = getOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].id).toBe(item.id);
  });

  it('drops poisoned requests (4xx) and continues processing subsequent valid mutations', async () => {
    enqueueMutation({ endpoint: '/transactions', method: 'POST', body: { invalid: true } });
    enqueueMutation({ endpoint: '/transactions', method: 'POST', body: { valid: true } });

    const apiSpy = vi.spyOn(apiModule, 'api').mockImplementation(async (_endpoint, options) => {
      const body = JSON.parse(String(options?.body ?? '{}'));
      if (body.invalid) {
        throw new apiModule.ApiError(400, 'Invalid request payload');
      }
      return { id: 'success-tx' } as never;
    });

    const result = await flushOutbox();
    expect(result.failed).toBe(1);
    expect(result.success).toBe(1);
    expect(getOutbox()).toHaveLength(0); // Poisoned was dropped, valid was completed
    expect(apiSpy).toHaveBeenCalledTimes(2);
  });

  it('pauses outbox on network dropout (0 or 5xx) to preserve ordering without dropping mutations', async () => {
    enqueueMutation({ endpoint: '/transactions', method: 'POST', body: { first: true } });
    enqueueMutation({ endpoint: '/transactions', method: 'POST', body: { second: true } });

    vi.spyOn(apiModule, 'api').mockImplementation(async () => {
      throw new apiModule.ApiError(0, 'Failed to fetch (offline)');
    });

    const result = await flushOutbox();
    expect(result.failed).toBe(1);
    expect(result.success).toBe(0);
    expect(getOutbox()).toHaveLength(2); // Retained for future retry
  });
});
