import { supabase } from '../lib/supabase';
import { tStatic } from '../i18n/translations';
import { getActiveLang } from '../i18n/activeLang';

/**
 * Onderwerp-bron-abstractie voor de Quiz-omgeving (Task #52, fase 1).
 *
 * Voor fase 1 voeden we de onderwerpenlijst uit één bestaande bron:
 * de `concepts`-tabel — gefilterd op de actieve cursus via het bestaande
 * `/api/concepts` endpoint dat zowel het course_id-schema als de
 * key_points-fallback ondersteunt. Als er geen actieve cursus is, of de
 * cursus geen concepts heeft, valt `/api/concepts` zelf al terug op
 * "globale" concepts.
 *
 * Fase 2 zal deze functie uitbreiden zodat onderwerpen ook uit
 * RAG-documenten en publieke vraag-repositories (zoals ShareStats) kunnen
 * komen — alle UI hangt aan deze ene functie, dus de implementatie kan
 * vervangen worden zonder dat QuizPage iets hoeft te weten.
 */

export interface QuizTopic {
  id: string;
  name: string;
  category?: string;
  /** Voor query-uitbreiding bij het ophalen van cursusmateriaal. */
  definition?: string | null;
  keyPoints?: string[] | null;
  /** "course" | "global" | "empty" — herkomst zoals teruggegeven door /api/concepts. */
  source: 'course' | 'global' | 'empty';
}

export async function getQuizTopics(courseId: string | null): Promise<QuizTopic[]> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    throw new Error(tStatic(getActiveLang(), 'services.quizTopic.notAuthenticated'));
  }

  const params = courseId ? `?courseId=${encodeURIComponent(courseId)}` : '';
  const res = await fetch(`/api/concepts${params}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.error || '';
    } catch { /* ignore */ }
    throw new Error(tStatic(getActiveLang(), 'services.quizTopic.loadFailed', { status: String(res.status) }) + (detail ? `: ${detail}` : ''));
  }

  const data = await res.json();
  const concepts: any[] = Array.isArray(data?.concepts) ? data.concepts : [];
  const source: QuizTopic['source'] = data?.source === 'course' ? 'course'
    : data?.source === 'global' ? 'global'
    : 'empty';

  return concepts
    .filter(c => c && c.id && c.name)
    .map(c => ({
      id: c.id,
      name: c.name,
      category: c.category,
      definition: typeof c.definition === 'string' ? c.definition : null,
      // key_points kan (pre-migratie) cursus-markers als "[course:…]" bevatten; expandQuery filtert die weg.
      keyPoints: Array.isArray(c.key_points) ? c.key_points.filter((k: unknown): k is string => typeof k === 'string') : null,
      source,
    }));
}
