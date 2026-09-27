import { useEffect, useState } from 'react';
import { X, Loader2, Eye, EyeOff, FileText } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { supabase } from '../../lib/supabase';
import { fetchConceptEvidence, type DocumentChunk } from '../../services/rag.service';
import { setConceptVisibility } from '../../services/course-files.service';
import { Tooltip } from '../help/Tooltip';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

interface ConceptRow {
  id: string;
  name: string;
  definition: string | null;
  key_points: string[] | null;
  review_status: string | null;
  concept_role: string | null;
  difficulty: string | null;
}

/**
 * Zijpaneel met alles over één begrip: definitie, kernpunten, de
 * bronfragmenten waarmee LEAP het onderbouwt, soort, moeilijkheid,
 * itembank-koppelingen en zichtbaarheid voor studenten.
 */
export function ConceptDetailDrawer({
  conceptId,
  courseId,
  onClose,
  onChanged,
  onGoToQuizSources,
}: {
  conceptId: string;
  courseId: string;
  onClose: () => void;
  onChanged?: () => void;
  onGoToQuizSources?: () => void;
}) {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const [concept, setConcept] = useState<ConceptRow | null>(null);
  const [evidence, setEvidence] = useState<DocumentChunk[] | null>(null);
  const [sections, setSections] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('concepts')
        .select('id, name, definition, key_points, review_status, concept_role, difficulty')
        .eq('id', conceptId).maybeSingle();
      if (!cancelled) setConcept((data as unknown as ConceptRow | null) ?? null);
      const ev = await fetchConceptEvidence(conceptId);
      if (!cancelled) setEvidence(ev);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const r = await fetch(`/api/admin/itembank-mappings/${courseId}`, {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        });
        const body = r.ok ? await r.json() : null;
        const rows: Array<{ concept_id: string; exsection_path: string }> = body?.mappings || body?.rows || [];
        if (!cancelled) setSections(rows.filter(m => m.concept_id === conceptId).map(m => m.exsection_path));
      } catch {
        if (!cancelled) setSections([]);
      }
    })();
    return () => { cancelled = true; };
  }, [conceptId, courseId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const visible = concept?.review_status !== 'rejected';
  const toggleVisibility = async () => {
    if (!concept) return;
    setBusy(true);
    setError(null);
    try {
      await setConceptVisibility(courseId, concept.id, !visible);
      setConcept({ ...concept, review_status: visible ? 'rejected' : 'approved' });
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const role = concept?.concept_role === 'example_instance' ? 'example' : null;
  const keyPoints = (concept?.key_points || []).filter(k => typeof k === 'string' && !k.startsWith('[') && !k.startsWith('course_id:'));

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose} data-testid="drawer-concept">
      <aside
        className="h-full w-full max-w-lg bg-white shadow-2xl overflow-y-auto"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('material.drawer.title')}
      >
        <header className="sticky top-0 bg-white/95 backdrop-blur border-b border-gray-100 px-5 py-4 flex items-start gap-3">
          <div className="flex-1">
            <p className="text-xs uppercase tracking-wide text-gray-500">{t('material.drawer.title')}</p>
            <h2 className="text-xl font-bold text-gray-900" data-testid="text-drawer-concept-name">{concept?.name || '…'}</h2>
          </div>
          <Tooltip label={t('material.drawer.close')} side="bottom">
            <button type="button" onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100" data-testid="button-close-drawer">
              <X className="w-5 h-5" />
            </button>
          </Tooltip>
        </header>

        {!concept ? (
          <p className="p-5 text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{t('material.drawer.loading')}</p>
        ) : (
          <div className="p-5 space-y-5 text-sm">
            <div className="flex flex-wrap gap-2">
              {role && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs">{tk(`material.drawer.role.${role}`)}</span>}
              {concept.difficulty && (
                <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs">
                  {t('material.drawer.difficulty')}: {tk(`admin.concepts.difficulty${concept.difficulty.charAt(0).toUpperCase()}${concept.difficulty.slice(1)}`)}
                </span>
              )}
              <span className={`px-2 py-0.5 rounded-full text-xs ${visible ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-600'}`}>
                {visible ? t('material.drawer.visibility') : t('admin.concepts.notApprovedBadge')}
              </span>
            </div>

            <section>
              <h3 className="font-semibold text-gray-900 mb-1">{t('material.drawer.definition')}</h3>
              <p className="text-gray-700 whitespace-pre-wrap">{concept.definition || '—'}</p>
            </section>

            {keyPoints.length > 0 && (
              <section>
                <h3 className="font-semibold text-gray-900 mb-1">{t('material.drawer.keyPoints')}</h3>
                <ul className="list-disc pl-5 text-gray-700 space-y-0.5">{keyPoints.map((k, i) => <li key={i}>{k}</li>)}</ul>
              </section>
            )}

            <section>
              <h3 className="font-semibold text-gray-900 mb-2">{t('material.drawer.evidence')}</h3>
              {evidence === null ? (
                <p className="text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{t('material.drawer.loading')}</p>
              ) : evidence.length === 0 ? (
                <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2" data-testid="text-drawer-no-evidence">{t('material.drawer.noEvidence')}</p>
              ) : (
                <ul className="space-y-2" data-testid="list-drawer-evidence">
                  {evidence.map(e => (
                    <li key={e.id} className="rounded-lg border border-gray-200 p-3">
                      <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                        <span className="inline-flex items-center gap-1 font-medium text-gray-800"><FileText className="w-3.5 h-3.5" />{e.documentTitle}</span>
                        <span>{t('material.drawer.similarity', { pct: String(Math.round((e.similarity || 0) * 100)) })}</span>
                      </div>
                      <p className="text-gray-700 text-xs leading-relaxed line-clamp-5">{e.content}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="font-semibold text-gray-900 mb-1">{t('material.drawer.itembank')}</h3>
              {sections === null ? '…' : sections.length === 0 ? (
                <p className="text-gray-500">{t('material.drawer.itembankNone')}</p>
              ) : (
                <ul className="text-xs text-gray-700 space-y-0.5">{sections.map(s => <li key={s} className="font-mono">{s}</li>)}</ul>
              )}
              {onGoToQuizSources && (
                <button type="button" onClick={onGoToQuizSources} className="mt-1 text-xs text-sky-700 hover:underline">{t('material.drawer.itembankManage')}</button>
              )}
            </section>

            {error && <p className="text-red-700 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
            <button
              type="button"
              onClick={toggleVisibility}
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
              data-testid="button-drawer-toggle-visibility"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              {visible ? t('material.drawer.hide') : t('material.drawer.show')}
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
