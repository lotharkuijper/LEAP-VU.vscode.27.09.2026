// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { LanguageProvider } from '../../i18n';
import { QuizGenerationProgress, progressFraction } from '../QuizGenerationProgress';
import {
  estimateQuizSeconds,
  recordQuizDuration,
  baseEstimateSeconds,
  roundSeconds,
} from '../../lib/quizTimeEstimate';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('quizTimeEstimate', () => {
  it('meerkeuze is sneller dan open, open sneller dan casus', () => {
    for (const n of [1, 3, 6]) {
      const mcq = estimateQuizSeconds('mcq', n).expected;
      const open = estimateQuizSeconds('open', n).expected;
      const casus = estimateQuizSeconds('casus', n).expected;
      expect(mcq).toBeLessThan(open);
      expect(open).toBeLessThan(casus);
    }
  });

  it('groeit met het aantal vragen en geeft een bandbreedte', () => {
    const one = estimateQuizSeconds('open', 1);
    const five = estimateQuizSeconds('open', 5);
    expect(five.expected).toBeGreaterThan(one.expected);
    expect(one.high).toBeGreaterThan(one.low);
  });

  it('leert van gemeten wachttijden, begrensd', () => {
    const before = estimateQuizSeconds('mcq', 3).expected;
    recordQuizDuration('mcq', 3, baseEstimateSeconds('mcq', 3) * 2);
    const after = estimateQuizSeconds('mcq', 3).expected;
    expect(after).toBeGreaterThan(before);
    // Andere vraagvormen blijven ongemoeid.
    expect(estimateQuizSeconds('casus', 3).expected).toBeCloseTo(baseEstimateSeconds('casus', 3));
    for (let i = 0; i < 50; i++) recordQuizDuration('mcq', 3, 10_000);
    expect(estimateQuizSeconds('mcq', 3).expected).toBeLessThanOrEqual(baseEstimateSeconds('mcq', 3) * 3 + 1e-9);
  });

  it('rondt af op vriendelijke waarden', () => {
    expect(roundSeconds(12)).toBe(10);
    expect(roundSeconds(13)).toBe(15);
    expect(roundSeconds(1)).toBe(5);
    expect(roundSeconds(100)).toBe(90);
  });
});

describe('progressFraction', () => {
  it('loopt met de tijd op, maar niet voorbij 90% zolang er vragen ontbreken', () => {
    expect(progressFraction(5, 10, 0, 3)).toBeCloseTo(0.45);
    expect(progressFraction(100, 10, 0, 3)).toBe(0.9);
  });
  it('springt vooruit naarmate vragen worden goedgekeurd', () => {
    expect(progressFraction(1, 100, 2, 2)).toBeCloseTo(0.97);
    expect(progressFraction(0, 10, 0, 3)).toBeGreaterThan(0);
  });
});

describe('QuizGenerationProgress', () => {
  const renderIt = (props: Partial<Parameters<typeof QuizGenerationProgress>[0]> = {}) => render(
    <LanguageProvider>
      <QuizGenerationProgress
        phase="checking"
        approved={1}
        target={3}
        expectedSeconds={20}
        startedAt={Date.now()}
        questionType="casus"
        {...props}
      />
    </LanguageProvider>,
  );

  it('toont voortgangsbalk, telling, fasetekst en resterende tijd', () => {
    renderIt();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.getByTestId('text-quiz-progress-count').textContent).toMatch(/1.*3/);
    expect(screen.getByTestId('text-quiz-progress-message').textContent!.length).toBeGreaterThan(5);
    expect(screen.getByTestId('text-quiz-progress-message').textContent).not.toMatch(/quiz\.progress/);
    expect(screen.getByTestId('text-quiz-progress-remaining').textContent).toMatch(/\d/);
  });

  it('gebruikt een vraagvorm-specifieke tekst tijdens het schrijven', () => {
    renderIt({ phase: 'writing', questionType: 'casus' });
    expect(screen.getByTestId('text-quiz-progress-message').textContent).not.toMatch(/quiz\.progress/);
  });

  it('wisselt de tekst af terwijl je wacht', () => {
    vi.useFakeTimers();
    renderIt({ phase: 'checking' });
    const first = screen.getByTestId('text-quiz-progress-message').textContent;
    act(() => { vi.advanceTimersByTime(3600); });
    expect(screen.getByTestId('text-quiz-progress-message').textContent).not.toBe(first);
  });

  it('meldt eerlijk als het langer duurt dan geschat', () => {
    renderIt({ startedAt: Date.now() - 60_000, expectedSeconds: 20 });
    const txt = screen.getByTestId('text-quiz-progress-remaining').textContent || '';
    expect(txt).not.toMatch(/Nog ongeveer|About/);
    expect(txt.length).toBeGreaterThan(10);
  });
});
