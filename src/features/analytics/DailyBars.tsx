// Eenvoudige staafgrafiek per dag (één reeks): staafjes vanaf de basislijn,
// tooltip bij aanwijzen of focus, en een tabel voor schermlezers. Een dag die
// verborgen is (minder dan k studenten) krijgt een lichtgrijs streepjesvlak.
import { useState } from 'react';

export interface DayBar {
  day: string;
  value: number | null;
  suppressed?: boolean;
  /** Extra regels in de tooltip (bv. de verdeling of een bedrag). */
  detail?: string[];
}

export function DailyBars({ bars, label, format, suppressedText, lang, height = 140, testId }: {
  bars: DayBar[];
  label: string;
  format: (n: number) => string;
  suppressedText: string;
  lang: string;
  height?: number;
  testId: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map((b) => b.value || 0));
  const dateLabel = (day: string, opts: Intl.DateTimeFormatOptions) => new Date(`${day}T12:00:00Z`).toLocaleDateString(lang, opts);
  const ticks = bars.length > 1 ? [0, Math.floor((bars.length - 1) / 2), bars.length - 1] : [0];
  const h = hover != null ? bars[hover] : null;

  return (
    <div className="min-w-0" data-testid={testId}>
      <div className="relative" style={{ height }} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {/* Rasterlijn op het maximum en de basislijn: rustig, op de achtergrond. */}
        <div className="absolute inset-x-0 top-0 border-t border-dashed border-gray-200" aria-hidden />
        <span className="absolute right-0 -top-4 text-[11px] text-gray-500" aria-hidden>{format(max)}</span>
        <div className="absolute inset-0 flex items-end gap-[2px]">
          {bars.map((b, i) => {
            const v = b.value || 0;
            const pct = b.suppressed ? 6 : Math.max(v > 0 ? 2 : 0, (v / max) * 100);
            return (
              <button
                key={b.day}
                type="button"
                className="group relative flex h-full min-w-0 flex-1 items-end focus:outline-none"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${dateLabel(b.day, { weekday: 'short', day: 'numeric', month: 'short' })}: ${b.suppressed ? suppressedText : format(v)}`}
              >
                <span
                  className={`block w-full rounded-t ${b.suppressed ? 'bg-[repeating-linear-gradient(45deg,#e5e7eb_0,#e5e7eb_3px,#f9fafb_3px,#f9fafb_6px)]' : 'bg-brand-500'} ${hover === i ? 'opacity-80' : ''} group-focus-visible:ring-2 group-focus-visible:ring-brand-300`}
                  style={{ height: `${pct}%` }}
                />
              </button>
            );
          })}
        </div>
        {h && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg"
            style={{ left: `${((hover! + 0.5) / bars.length) * 100}%`, bottom: height + 4 }}
          >
            <div className="font-semibold whitespace-nowrap">{dateLabel(h.day, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
            <div className="whitespace-nowrap">{h.suppressed ? suppressedText : format(h.value || 0)}</div>
            {!h.suppressed && (h.detail || []).map((d) => <div key={d} className="whitespace-nowrap text-gray-300">{d}</div>)}
          </div>
        )}
      </div>
      <div className="relative mt-1 h-4 text-[11px] text-gray-500" aria-hidden>
        {ticks.map((i) => (
          <span
            key={i}
            className="absolute whitespace-nowrap"
            style={i === 0 ? { left: 0 } : i === bars.length - 1 ? { right: 0 } : { left: `${((i + 0.5) / bars.length) * 100}%`, transform: 'translateX(-50%)' }}
          >
            {dateLabel(bars[i].day, { day: 'numeric', month: 'short' })}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {bars.map((b) => (
            <tr key={b.day}><th scope="row">{b.day}</th><td>{b.suppressed ? suppressedText : format(b.value || 0)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
