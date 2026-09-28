// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { LanguageProvider } from '../../i18n';
import { translations } from '../../i18n/translations';
import { JournalSections, hasJournalSections } from '../JournalSections';
import { firstNextStep } from '../../pages/DashboardPage';

const nl = translations.nl as Record<string, string>;
afterEach(cleanup);

describe('JournalSections', () => {
  it('toont samenvatting, feedback (ging goed / kan beter) en volgende stappen', () => {
    try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
    render(
      <LanguageProvider>
        <JournalSections sections={{
          summary: 'Je hebt het verschil tussen én en gegeven leren zien.',
          went_well: ['Je corrigeerde je fouten actief.'],
          to_improve: ['Notatie kan sneller.'],
          next_steps: ['Werk twee 2×2-tabellen uit.', 'Leg het zonder hulp uit.'],
        }} />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('journal-summary')).toHaveTextContent(nl['journal.section.summary']);
    expect(within(screen.getByTestId('journal-went-well')).getByText('Je corrigeerde je fouten actief.')).toBeInTheDocument();
    expect(within(screen.getByTestId('journal-to-improve')).getByText('Notatie kan sneller.')).toBeInTheDocument();
    const steps = screen.getByTestId('journal-next-steps');
    expect(steps.querySelectorAll('li')).toHaveLength(2);
  });

  it('laat lege blokken weg (bv. oordeel van een beoordelaar zonder samenvatting)', () => {
    render(<LanguageProvider><JournalSections sections={{ feedback: 'Goed onderbouwd.', next_steps: [] }} /></LanguageProvider>);
    expect(screen.queryByTestId('journal-summary')).toBeNull();
    expect(screen.queryByTestId('journal-next-steps')).toBeNull();
    expect(screen.getByTestId('journal-feedback')).toHaveTextContent('Goed onderbouwd.');
  });

  it('herkent wanneer een regel blokken heeft', () => {
    expect(hasJournalSections(null)).toBe(false);
    expect(hasJournalSections({ summary: '', went_well: [] })).toBe(false);
    expect(hasJournalSections({ next_steps: ['x'] })).toBe(true);
  });

  it('het Dashboard toont de eerste volgende stap', () => {
    expect(firstNextStep({ next_steps: ['', ' Oefen met Bayes. '] })).toBe('Oefen met Bayes.');
    expect(firstNextStep(null)).toBeNull();
  });
});
