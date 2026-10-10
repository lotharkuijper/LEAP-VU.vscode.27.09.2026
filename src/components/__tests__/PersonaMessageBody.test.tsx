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

  // Regressie 2026-10-10: een klik op de voetnoot deed niets of opende LEAP
  // opnieuw in een nieuw venster. Nu opent het document op de juiste plek.
  it('klik op het cijfer opent het document op de pagina van de bron', () => {
    const onOpen = vi.fn();
    render(
      <LanguageProvider>
        <PersonaMessageBody messageId="m3" content="Zie de definitie [1]." sources={SOURCES} onOpenSource={onOpen} />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByTestId('citation-1'));
    expect(onOpen).toHaveBeenCalledWith({ documentId: 'd1', title: 'Hoorcollege 3 – Confounding', page: 12 });
  });

  it('Markdown-voetnoten ([^1]) worden gewone bronverwijzingen; het voetnotenblok verdwijnt', () => {
    const onOpen = vi.fn();
    render(
      <LanguageProvider>
        <PersonaMessageBody
          messageId="m4"
          content={'Confounding vertekent het verband.[^1] Zie ook de werkgroep.[^2]\n\n[^1]: Hoorcollege 3, p. 12\n[^2]: Werkgroep 2'}
          sources={SOURCES}
          onOpenSource={onOpen}
        />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('citation-1')).toBeTruthy();
    expect(screen.getByTestId('citation-2')).toBeTruthy();
    expect(document.body.textContent).not.toContain('[^');
    expect(document.querySelector('a[href^="#user-content-fn"]')).toBeNull();
    fireEvent.click(screen.getByTestId('citation-2'));
    expect(onOpen).toHaveBeenCalledWith({ documentId: 'd2', title: 'Werkgroep 2', page: 4 });
  });

  it('links in een antwoord: intern niet in een nieuw tabblad, document-link opent de viewer', () => {
    const onOpen = vi.fn();
    render(
      <LanguageProvider>
        <PersonaMessageBody
          messageId="m5"
          content={'Lees [het college](/api/rag/documents/11111111-1111-1111-1111-111111111111/download), [verderop](#uitleg) of [de RIVM-site](https://www.rivm.nl).'}
          sources={[{ index: 1, title: 'College', documentId: '11111111-1111-1111-1111-111111111111', pageStart: 3 }]}
          onOpenSource={onOpen}
        />
      </LanguageProvider>,
    );
    expect(screen.getByText('verderop').getAttribute('target')).toBeNull();
    expect(screen.getByText('de RIVM-site').getAttribute('target')).toBe('_blank');
    fireEvent.click(screen.getByText('het college'));
    expect(onOpen).toHaveBeenCalledWith({ documentId: '11111111-1111-1111-1111-111111111111', title: 'College', page: 3 });
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
