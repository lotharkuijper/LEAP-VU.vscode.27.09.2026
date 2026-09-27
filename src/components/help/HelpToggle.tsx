import { HelpCircle } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { setHelpVisible, useHelpVisible } from './helpVisibility';

/** Schakelaar "Uitleg tonen" rechtsboven in het beheer. */
export function HelpToggle({ className = '' }: { className?: string }) {
  const { t } = useLanguage();
  const visible = useHelpVisible();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={visible}
      onClick={() => setHelpVisible(!visible)}
      title={visible ? t('help.toggle.on') : t('help.toggle.off')}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${visible ? 'border-sky-300 bg-sky-50 text-sky-800' : 'border-gray-200 bg-white text-gray-500 hover:text-gray-700'} ${className}`}
      data-testid="toggle-help-visible"
    >
      <HelpCircle className="w-3.5 h-3.5" />
      {t('help.toggle.label')}
      <span className={`relative inline-block h-3.5 w-6 rounded-full transition-colors ${visible ? 'bg-sky-500' : 'bg-gray-300'}`} aria-hidden="true">
        <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all ${visible ? 'left-3' : 'left-0.5'}`} />
      </span>
    </button>
  );
}
