// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildPayload, metaOf, metaFromStored, hasInlineFile, searchExtra, isSupportedFile, isImageFile,
  imagesFromClipboard, pastedImageName, type PendingAttachment,
} from '../chatAttachments';
import { stashStudiecafeHandoff } from '../studiecafeHandoff';

const IMG = 'data:image/png;base64,iVBORw0KGgo=';
const image: PendingAttachment = { id: '1', kind: 'image', name: 'scherm.png', mime: 'image/png', size: 2048, dataUrl: IMG };
const file: PendingAttachment = { id: '2', kind: 'file', name: 'tekst.pdf', size: 9000, pages: 3, text: 'Inhoud van het bestand', truncated: false };
const scan: PendingAttachment = { id: '3', kind: 'file', name: 'scan.pdf', pages: 4, scanned: true, scanImages: [IMG, IMG] };

describe('bijlagen in het verzoek', () => {
  it('afbeeldingen gaan één keer mee; bestandstekst bij elke beurt (alleen de eerste keer "nieuw")', () => {
    expect(buildPayload([image, file], [])).toEqual([
      { kind: 'image', name: 'scherm.png', dataUrl: IMG },
      { kind: 'file', name: 'tekst.pdf', text: 'Inhoud van het bestand', pages: 3, truncated: false, isNew: true },
    ]);
    // Volgende beurt: geen nieuwe bijlagen, het bestand gaat als tekst mee.
    expect(buildPayload([], [file])).toEqual([{ kind: 'file', name: 'tekst.pdf', text: 'Inhoud van het bestand', pages: 3, truncated: false }]);
  });
  it('een gescande PDF gaat als pagina-afbeeldingen mee', () => {
    expect(buildPayload([scan], [])).toEqual([
      { kind: 'image', name: 'scan.pdf p1', dataUrl: IMG, scanOf: 'scan.pdf' },
      { kind: 'image', name: 'scan.pdf p2', dataUrl: IMG, scanOf: 'scan.pdf' },
    ]);
  });
  it('zoekt in het cursusmateriaal ook op bestandstekst en de eerdere beschrijving', () => {
    expect(searchExtra([file], 'Dit zie ik: een grafiek')).toBe('Inhoud van het bestand\nDit zie ik: een grafiek');
    expect(searchExtra([image])).toBe('');
  });
});

describe('wat er bewaard wordt', () => {
  it('bij het bericht alleen een label, nooit de inhoud', () => {
    for (const a of [image, file, scan]) {
      const m = metaOf(a);
      expect(hasInlineFile(m)).toBe(false);
      expect(JSON.stringify(m)).not.toContain('Inhoud van het bestand');
    }
    expect(metaOf(image)).toEqual({ kind: 'image', name: 'scherm.png', mime: 'image/png', size: 2048 });
  });
  it('labels uit de database; rommel wordt genegeerd', () => {
    expect(metaFromStored({ attachments: [{ kind: 'image', name: 'a.png' }, { kind: 'x' }, null, { kind: 'file', name: 'b.pdf', pages: 2 }] }))
      .toEqual([{ kind: 'image', name: 'a.png' }, { kind: 'file', name: 'b.pdf', pages: 2 }]);
    expect(metaFromStored(null)).toEqual([]);
    expect(metaFromStored({ chunks: [] })).toEqual([]);
  });
  it('herkent ingebedde bestanden', () => {
    expect(hasInlineFile(`zie ${IMG}`)).toBe(true);
    expect(hasInlineFile({ a: 'data:application/pdf;base64,JVBER' })).toBe(true);
    expect(hasInlineFile('gewone tekst over data: en base64')).toBe(false);
  });
});

describe('Studiecafé', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });
  it('een overdracht met een ingebed bestand wordt nooit klaargezet', () => {
    stashStudiecafeHandoff({
      v: 1, courseId: 'c', category: 'check-llm', mode: 'thread',
      attachment: { type: 'chat_excerpt', content: `antwoord ${IMG}`, sources: [], meta: { module: 'chat', capturedAt: 'nu' } },
    } as never);
    expect(sessionStorage.length).toBe(0);
    stashStudiecafeHandoff({
      v: 1, courseId: 'c', category: 'check-llm', mode: 'thread',
      attachment: { type: 'chat_excerpt', content: 'gewoon antwoord', sources: [], meta: { module: 'chat', capturedAt: 'nu' } },
    } as never);
    expect(sessionStorage.length).toBe(1);
  });
});

describe('soorten en plakken', () => {
  it('welke bestanden mogen', () => {
    expect(isImageFile({ type: 'image/png', name: 'x' })).toBe(true);
    expect(isSupportedFile({ name: 'verslag.docx' })).toBe(true);
    expect(isSupportedFile({ name: 'programma.exe' })).toBe(false);
    expect(isSupportedFile({ type: 'image/svg+xml', name: 'logo.svg' })).toBe(false);
  });
  it('alleen afbeeldingen van het klembord worden bijlagen', () => {
    const png = new File(['x'], 'image.png', { type: 'image/png' });
    const data = {
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => png },
      ],
    } as unknown as DataTransfer;
    expect(imagesFromClipboard(data)).toEqual([png]);
    expect(imagesFromClipboard(null)).toEqual([]);
    expect(pastedImageName(0, new Date(2026, 9, 16, 9, 5))).toBe('schermafbeelding-0905.png');
  });
});
