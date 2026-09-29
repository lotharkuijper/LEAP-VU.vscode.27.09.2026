// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../i18n';
import { ProductFeedbackPanel } from '../ProductFeedbackPanel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const evaluator = (over: Record<string, unknown> = {}) => ({
  personaId: 'ev1', name: 'Dr. Streng', avatarEmoji: null, avatar: null, deliverableLabel: 'Tussenproduct 1',
  maxReviews: 2, used: 1, remaining: 1, canSubmit: true,
  items: [{ productId: 'p1', filename: 'opzet.docx', createdAt: '2026-09-29T10:00:00Z', badge: 'zilver',
    review: { id: 'r1', verdict: 'conditional', grade: 6.5, reasoning: 'Onderbouwing mist.', feed_forward: 'Voeg bronnen toe.', created_at: '2026-09-29T10:00:00Z' } }],
  ...over,
});

function setup(list: unknown[], postResponse?: unknown) {
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { ok: true, json: async () => postResponse } as unknown as Response;
    return { ok: true, json: async () => ({ evaluators: list }) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<LanguageProvider><ProductFeedbackPanel projectId="pr" groupId="g" token="t" /></LanguageProvider>);
  return fetchMock;
}

describe('ProductFeedbackPanel', () => {
  it('toont product, resterende rondes en eerdere feedback', async () => {
    setup([evaluator()]);
    expect(await screen.findByTestId('text-feedback-rounds-ev1')).toHaveTextContent('Nog 1 van 2 feedbackrondes');
    expect(screen.getByText('Feedback op: Tussenproduct 1')).toBeInTheDocument();
    expect(screen.getByTestId('feedback-item-p1')).toHaveTextContent('Onderbouwing mist.');
    expect(screen.getByTestId('feedback-item-p1')).toHaveTextContent('6,5');
  });

  it('alle rondes op: geen inleverknop meer', async () => {
    setup([evaluator({ remaining: 0, used: 2, canSubmit: false })]);
    expect(await screen.findByTestId('text-feedback-used-up-ev1')).toBeInTheDocument();
    expect(screen.queryByTestId('input-feedback-upload-ev1')).toBeNull();
  });

  it('inleveren stuurt het bestand naar de beoordelaar en laadt opnieuw', async () => {
    const fetchMock = setup([evaluator({ items: [], used: 0, remaining: 2 })], { review: { id: 'r2' } });
    const input = await screen.findByTestId('input-feedback-upload-ev1');
    fireEvent.change(input, { target: { files: [new File(['tekst'], 'eindversie.docx')] } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/personas/ev1/feedback') && (i as RequestInit)?.method === 'POST')).toBe(true));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, i]) => !(i as RequestInit)?.method).length).toBeGreaterThanOrEqual(2));
  });

  it('zonder beoordelaars niets tonen', async () => {
    setup([]);
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByTestId('panel-product-feedback')).toBeNull();
  });
});
