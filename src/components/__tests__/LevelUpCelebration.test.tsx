// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../../i18n';
import { translations } from '../../i18n/translations';
import { LevelUpCelebration, ReadinessNotice } from '../LevelUpCelebration';
import { shouldCelebrate, type ReadinessResult } from '../../lib/readiness';
import { nextToEarn, type AchievementRow } from '../AchievementsView';

const nl = translations.nl as Record<string, string>;
beforeEach(() => { try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ } });
afterEach(cleanup);

const ready: ReadinessResult = {
  verdict: 'ready', eligible: true, reason: null, currentLevel: 2, nextLevel: 3,
  topic: 'Patiënt-controleonderzoek', achievement: { id: 'a1', isNew: true, earnedAt: '2026-09-28T10:00:00Z' },
};

describe('feest bij "klaar voor een hoger niveau?"', () => {
  it('alleen bij een positief én geldig oordeel', () => {
    expect(shouldCelebrate(ready)).toBe(true);
    expect(shouldCelebrate({ ...ready, eligible: false, reason: 'too_short' })).toBe(false);
    expect(shouldCelebrate({ ...ready, verdict: 'almost', eligible: false })).toBe(false);
    expect(shouldCelebrate(null)).toBe(false);
  });

  it('toont niveau, onderwerp en achievement; "Ja" verhoogt het niveau pas na bevestiging', () => {
    const onAccept = vi.fn(); const onClose = vi.fn();
    render(<LanguageProvider><LevelUpCelebration result={ready} onAccept={onAccept} onClose={onClose} /></LanguageProvider>);
    expect(screen.getByRole('dialog')).toHaveTextContent(nl['achievements.celebrate.title'].replace('{level}', nl['learningLevel.level3.label']));
    expect(screen.getByTestId('levelup-topic')).toHaveTextContent('Patiënt-controleonderzoek');
    expect(screen.getByTestId('levelup-achievement')).toHaveTextContent(nl['achievements.celebrate.earned']);
    expect(onAccept).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('button-levelup-accept'));
    expect(onAccept).toHaveBeenCalledWith(3);
  });

  it('"Later" en Escape sluiten zonder het niveau te veranderen', () => {
    const onAccept = vi.fn(); const onClose = vi.fn();
    render(<LanguageProvider><LevelUpCelebration result={ready} onAccept={onAccept} onClose={onClose} /></LanguageProvider>);
    fireEvent.click(screen.getByTestId('button-levelup-later'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('korte melding bij een te kort gesprek legt uit waarom het (nog) niet telt', () => {
    render(<LanguageProvider><ReadinessNotice result={{ ...ready, eligible: false, reason: 'too_short' }} onClose={() => {}} /></LanguageProvider>);
    expect(screen.getByTestId('readiness-notice')).toHaveTextContent(nl['achievements.notice.tooShort']);
  });
});

describe('prijzenkast: wat is het volgende om te verdienen?', () => {
  const row = (p: Partial<AchievementRow>): AchievementRow => ({
    id: 'x', course_id: 'C', kind: 'level', topic_label: null, level: 3, evidence_journal_id: null, earned_at: '2026-09-28', ...p,
  });
  it('het volgende cursusniveau en per onderwerp het niveau erboven', () => {
    const locked = nextToEarn([row({ topic_label: 'Bayes', level: 3 }), row({ topic_label: 'Bayes', level: 2 })], 'C', 3);
    expect(locked.map(l => [l.topic, l.level])).toEqual([[null, 4], ['Bayes', 4]]);
  });
  it('niets boven Expert', () => {
    expect(nextToEarn([row({ topic_label: 'Bayes', level: 5 })], 'C', 5)).toEqual([]);
  });
});
