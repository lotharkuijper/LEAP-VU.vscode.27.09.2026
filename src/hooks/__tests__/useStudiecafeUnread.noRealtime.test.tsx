// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// De stand ZONDER Supabase Realtime, zoals LEAP op Azure draait
// (VITE_PUBLIC_REALTIME=off): de Studiecafé-badge abonneert niet op
// databasewijzigingen, maar blijft bij door zijn eigen periodieke verversing.
vi.mock('../../contexts/AuthContext', () => {
  const session = { access_token: 'test-token' };
  return { useAuth: () => ({ session }) };
});
const channel = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: { channel: (...a: unknown[]) => channel(...a), removeChannel: vi.fn(), auth: { getSession: vi.fn() } },
}));
vi.mock('../../lib/liveUpdates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/liveUpdates')>();
  return { ...actual, REALTIME_ENABLED: false, liveUpdates: (s: any, r: () => void, p: number) => actual.liveUpdates(s, r, p, false) };
});

import { useStudiecafeUnread } from '../useStudiecafeUnread';

let count = 2;
const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ count, announcementCount: 0 }) } as Response));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  count = 2;
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useStudiecafeUnread zonder Realtime (Azure)', () => {
  it('abonneert niet, maar haalt de telling op en ververst elke minuut', async () => {
    const { result } = renderHook(() => useStudiecafeUnread('course-1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.count).toBe(2);
    expect(channel).not.toHaveBeenCalled();

    count = 6;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current.count).toBe(6);
  });
});
