import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { ConceptPlace } from '../lib/conceptOrder';

// Plek van elk begrip in de stof voor de actieve cursus (GET /api/concepts/order).
// Onthouden per cursus zolang de pagina open is. Mislukt het, dan blijft het
// alfabetisch (null): de lijst werkt altijd.
const cache = new Map<string, Promise<Map<string, ConceptPlace> | null>>();

async function load(courseId: string): Promise<Map<string, ConceptPlace> | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`/api/concepts/order?courseId=${encodeURIComponent(courseId)}`, {
      headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
    });
    if (!res.ok) return null;
    const d = await res.json();
    return new Map(((d.concepts || []) as ConceptPlace[]).map(c => [c.id, c]));
  } catch {
    return null;
  }
}

export function useConceptOrder(courseId: string | null | undefined): Map<string, ConceptPlace> | null {
  const [places, setPlaces] = useState<Map<string, ConceptPlace> | null>(null);
  useEffect(() => {
    let alive = true;
    setPlaces(null);
    if (!courseId) return;
    if (!cache.has(courseId)) cache.set(courseId, load(courseId));
    cache.get(courseId)!.then((m) => {
      if (!m) cache.delete(courseId); // volgende keer opnieuw proberen
      if (alive) setPlaces(m);
    });
    return () => { alive = false; };
  }, [courseId]);
  return places;
}
