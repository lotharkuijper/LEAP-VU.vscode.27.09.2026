import { BookOpenCheck, Download, X } from 'lucide-react';
import { useLanguage } from '../../i18n';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];
const POINTS = ['seeAndMean', 'concrete', 'onePerSentence', 'importantFirst', 'onlyThisPhoto', 'careful', 'length'] as const;

/** Uitleg voor docenten: wat een goede beschrijving bij een foto is, met voorbeelden en een sjabloon. */
export function ImageDescriptionGuide({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  const tk = (k: string) => t(k as TKey);

  const downloadTemplate = () => {
    const text = `${t('imageEx.guide.templateText')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t('imageEx.guide.templateName')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="title-description-guide" data-testid="dialog-description-guide">
      <div className="chic-card my-8 w-full max-w-3xl space-y-5 p-6">
        <div className="flex items-start justify-between gap-3">
          <h3 id="title-description-guide" className="flex items-center gap-2 text-lg font-semibold text-gray-900">
            <BookOpenCheck className="h-5 w-5 text-amber-600" />{t('imageEx.guide.title')}
          </h3>
          <button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-gray-100" aria-label={t('imageEx.guide.close')} data-testid="button-close-guide"><X className="h-5 w-5" /></button>
        </div>

        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">{t('imageEx.guide.key')}</p>

        <section className="space-y-2">
          <h4 className="font-semibold text-gray-900">{t('imageEx.guide.goodTitle')}</h4>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-gray-700">
            {POINTS.map((p) => <li key={p}>{tk(`imageEx.guide.point.${p}`)}</li>)}
          </ul>
        </section>

        <section className="space-y-2">
          <h4 className="font-semibold text-gray-900">{t('imageEx.guide.formatTitle')}</h4>
          <p className="text-sm text-gray-700">{t('imageEx.guide.format')}</p>
        </section>

        <section className="space-y-3">
          <h4 className="font-semibold text-gray-900">{t('imageEx.guide.examplesTitle')}</h4>
          <figure className="space-y-1">
            <figcaption className="text-xs font-medium text-gray-500">{t('imageEx.guide.exampleShortLabel')}</figcaption>
            <pre className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 font-sans text-sm text-gray-800">{t('imageEx.guide.exampleShort')}</pre>
          </figure>
          <figure className="space-y-1">
            <figcaption className="text-xs font-medium text-gray-500">{t('imageEx.guide.exampleLongLabel')}</figcaption>
            <pre className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 font-sans text-sm text-gray-800">{t('imageEx.guide.exampleLong')}</pre>
          </figure>
        </section>

        <div className="flex flex-wrap justify-between gap-2">
          <button type="button" onClick={downloadTemplate} className="inline-flex items-center gap-2 rounded-xl border border-sky-300 px-4 py-2 text-sm font-medium text-sky-800 hover:bg-sky-50" data-testid="button-download-template">
            <Download className="h-4 w-4" />{t('imageEx.guide.template')}
          </button>
          <button type="button" onClick={onClose} className="btn-primary rounded-xl px-4 py-2 text-sm font-semibold">{t('imageEx.guide.understood')}</button>
        </div>
      </div>
    </div>
  );
}
