// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../../../i18n';
import { ConceptProgressCard } from '../ConceptProgressCard';

afterEach(() => cleanup());

const now = new Date('2026-10-09T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();
const topics = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, name: `Begrip ${i}` }));
const attempts = [
  { topics: ['Begrip 0'], score_percentage: 30, created_at: daysAgo(1) },
  { topics: ['Begrip 1'], score_percentage: 95, created_at: daysAgo(1) },
];

function setup() {
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
  const onPractice = vi.fn();
  render(<LanguageProvider><ConceptProgressCard topics={topics} attempts={attempts} onPractice={onPractice} now={now} /></LanguageProvider>);
  return { onPractice };
}

describe('Jouw voortgang', () => {
  it('toont zwakke begrippen bovenaan met een begrijpelijke reden', () => {
    setup();
    const rows = screen.getAllByTestId(/^row-progress-/);
    expect(rows[0]).toHaveAttribute('data-testid', 'row-progress-t0');
    expect(screen.getByTestId('badge-progress-t0')).toHaveTextContent('Nog lastig');
    expect(rows).toHaveLength(5); // eerst 5, rest via "toon alle"
    fireEvent.click(screen.getByTestId('button-progress-all'));
    expect(screen.getAllByTestId(/^row-progress-/)).toHaveLength(7);
  });

  it('"Oefen wat je lastig vindt" kiest het zwakke begrip en nieuwe, niet wat goed gaat', () => {
    const { onPractice } = setup();
    fireEvent.click(screen.getByTestId('button-practice-weak'));
    const ids = onPractice.mock.calls[0][0] as string[];
    expect(ids[0]).toBe('t0');
    expect(ids).not.toContain('t1');
    expect(ids).toHaveLength(3);
  });
});
