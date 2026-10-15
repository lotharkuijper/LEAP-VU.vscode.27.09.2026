import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { EyeOff } from 'lucide-react';
import { useLanguage } from '../i18n';
import { useCourseFeatures } from '../hooks/useCourseFeatures';
import { featureForPath, type CourseFeature } from '../lib/courseFeatures';

/** Klein label voor staf: dit onderdeel staat uit voor studenten. */
export function FeatureOffBadge({ className = '' }: { className?: string }) {
  const { t } = useLanguage();
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ${className}`}
      data-testid="badge-feature-off"
    >
      <EyeOff className="h-3 w-3" aria-hidden />
      {t('courseFeatures.offForStudents')}
    </span>
  );
}

/**
 * Poort per pagina: staat het onderdeel van deze pagina uit in de actieve
 * cursus, dan ziet een student een nette melding; docent en beheerder zien de
 * pagina met een balk "uit voor studenten".
 */
export function CourseFeatureGate({ children, feature }: { children: ReactNode; feature?: CourseFeature | null }) {
  const { t } = useLanguage();
  const location = useLocation();
  const { view } = useCourseFeatures();
  const f = feature === undefined ? featureForPath(location.pathname) : feature;
  if (!f) return <>{children}</>;
  const v = view(f);
  if (!v.visible) {
    return (
      <div className="mx-auto max-w-xl chic-card p-8 text-center" data-testid="feature-disabled">
        <EyeOff className="mx-auto mb-3 h-10 w-10 text-gray-400" aria-hidden />
        <h1 className="mb-2 text-xl font-bold text-gray-900">{t('courseFeatures.disabledTitle')}</h1>
        <p className="mb-5 text-gray-600">{t('courseFeatures.disabledBody')}</p>
        <Link to="/dashboard" className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700">
          {t('courseFeatures.backToDashboard')}
        </Link>
      </div>
    );
  }
  return (
    <>
      {v.offForStudents && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-testid="banner-feature-off">
          <EyeOff className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
          <span className="min-w-0">{t('courseFeatures.staffBanner')}</span>
        </div>
      )}
      {children}
    </>
  );
}
