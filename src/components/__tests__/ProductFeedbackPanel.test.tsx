// @vitest-environment jsdom
// Feedback op het product (besluit 2026-11-26): het venster achter de knop
// "Feedback op ons product" (mode submit) en de rechterkolom om terug te lezen
// (mode history). Plus het venster "Feedback op ons proces".
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../i18n';
import { ProductFeedbackPanel, type FeedbackGiver } from '../ProductFeedbackPanel';
import { ProcessFeedbackDialog } from '../projects/GroupFeedbackDialogs';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const giver = (over: Record<string, unknown> = {}) => ({
  personaId: 'ev1', name: 'Dr. Streng', avatarEmoji: null, avatar: null, deliverableLabel: 'Tussenproduct 1',
  product: true, maxReviews: 2, used: 1, remaining: 1, canSubmit: true,
  process: { maxReviews: 3, used: 0, remaining: 3, canSubmit: true },
  items: [{ productId: 'p1', filename: 'opzet.docx', createdAt: '2026-09-29T10:00:00Z', badge: 'zilver',
    review: { id: 'r1', verdict: 'conditional', grade: 6.5, reasoning: 'Onderbouwing mist.', feed_forward: 'Voeg bronnen toe.', created_at: '2026-09-29T10:00:00Z' } }],
  ...over,
}) as unknown as FeedbackGiver;

function setup(givers: FeedbackGiver[], mode: 'submit' | 'history', postResponse?: unknown) {
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => postResponse } as unknown as Response));
  vi.stubGlobal('fetch', fetchMock);
  const reload = vi.fn();
  render(<LanguageProvider><ProductFeedbackPanel projectId="pr" groupId="g" token="t" givers={givers} reload={reload} mode={mode} /></LanguageProvider>);
  return { fetchMock, reload };
}

describe('Feedback op ons product: inleveren (mode submit)', () => {
  it('toont waarover, de resterende rondes en een knop om een bestand te kiezen', async () => {
    setup([giver()], 'submit');
    expect(await screen.findByTestId('text-feedback-rounds-ev1')).toHaveTextContent('Nog 1 van 2 feedbackrondes');
    expect(screen.getByText('Feedback op: Tussenproduct 1')).toBeInTheDocument();
    expect(screen.getByTestId('input-feedback-upload-ev1')).toBeInTheDocument();
    expect(screen.queryByTestId('feedback-item-p1')).toBeNull();
  });

  it('alle rondes op: geen inleverknop meer', async () => {
    setup([giver({ remaining: 0, used: 2, canSubmit: false })], 'submit');
    expect(await screen.findByTestId('text-feedback-used-up-ev1')).toBeInTheDocument();
    expect(screen.queryByTestId('input-feedback-upload-ev1')).toBeNull();
  });

  it('een feedbackgever zonder productfeedback staat er niet in', () => {
    setup([giver({ product: false })], 'submit');
    expect(screen.queryByTestId('feedback-evaluator-ev1')).toBeNull();
  });

  it('inleveren stuurt het bestand naar de feedbackgever en laadt opnieuw', async () => {
    const { fetchMock, reload } = setup([giver({ items: [], used: 0, remaining: 2 })], 'submit', { review: { id: 'r2' } });
    fireEvent.change(screen.getByTestId('input-feedback-upload-ev1'), { target: { files: [new File(['tekst'], 'versie.docx')] } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/personas/ev1/feedback') && (i as RequestInit)?.method === 'POST')).toBe(true));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });
});

describe('Feedback op ons product: terugkijken (mode history)', () => {
  it('toont eerdere feedback, zonder inleverknop', () => {
    setup([giver()], 'history');
    expect(screen.getByTestId('feedback-item-p1')).toHaveTextContent('Onderbouwing mist.');
    expect(screen.getByTestId('feedback-item-p1')).toHaveTextContent('Voeg bronnen toe.');
    expect(screen.queryByTestId('input-feedback-upload-ev1')).toBeNull();
  });

  it('zuiver formatief: nooit een cijfer, oordeel of badge, ook niet als oude gegevens die nog hebben', () => {
    setup([giver()], 'history');
    const item = screen.getByTestId('feedback-item-p1');
    expect(item).not.toHaveTextContent('6,5');
    expect(item).not.toHaveTextContent(/Onder voorwaarden|Zilver/);
    expect(item.textContent).not.toContain('🥈');
  });

  it('nog geen feedback: niets tonen', () => {
    setup([giver({ items: [] })], 'history');
    expect(screen.queryByTestId('panel-product-feedback')).toBeNull();
  });
});

describe('Feedback op ons proces', () => {
  function renderProcess(givers: FeedbackGiver[], response: { ok: boolean; body: unknown }) {
    try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: response.ok, json: async () => response.body } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    render(<LanguageProvider><ProcessFeedbackDialog groupId="g" token="t" givers={givers} onClose={() => {}} onDone={onDone} /></LanguageProvider>);
    return { fetchMock, onDone };
  }

  it('zegt wat de feedbackgever leest, en dat de groepschat er niet bij is', () => {
    renderProcess([giver()], { ok: true, body: {} });
    const dialog = screen.getByTestId('dialog-process-feedback');
    expect(dialog).toHaveTextContent('gesprekken met de personages');
    expect(dialog).toHaveTextContent('groepschat leest de feedbackgever niet');
    expect(screen.getByTestId('text-process-rounds-ev1')).toHaveTextContent('Nog 3 van 3 feedbackrondes');
  });

  it('vraagt feedback zonder upload en meldt het resultaat', async () => {
    const { fetchMock, onDone } = renderProcess([giver()], { ok: true, body: { ok: true, results: [{ ok: true }] } });
    fireEvent.click(screen.getByTestId('button-ask-process-feedback'));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/projects/groups/g/evaluate');
    expect(init.body).not.toBeInstanceOf(FormData);
  });

  it('nog niets gedaan: duidelijke melding, geen ronde gebruikt', async () => {
    renderProcess([giver()], { ok: false, body: { code: 'nothingYet', error: 'x' } });
    fireEvent.click(screen.getByTestId('button-ask-process-feedback'));
    expect(await screen.findByTestId('text-process-error')).toHaveTextContent('Er is geen ronde gebruikt');
  });

  it('rondes op: de knop staat uit', () => {
    renderProcess([giver({ process: { maxReviews: 1, used: 1, remaining: 0, canSubmit: false } })], { ok: true, body: {} });
    expect(screen.getByTestId('button-ask-process-feedback')).toBeDisabled();
  });
});
