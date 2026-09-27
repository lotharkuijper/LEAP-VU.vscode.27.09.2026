import type { ReactNode } from 'react';
import { AlertTriangle, Info, Lightbulb } from 'lucide-react';
import { useHelpVisible } from './helpVisibility';

type Variant = 'intro' | 'tip' | 'warning';

const STYLES: Record<Variant, string> = {
  intro: 'text-sm text-gray-600',
  tip: 'flex items-start gap-2 rounded-lg border border-sky-100 bg-sky-50/70 px-3 py-2 text-xs text-sky-900',
  warning: 'flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900',
};

/**
 * Eén vaste vorm voor uitleg in het beheer, i.p.v. losse grijze regels en
 * blauwe kaders in allerlei stijlen:
 *  - intro:   korte zin onder een kop die zegt waar dit onderdeel voor is (altijd zichtbaar);
 *  - tip:     extra uitleg voor wie het nog niet kent — verdwijnt als "Uitleg tonen" uit staat;
 *  - warning: iets waar je op moet letten (altijd zichtbaar).
 * Langere uitleg die niet altijd in beeld hoeft, hoort in een HelpTip.
 */
export function AdminHint({ variant = 'intro', children, className = '', testId }: {
  variant?: Variant; children: ReactNode; className?: string; testId?: string;
}) {
  const visible = useHelpVisible();
  if (variant === 'tip' && !visible) return null;
  const Icon = variant === 'tip' ? Lightbulb : variant === 'warning' ? AlertTriangle : Info;
  if (variant === 'intro') return <p className={`${STYLES.intro} ${className}`} data-testid={testId}>{children}</p>;
  return (
    <div className={`${STYLES[variant]} ${className}`} role={variant === 'warning' ? 'note' : undefined} data-testid={testId}>
      <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
