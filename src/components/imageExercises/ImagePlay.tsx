import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, PlayCircle } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { fetchPlayList, type PlayListItem } from '../../services/image-play.service';
import { PlayBoard } from './PlayBoard';

/** De foto's waarmee een student in deze cursus kan oefenen (leeg als er geen zijn of het niet mag). */
export function useImagePlayItems(courseId: string | null | undefined, enabled = true): PlayListItem[] {
  const [items, setItems] = useState<PlayListItem[]>([]);
  useEffect(() => {
    setItems([]);
    if (!courseId || !enabled) return;
    let alive = true;
    fetchPlayList(courseId).then((list) => { if (alive) setItems(list); }).catch(() => {});
    return () => { alive = false; };
  }, [courseId, enabled]);
  return items;
}

/**
 * "Wat zie ik?" in Ik leg uit: de foto's van de cursus om mee te oefenen, en het
 * speelbord voor de gekozen foto. Geen bestandsnamen (die kunnen het antwoord verraden).
 */
export function ImagePlay({ courseId, items: initial }: { courseId: string; items?: PlayListItem[] }) {
  const { t } = useLanguage();
  const [items, setItems] = useState<PlayListItem[] | null>(initial || null);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () => fetchPlayList(courseId).then(setItems).catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [courseId],
  );
  useEffect(() => { void load(); }, [load]);

  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>;
  if (!items) return <div className="flex items-center gap-2 text-sm text-gray-600"><Loader2 className="h-4 w-4 animate-spin" />{t('imagePlay.loading')}</div>;

  if (active) {
    const index = items.findIndex((i) => i.id === active);
    const next = items.slice(index + 1).find((i) => i.status !== 'finished') || items[index + 1];
    return (
      <PlayBoard
        courseId={courseId}
        exerciseId={active}
        onBack={() => { setActive(null); void load(); }}
        onNext={next ? () => setActive(next.id) : undefined}
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="image-play-list">
      <div className="chic-card space-y-1 p-5">
        <h2 className="text-xl font-bold text-gray-900">{t('imagePlay.title')}</h2>
        <p className="text-sm text-gray-600">{t('imagePlay.intro')}</p>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-gray-600">{t('imagePlay.none')}</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActive(item.id)}
              className="chic-card group overflow-hidden text-left transition hover:shadow-md"
              data-testid={`card-play-${item.id}`}
            >
              {item.imageUrl
                ? <img src={item.imageUrl} alt={t('imagePlay.photoTitle', { n: String(item.number) })} className="h-36 w-full bg-gray-50 object-cover" loading="lazy" />
                : <div className="h-36 w-full bg-gray-100" />}
              <div className="flex items-center justify-between gap-2 p-3">
                <span className="text-sm font-semibold text-gray-900">{t('imagePlay.photoTitle', { n: String(item.number) })}</span>
                {item.status === 'finished' || item.coreDone
                  ? <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 className="h-4 w-4" />{t('imagePlay.status.done')}</span>
                  : item.status === 'active'
                    ? <span className="text-xs text-amber-700">{t('imagePlay.status.busy', { n: String(item.found) })}</span>
                    : <span className="inline-flex items-center gap-1 text-xs text-gray-500"><PlayCircle className="h-4 w-4" />{t('imagePlay.status.new')}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
