// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../i18n';
import { ConceptPicker } from '../ConceptPicker';

const concepts = [
  { id: 'a', name: 'odds ratio', difficulty: 'hard', review_status: 'approved', definition: 'Verhouding van twee odds.' },
  { id: 'b', name: 'bias', difficulty: 'hard', review_status: 'needs_review' },
  { id: 'c', name: 'mediaan', difficulty: 'easy', review_status: 'rejected' },
];
const docs = { a: 3, b: 2, c: 1 };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* noop */ }
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ updated: 1 }) }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderPicker(onChanged = vi.fn()) {
  render(
    <LanguageProvider>
      <ConceptPicker courseId="course-1" token="tok" concepts={concepts} moduleCounts={docs} onChanged={onChanged} onOpenDetails={vi.fn()} />
    </LanguageProvider>,
  );
  return onChanged;
}

const bodies = () => fetchMock.mock.calls
  .filter(([url]) => String(url) === '/api/admin/concepts/visibility')
  .map(([, init]) => JSON.parse((init as RequestInit).body as string));

describe('ConceptPicker', () => {
  it('overzicht bovenaan met het totaal op de knop; lijst pas na openen', () => {
    renderPicker();
    expect(screen.getByTestId('text-concept-summary').textContent).toMatch(/1 van 3 zichtbaar/);
    expect(screen.getByTestId('button-open-concept-picker').textContent).toMatch(/Begrippen kiezen \(3\)/);
    expect(screen.getByTestId('text-concept-review-hint')).toBeTruthy();
    expect(screen.queryByTestId('list-concept-picker')).toBeNull();
  });

  it('de schakelaar toont de huidige stand en slaat alleen dat ene begrip op', async () => {
    const onChanged = renderPicker();
    fireEvent.click(screen.getByTestId('button-open-concept-picker'));
    expect(screen.getByTestId('switch-concept-a').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('switch-concept-b').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByTestId('switch-concept-b'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(bodies()).toEqual([{ courseId: 'course-1', ids: ['b'], visible: true }]);
  });

  it('"alle verbergen" geldt alleen voor wat in beeld is', async () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('button-open-concept-picker'));
    fireEvent.click(screen.getByTestId('chip-status-review'));
    expect(screen.queryByTestId('row-concept-a')).toBeNull();
    fireEvent.click(screen.getByTestId('button-bulk-hidden'));
    await waitFor(() => expect(bodies()).toHaveLength(1));
    expect(bodies()[0]).toEqual({ courseId: 'course-1', ids: ['b'], visible: false });
  });

  it('"te beoordelen" tonen opent de lijst met dat filter', () => {
    renderPicker();
    fireEvent.click(screen.getByText('Toon ze'));
    expect(screen.getByTestId('row-concept-b')).toBeTruthy();
    expect(screen.queryByTestId('row-concept-c')).toBeNull();
  });
});
