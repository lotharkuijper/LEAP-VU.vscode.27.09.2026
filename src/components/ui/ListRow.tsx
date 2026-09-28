import type { ReactNode } from 'react';
import { RowActions, type RowAction } from './RowActions';

/**
 * Eén vaste opbouw voor een rij in een beheerlijst: links de titel met labels
 * en een regel uitleg, rechts de knoppen. De titel wordt nooit smaller dan
 * een leesbare breedte; passen de knoppen niet, dan verhuizen ze naar
 * "⋯ Meer". Op een telefoon staan de knoppen onder de titel.
 *
 * Gebruik voor nieuwe lijsten deze rij in plaats van een eigen
 * "flex justify-between" met een knoppengroep die niet mag krimpen.
 */
export function ListRow({ title, badges, meta, actions = [], aside, children, testId, menuTestId }: {
  title: ReactNode;
  /** Labels (status e.d.) direct naast/onder de titel. */
  badges?: ReactNode;
  /** Kleine uitleg onder de titel. */
  meta?: ReactNode;
  actions?: RowAction[];
  /** Iets extra's vóór de knoppen (bv. een avatar of teller). */
  aside?: ReactNode;
  /** Inhoud onder de rij (foutmeldingen, uitklapdeel). */
  children?: ReactNode;
  testId?: string;
  menuTestId?: string;
}) {
  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
        <div className="min-w-0 sm:min-w-[12rem] sm:max-w-[55%] sm:flex-[0_1_auto]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div className="min-w-0 break-words font-medium text-gray-900">{title}</div>
            {badges}
          </div>
          {meta && <div className="mt-0.5 space-y-0.5 text-xs text-gray-500">{meta}</div>}
        </div>
        {(actions.length > 0 || aside) && (
          <div className="flex min-w-0 items-center gap-2 sm:flex-[1_1_0%]">
            {aside}
            {actions.length > 0 && <RowActions actions={actions} align="responsive" menuTestId={menuTestId} />}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

/** Klein statuslabel (Actief, Beschikbaar, …) in dezelfde vorm overal. */
export function StatusBadge({ tone = 'neutral', children, title, testId }: {
  tone?: 'neutral' | 'success' | 'warning' | 'info' | 'danger';
  children: ReactNode;
  title?: string;
  testId?: string;
}) {
  const cls = {
    neutral: 'bg-gray-100 text-gray-700',
    success: 'bg-green-100 text-green-800',
    warning: 'bg-orange-100 text-orange-800',
    info: 'bg-blue-100 text-blue-800',
    danger: 'bg-red-100 text-red-800',
  }[tone];
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${cls}`} title={title} data-testid={testId}>
      {children}
    </span>
  );
}
