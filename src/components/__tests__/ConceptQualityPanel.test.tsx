// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../i18n';
import { ConceptQualityPanel } from '../ConceptQualityPanel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);

function setup(suggestResponse: unknown) {
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
  const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
    if (url.includes('/coverage')) return json({ documents: [] });
    if (url.includes('/merge-suggestions')) return json(suggestResponse);
    if (url.includes('/merge')) return json({ merged: 1 });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const onChanged = vi.fn();
  render(<LanguageProvider><ConceptQualityPanel courseId="c1" token="t" onChanged={onChanged} /></LanguageProvider>);
  return { fetchMock, onChanged };
}

describe('ConceptQualityPanel — dubbelingen', () => {
  it('zekere dubbelingen die de server meteen samenvoegde: melding én de lijst ververst', async () => {
    const { onChanged } = setup({ suggestions: [], autoMerged: 3 });
    fireEvent.click(screen.getByTestId('button-find-merge-suggestions'));
    await waitFor(() => expect(screen.getByTestId('text-auto-merged')).toHaveTextContent('3'));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('moduleconcept dat al als cursusconcept bestaat krijgt een eigen tekst; samenvoegen ververst de lijst', async () => {
    const { onChanged, fetchMock } = setup({
      autoMerged: 0,
      suggestions: [{
        kind: 'crossClass',
        keep: { id: 'bi', name: 'betrouwbaarheidsinterval', reviewStatus: 'approved', cls: 'course' },
        others: [{ id: 'bi95', name: '95% betrouwbaarheidsinterval', reviewStatus: 'approved', cls: 'module' }],
      }],
    });
    fireEvent.click(screen.getByTestId('button-find-merge-suggestions'));
    const text = await screen.findByTestId('text-merge-suggestion-bi');
    expect(text).toHaveTextContent('Moduleconcept “95% betrouwbaarheidsinterval” staat ook als cursusconcept “betrouwbaarheidsinterval”');
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('button-merge-bi'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const mergeCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/admin/concepts/merge'));
    expect(JSON.parse(String(mergeCall?.[1]?.body))).toEqual({ courseId: 'c1', keepId: 'bi', dupIds: ['bi95'] });
  });
});
