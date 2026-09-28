import { Check, TrendingUp, NotebookPen, MessageSquareText, Rocket } from 'lucide-react';
import { useLanguage } from '../i18n';
import { MarkdownMessage } from './MarkdownMessage';

/** Zie server/journalSections.js — de drie blokken van een dagboekregel. */
export interface JournalSectionsData {
  summary?: string;
  went_well?: string[];
  to_improve?: string[];
  feedback?: string;
  next_steps?: string[];
}

const md = 'prose prose-sm max-w-none prose-p:my-0 text-slate-700';

/** Heeft deze regel bruikbare blokken? (anders toont het leerdagboek de tekst). */
export function hasJournalSections(s: unknown): s is JournalSectionsData {
  if (!s || typeof s !== 'object') return false;
  const d = s as JournalSectionsData;
  return !!(d.summary || d.feedback || d.went_well?.length || d.to_improve?.length || d.next_steps?.length);
}

function Items({ items, tone }: { items: string[]; tone: 'good' | 'better' }) {
  const Icon = tone === 'good' ? Check : TrendingUp;
  const iconCls = tone === 'good' ? 'text-emerald-600' : 'text-amber-600';
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${iconCls}`} aria-hidden />
          <MarkdownMessage content={item} className={md} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Een dagboekregel als drie blokken: wat heb je gedaan (samenvatting),
 * feedback (ging goed / kan beter) en je volgende stap (feed-forward).
 * Op een groot scherm staan "ging goed" en "kan beter" naast elkaar.
 */
export function JournalSections({ sections }: { sections: JournalSectionsData }) {
  const { t } = useLanguage();
  const wentWell = sections.went_well ?? [];
  const toImprove = sections.to_improve ?? [];
  const nextSteps = sections.next_steps ?? [];
  const hasFeedback = !!sections.feedback || wentWell.length > 0 || toImprove.length > 0;

  return (
    <div className="space-y-3" data-testid="journal-sections">
      {sections.summary && (
        <section className="rounded-xl bg-white ring-1 ring-teal-100 border-l-4 border-teal-400 px-4 py-3" data-testid="journal-summary">
          <h4 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-teal-700 mb-1.5">
            <NotebookPen className="w-4 h-4" aria-hidden />{t('journal.section.summary')}
          </h4>
          <MarkdownMessage content={sections.summary} className={`${md} text-[15px] leading-relaxed`} />
        </section>
      )}

      {hasFeedback && (
        <section className="rounded-xl bg-slate-50 ring-1 ring-slate-200 px-4 py-3" data-testid="journal-feedback">
          <h4 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600 mb-2">
            <MessageSquareText className="w-4 h-4" aria-hidden />{t('journal.section.feedback')}
          </h4>
          {sections.feedback && <MarkdownMessage content={sections.feedback} className={`${md} mb-2`} />}
          {(wentWell.length > 0 || toImprove.length > 0) && (
            <div className="grid gap-3 md:grid-cols-2">
              {wentWell.length > 0 && (
                <div className="rounded-lg bg-white ring-1 ring-emerald-100 p-3" data-testid="journal-went-well">
                  <h5 className="text-xs font-bold text-emerald-700 mb-1.5">{t('journal.section.wentWell')}</h5>
                  <Items items={wentWell} tone="good" />
                </div>
              )}
              {toImprove.length > 0 && (
                <div className="rounded-lg bg-white ring-1 ring-amber-100 p-3" data-testid="journal-to-improve">
                  <h5 className="text-xs font-bold text-amber-700 mb-1.5">{t('journal.section.toImprove')}</h5>
                  <Items items={toImprove} tone="better" />
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {nextSteps.length > 0 && (
        <section className="rounded-xl bg-gradient-to-br from-teal-50 to-cyan-50 ring-1 ring-teal-200 px-4 py-3" data-testid="journal-next-steps">
          <h4 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-teal-800 mb-2">
            <Rocket className="w-4 h-4" aria-hidden />{t('journal.section.nextSteps')}
          </h4>
          <ol className="space-y-2">
            {nextSteps.map((step, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm">
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-teal-600 text-[11px] font-bold text-white" aria-hidden>{i + 1}</span>
                <MarkdownMessage content={step} className={md} />
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
