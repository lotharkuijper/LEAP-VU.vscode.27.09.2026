import { Link2 } from 'lucide-react';
import { useLanguage } from '../../i18n';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

/**
 * Suggestie voor de docent hoe LEAP foto en beschrijving het makkelijkst koppelt,
 * afhankelijk van hoeveel foto's er nog een beschrijving nodig hebben. LEAP
 * probeert alle manieren (zie planDocument in server/imageExercises/descriptions.js);
 * dit blok vertelt welke het handigst is.
 */
export function LinkingTips({ waiting }: { waiting: number }) {
  const { t } = useLanguage();
  const tk = (k: string) => t(k as TKey);
  if (waiting === 0) return null;
  const ways = waiting === 1 ? ['oneDoc', 'atPhoto'] : ['sameName', 'headings', 'mentions', 'atPhoto'];
  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/70 px-4 py-3 text-sm text-sky-900" data-testid="tips-linking">
      <p className="flex items-center gap-2 font-semibold">
        <Link2 className="h-4 w-4" />{waiting === 1 ? t('imageEx.tips.titleOne') : t('imageEx.tips.titleMany')}
      </p>
      <ul className="mt-1.5 list-disc space-y-1 pl-6">
        {ways.map((w) => <li key={w}>{tk(`imageEx.tips.${w}`)}</li>)}
      </ul>
      {waiting > 1 && <p className="mt-1.5 text-xs">{t('imageEx.tips.numbering')}</p>}
      <p className="mt-1.5 text-xs">{t('imageEx.tips.always')}</p>
    </div>
  );
}
