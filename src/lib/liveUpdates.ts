import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

// Live-updates. Met Supabase Realtime luistert de app naar wijzigingen in de
// database. Waar die dienst niet draait (hosting op Azure: de build krijgt
// VITE_PUBLIC_REALTIME=off) ververst de app in plaats daarvan periodiek.
export const REALTIME_ENABLED = import.meta.env.VITE_PUBLIC_REALTIME !== 'off';

/**
 * Abonneert via `subscribe` op Realtime. Zonder Realtime wordt `refresh` elke
 * `pollMs` aangeroepen zolang het tabblad zichtbaar is (0 = niet verversen,
 * voor plekken die zelf al periodiek verversen). Geeft de opruimfunctie terug.
 */
export function liveUpdates(
  subscribe: () => RealtimeChannel,
  refresh: () => void,
  pollMs: number,
  realtime: boolean = REALTIME_ENABLED,
): () => void {
  if (realtime) {
    const channel = subscribe();
    return () => { supabase.removeChannel(channel); };
  }
  if (pollMs <= 0) return () => {};
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, pollMs);
  return () => clearInterval(timer);
}
