// Tekst uit kantoorbestanden (parseOfficeAsync) is leesbare platte tekst.
// Regressie 2026-10-30: officeparser 8 heeft geen ast.toText() meer; daardoor
// werden tabellen en dia's als ruwe AST-JSON opgeslagen ({"type":"paragraph",…})
// in chatbijlagen, de terugvalroute bij inlezen en de tekstweergave.
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseOfficeAsync } from '../lib/uploads.js';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const cell = (t) => `<w:tc>${para(t)}</w:tc>`;

function docxWithTable() {
  const body = para('Inleiding bij het stappenplan')
    + `<w:tbl><w:tr>${cell('Wat je wilt')}${cell('Hoe dat heet')}</w:tr>`
    + `<w:tr>${cell('Een expert raadplegen')}${cell('Een persona met de rol Begeleider')}</w:tr></w:tbl>`
    + para('Afsluitende alinea');
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`),
  }));
}

function pptxOneSlide() {
  const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`),
    'ppt/presentation.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`),
    'ppt/slides/slide1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><p:sld ${P}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Fotosynthese in het kort</a:t></a:r></a:p><a:p><a:r><a:t>Licht wordt chemische energie</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
  }));
}

const looksLikeAst = (s) => /\{"type"|"children"\s*:|\[object Object\]/.test(s);

describe('parseOfficeAsync geeft platte tekst', () => {
  it('Word met tabel: alle tekst, geen AST-JSON', async () => {
    const text = await parseOfficeAsync(docxWithTable());
    expect(typeof text).toBe('string');
    expect(looksLikeAst(text)).toBe(false);
    for (const t of ['Inleiding bij het stappenplan', 'Wat je wilt', 'Een persona met de rol Begeleider', 'Afsluitende alinea']) {
      expect(text).toContain(t);
    }
    // Plat: geen opgevulde rasters met lange rijen spaties.
    expect(text).not.toMatch(/ {3,}/);
  });

  it('PowerPoint: dia-tekst, geen AST-JSON', async () => {
    const text = await parseOfficeAsync(pptxOneSlide());
    expect(looksLikeAst(text)).toBe(false);
    expect(text).toContain('Fotosynthese in het kort');
    expect(text).toContain('Licht wordt chemische energie');
  });
});
