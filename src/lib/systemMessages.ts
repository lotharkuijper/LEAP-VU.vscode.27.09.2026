// Systeemberichten van de beheerder (server/system/systemMessages.js).
//
// Eén gedeelde opslag voor de hele app: het Dashboard toont de berichten, het
// menu zet zolang er een openstaat een rood uitroepteken bij "Dashboard".
// Op Azure draait geen Realtime, dus de opslag ververst zelf: bij het openen,
// elke twee minuten zolang het tabblad zichtbaar is, en bij terugkeer naar het
// tabblad.
import { useEffect, useSyncExternalStore } from 'react';
import { supabase } from './supabase';

export interface SystemMessage {
  id: string;
  title: string;
  body: string;
  kind: 'info' | 'warning';
  starts_at: string;
  ends_at: string | null;
}

interface State { messages: SystemMessage[]; userId: string | null }

const POLL_MS = 120_000;
let state: State = { messages: [], userId: null };
const listeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
// Weggeklikt terwijl het verzoek nog loopt: niet terug laten komen.
const dismissedLocally = new Set<string>();

function set(next: State) {
  state = next;
  for (const l of listeners) l();
}

async function token(): Promise<{ token: string | null; userId: string | null }> {
  const { data: { session } } = await supabase.auth.getSession();
  return { token: session?.access_token ?? null, userId: session?.user?.id ?? null };
}

export function loadSystemMessages(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { token: tk, userId } = await token();
      if (!tk) { set({ messages: [], userId: null }); return; }
      const r = await fetch('/api/messages', { headers: { Authorization: `Bearer ${tk}` } });
      if (!r.ok) return;
      const d = await r.json().catch(() => ({}));
      const messages = (Array.isArray(d.messages) ? d.messages : []).filter((m: SystemMessage) => !dismissedLocally.has(m.id));
      set({ messages, userId });
    } catch {
      /* netwerkfout: volgende ronde opnieuw */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function dismissSystemMessage(id: string): Promise<void> {
  dismissedLocally.add(id);
  set({ ...state, messages: state.messages.filter((m) => m.id !== id) });
  try {
    const { token: tk } = await token();
    if (!tk) return;
    await fetch(`/api/messages/${encodeURIComponent(id)}/dismiss`, { method: 'POST', headers: { Authorization: `Bearer ${tk}` } });
  } catch {
    /* lukt het niet, dan komt het bericht bij de volgende keer laden terug */
    dismissedLocally.delete(id);
  }
}

const onVisible = () => { if (document.visibilityState === 'visible') void loadSystemMessages(); };

function start() {
  void loadSystemMessages();
  timer = setInterval(() => { if (document.visibilityState === 'visible') void loadSystemMessages(); }, POLL_MS);
  document.addEventListener('visibilitychange', onVisible);
}
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener('visibilitychange', onVisible);
}

/** Openstaande berichten voor de ingelogde gebruiker (gedeeld tussen Dashboard en menu). */
export function useSystemMessages(): SystemMessage[] {
  const snap = useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => state,
  );
  useEffect(() => {
    users += 1;
    if (users === 1) start();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { dismissedLocally.clear(); set({ messages: [], userId: null }); }
      if (event === 'SIGNED_IN') void loadSystemMessages();
    });
    return () => {
      sub.subscription.unsubscribe();
      users -= 1;
      if (users === 0) stop();
    };
  }, []);
  return snap.messages;
}
