// Documentviewer: zoomstappen en "Vraag in de chat" (tekst uit een document als
// citaat in de chatinvoer). De echte weergave (tekstlaag, volledig scherm) wordt
// in een browser gecontroleerd: node --env-file=.env scripts/check-document-viewer.mjs
import { describe, it, expect } from 'vitest';
import { nextZoom, ZOOM_STEPS } from '../viewerZoom';
import { appendQuote } from '../chatQuote';

describe('zoomen in de documentviewer', () => {
  it('stapt omhoog en omlaag en blijft binnen de grenzen', () => {
    expect(nextZoom(1, 1)).toBe(1.25);
    expect(nextZoom(1, -1)).toBe(0.75);
    expect(nextZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1], 1)).toBe(3);
    expect(nextZoom(ZOOM_STEPS[0], -1)).toBe(0.5);
    expect(nextZoom(1.1, 1)).toBe(1.25);
  });
});

describe('citaat uit een document in de chat', () => {
  it('zet de selectie tussen aanhalingstekens met ruimte voor de vraag', () => {
    expect(appendQuote('', '  Dit is\n een  zin. ')).toBe('“Dit is een zin.”\n\n');
  });
  it('laat wat er al in de invoer stond staan', () => {
    expect(appendQuote('Mijn vraag:', 'tekst')).toBe('Mijn vraag:\n\n“tekst”\n\n');
  });
  it('lege selectie verandert niets', () => {
    expect(appendQuote('x', '   ')).toBe('x');
  });
});
