// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const removeChannel = vi.fn();
vi.mock('../supabase', () => ({ supabase: { removeChannel: (c: unknown) => removeChannel(c) } }));

import { liveUpdates } from '../liveUpdates';

describe('liveUpdates', () => {
  beforeEach(() => { vi.useFakeTimers(); removeChannel.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('met Realtime: abonneert, ververst niet periodiek en ruimt het kanaal op', () => {
    const channel = { id: 'kanaal' } as any;
    const subscribe = vi.fn(() => channel);
    const refresh = vi.fn();
    const stop = liveUpdates(subscribe, refresh, 1000, true);
    vi.advanceTimersByTime(5000);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    stop();
    expect(removeChannel).toHaveBeenCalledWith(channel);
  });

  it('zonder Realtime: abonneert niet en ververst periodiek tot het opruimen', () => {
    const subscribe = vi.fn();
    const refresh = vi.fn();
    const stop = liveUpdates(subscribe as any, refresh, 1000, false);
    vi.advanceTimersByTime(3500);
    expect(subscribe).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(5000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('zonder Realtime: slaat verversen over als het tabblad niet zichtbaar is', () => {
    const refresh = vi.fn();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const stop = liveUpdates((() => null) as any, refresh, 1000, false);
    vi.advanceTimersByTime(3000);
    expect(refresh).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
    visibility.mockRestore();
  });

  it('zonder Realtime en interval 0: doet niets (de plek ververst zelf al)', () => {
    const refresh = vi.fn();
    const stop = liveUpdates((() => null) as any, refresh, 0, false);
    vi.advanceTimersByTime(60000);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });
});
