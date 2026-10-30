import { useCallback, useEffect, useState } from 'react';
import { fetchLeerlijn, type LeerlijnUnit } from '../services/course-files.service';

// Leerlijn van de actieve cursus voor de chat (server/courses/courseUnits.js): het
// onderdeel bij elke bron, en de keuze "Ik werk aan …" (standaard automatisch:
// dan bepaalt de vraag zelf het onderdeel). De keuze is een gemak per cursus
// in deze browser; geen gegevens die iemand anders ziet.

const KEY = (courseId: string) => `leap-leerlijn-working-on:${courseId}`;

export function useLeerlijn(courseId: string | null) {
  const [units, setUnits] = useState<LeerlijnUnit[]>([]);
  const [docUnit, setDocUnit] = useState<Record<string, string>>({});
  const [workingOn, setWorkingOnState] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUnits([]); setDocUnit({});
    if (!courseId) { setWorkingOnState(null); return; }
    try { setWorkingOnState(localStorage.getItem(KEY(courseId)) || null); } catch { setWorkingOnState(null); }
    fetchLeerlijn(courseId)
      .then((l) => {
        if (cancelled) return;
        const sorted = [...l.units].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
        setUnits(sorted);
        setDocUnit(Object.fromEntries(l.documents.map((d) => [d.documentId, d.unitId])));
        // Een gekozen onderdeel dat niet meer bestaat: terug naar automatisch.
        setWorkingOnState((cur) => (cur && !sorted.some((u) => u.id === cur) ? null : cur));
      })
      .catch(() => { /* geen leerlijn: de chat werkt zoals altijd */ });
    return () => { cancelled = true; };
  }, [courseId]);

  const setWorkingOn = useCallback((id: string | null) => {
    setWorkingOnState(id);
    if (!courseId) return;
    try {
      if (id) localStorage.setItem(KEY(courseId), id);
      else localStorage.removeItem(KEY(courseId));
    } catch { /* opslag geblokkeerd: alleen voor deze sessie */ }
  }, [courseId]);

  const unitTitleOf = useCallback((documentId?: string) => {
    if (!documentId) return undefined;
    const u = units.find((x) => x.id === docUnit[documentId]);
    return u?.title;
  }, [units, docUnit]);

  return { units, workingOn, setWorkingOn, unitTitleOf };
}
