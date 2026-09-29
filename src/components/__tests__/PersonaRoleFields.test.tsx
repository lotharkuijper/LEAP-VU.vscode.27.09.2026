// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../i18n';
import { PersonaRoleFields, roleFieldsPayload, type RoleFieldValues } from '../PersonaRoleFields';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness({ initial, onValue }: { initial: RoleFieldValues; onValue?: (v: RoleFieldValues) => void }) {
  const [v, setV] = useState<RoleFieldValues>(initial);
  return (
    <LanguageProvider>
      <PersonaRoleFields idPrefix="t" value={v} onChange={(n) => { setV(n); onValue?.(n); }} personaName="Wethouder De Vries" courseId="c1" token="tok" />
    </LanguageProvider>
  );
}
const setup = (initial: RoleFieldValues = { persona_type: 'conversational' }, onValue?: (v: RoleFieldValues) => void) => {
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
  render(<Harness initial={initial} onValue={onValue} />);
};

describe('PersonaRoleFields', () => {
  it('een begeleider heeft geen verstandhouding en geen feedbackrondes', () => {
    setup();
    expect(screen.queryByTestId('t-reputation')).toBeNull();
    expect(screen.queryByTestId('t-max-reviews')).toBeNull();
  });

  it('beoordelaar: product en aantal rondes', () => {
    setup();
    fireEvent.click(screen.getByTestId('t-role-evaluator').querySelector('input')!);
    expect(screen.getByTestId('t-deliverable')).toBeInTheDocument();
    expect(screen.getByTestId('t-max-reviews')).toBeInTheDocument();
    expect(screen.queryByTestId('t-reputation')).toBeNull();
  });

  it('rolspeler: gedragsregels verschijnen pas als de verstandhouding aan staat', () => {
    let last: RoleFieldValues = {};
    setup({ persona_type: 'roleplayer' }, (v) => { last = v; });
    expect(screen.queryByTestId('t-rules-positive')).toBeNull();
    fireEvent.click(screen.getByTestId('t-reputation'));
    fireEvent.change(screen.getByTestId('t-rules-positive'), { target: { value: 'Goed voorbereid' } });
    fireEvent.change(screen.getByTestId('t-level-cold'), { target: { value: 'Kortaf' } });
    expect(last.reputation_enabled).toBe(true);
    expect(last.conduct_rules).toMatchObject({ positive: 'Goed voorbereid', levels: { cold: 'Kortaf' } });
    expect(screen.getByText(/verbreekt Wethouder De Vries het contact/)).toBeInTheDocument();
  });

  it('proefgesprek stuurt de (nog niet opgeslagen) regels mee en toont de uitkomst', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ step: 1, reason: 'Goed voorbereid.', key: 'positive' }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    setup({ persona_type: 'roleplayer', reputation_enabled: true, conduct_rules: { positive: 'Voorbereid' } });
    fireEvent.change(screen.getByTestId('t-test-text'), { target: { value: 'Student: we hebben vragen voorbereid' } });
    fireEvent.click(screen.getByTestId('t-test-run'));
    await waitFor(() => expect(screen.getByTestId('t-test-result')).toHaveTextContent('Een stap omhoog, naar welwillend.'));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body));
    expect(body).toMatchObject({ courseId: 'c1', personaName: 'Wethouder De Vries', conduct_rules: { positive: 'Voorbereid' }, level: 0 });
  });

  it('payload: velden die niet bij de rol horen gaan neutraal naar de server', () => {
    expect(roleFieldsPayload({ persona_type: 'conversational', reputation_enabled: true, max_reviews: 3 }))
      .toMatchObject({ persona_type: 'conversational', reputation_enabled: false, conduct_rules: null, max_reviews: null });
    expect(roleFieldsPayload({ persona_type: 'evaluator', max_reviews: 2, deliverable_label: ' Eindproduct ', badge_award_mode: 'group' }))
      .toMatchObject({ max_reviews: 2, deliverable_label: 'Eindproduct', badge_award_mode: 'group', reputation_enabled: false });
  });
});
