// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../../lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}));

import { LanguageProvider } from '../../i18n';
import { PersonaMessageBody, personaSourcesFrom } from '../PersonaMessageBody';

afterEach(cleanup);

// Regressie 2026-09-27: persona-antwoorden toonden "**score**" en "^1" als
// platte tekst, zonder verwijzing naar het cursusmateriaal.
const SOURCES = [
  { index: 1, title: 'Hoorcollege 3 – Confounding', documentId: 'd1', similarity: 0.8, pageStart: 12, pageEnd: 12 },
  { index: 2, title: 'Werkgroep 2', documentId: 'd2', similarity: 0.7, slideStart: 4, slideEnd: 4 },
];

describe('personaSourcesFrom', () => {
  it('neemt nieuwe bronnen over en slaat het oude formaat (zonder titel/nummer) over', () => {
    expect(personaSourcesFrom([SOURCES[1], SOURCES[0]]).map(s => s.index)).toEqual([1, 2]);
    expect(personaSourcesFrom([{ documentId: 'd1', similarity: 0.5, excerpt: 'x' }])).toEqual([]);
    expect(personaSourcesFrom(null)).toEqual([]);
  });
});

describe('PersonaMessageBody', () => {
  it('toont opmaak, klikbare [n]-verwijzingen en een bronnenlijst die de bron opent', () => {
    const onOpen = vi.fn();
    render(
      <LanguageProvider>
        <PersonaMessageBody
          messageId="m1"
          content={'Stress is in jullie data een **score** [1]. Leeftijd kan een effectmodificator zijn [2].'}
          sources={SOURCES}
          onOpenSource={onOpen}
        />
      </LanguageProvider>,
    );
    // Markdown: vet, geen letterlijke sterretjes.
    expect(screen.getByText('score').tagName).toBe('STRONG');
    expect(document.body.textContent).not.toContain('**');
    // [1] en [2] worden verwijzingen, geen platte tekst.
    expect(screen.getByTestId('citation-1')).toBeTruthy();
    expect(screen.getByTestId('citation-2')).toBeTruthy();
    expect(document.body.textContent).not.toContain('[1]');
    // Klik op een verwijzing klapt de bronnenlijst open.
    fireEvent.click(screen.getByTestId('citation-1'));
    expect(document.body.textContent).toMatch(/Hoorcollege 3 – Confounding/);
    // Een bron openen gaat met de juiste pagina naar de viewer.
    fireEvent.click(screen.getByText('Hoorcollege 3 – Confounding'));
    expect(onOpen).toHaveBeenCalledWith({ documentId: 'd1', title: 'Hoorcollege 3 – Confounding', page: 12 });
  });

  it('zonder bronnen: alleen de opgemaakte tekst, geen bronnenlijst', () => {
    render(
      <LanguageProvider>
        <PersonaMessageBody messageId="m2" content="Goede vraag." sources={[]} onOpenSource={() => {}} />
      </LanguageProvider>,
    );
    expect(document.body.textContent).toBe('Goede vraag.');
  });
});
