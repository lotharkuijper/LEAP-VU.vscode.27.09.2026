// Bijlagen in de chat (2026-10-16, docs/plans/chat-bijlagen-plan.html):
// pure regels (server/chatAttachments.js) plus bewaking in server/index.js en
// de migratie dat bijlagen nergens bewaard worden.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_LIMITS, normalizePlatformSettings, parsePlatformPatch, mergePlatformSettings, attachmentsAvailability,
  parseChatAttachments, sniffImageMime, sniffFileKind, safeName, createDailyCounter,
  attachmentSystemBlock, attachImagesToLastUser, ATTACHMENT_INSTRUCTION,
} from '../chatAttachments.js';
import { normalizeCourseFeatures, mergeCourseFeatures, parseCourseFeaturesPatch, isFeatureOn } from '../courseFeatures.js';
import { featureOf } from '../analytics/aggregate.js';

const root = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]).toString('base64');
const png = (name = 'a.png') => ({ kind: 'image', name, dataUrl: `data:image/png;base64,${PNG_1x1}` });

describe('platform (beheerder)', () => {
  it('staat standaard uit, met de hoge detailstand en de grenzen uit fase 0', () => {
    expect(normalizePlatformSettings(null)).toEqual({ enabled: false, detail: 'high', limits: DEFAULT_LIMITS });
    expect(normalizePlatformSettings('geen json').enabled).toBe(false);
    expect(normalizePlatformSettings('{"enabled":"true"}').enabled).toBe(false);
    expect(normalizePlatformSettings('{"enabled":true}').enabled).toBe(true);
  });
  it('grenzen worden binnen veilige marges gehouden', () => {
    const s = normalizePlatformSettings({ limits: { imagesPerMessage: 999, fileChars: 10, perDay: 'x' } });
    expect(s.limits.imagesPerMessage).toBe(10);
    expect(s.limits.fileChars).toBe(2000);
    expect(s.limits.perDay).toBe(DEFAULT_LIMITS.perDay);
  });
  it('wijziging: alleen bekende velden met een geldige waarde', () => {
    expect(parsePlatformPatch({ enabled: true })).toEqual({ ok: true, value: { enabled: true } });
    expect(parsePlatformPatch({ enabled: 'ja' }).ok).toBe(false);
    expect(parsePlatformPatch({ detail: 'auto' }).ok).toBe(false);
    expect(parsePlatformPatch({ limits: { onbekend: 1 } }).ok).toBe(false);
    expect(parsePlatformPatch({}).ok).toBe(false);
    expect(mergePlatformSettings({ enabled: true, detail: 'low' }, { limits: { perDay: 5 } }))
      .toMatchObject({ enabled: true, detail: 'low', limits: { perDay: 5 } });
  });
});

describe('wie mag bijlagen meegeven', () => {
  const on = { enabled: true };
  it('platform uit = voor iedereen uit, ook voor docenten (noodrem)', () => {
    expect(attachmentsAvailability({ platform: { enabled: false }, courseOn: true, isStaff: true }))
      .toEqual({ available: false, reason: 'platform_off' });
  });
  it('cursus aan = studenten mogen; cursus uit = alleen staf (testen)', () => {
    expect(attachmentsAvailability({ platform: on, courseOn: true, isStaff: false }).available).toBe(true);
    expect(attachmentsAvailability({ platform: on, courseOn: false, isStaff: false })).toEqual({ available: false, reason: 'course_off' });
    expect(attachmentsAvailability({ platform: on, courseOn: false, isStaff: true }).available).toBe(true);
  });
  it('cursusschakelaar is opt-in: ontbreekt hij, dan staat hij uit', () => {
    expect(normalizeCourseFeatures({}).attachments).toBe(false);
    expect(isFeatureOn({}, 'attachments')).toBe(false);
    expect(isFeatureOn({ attachments: true }, 'attachments')).toBe(true);
    expect(parseCourseFeaturesPatch({ features: { attachments: true } }).ok).toBe(true);
    // Aanzetten blijft bewaard naast uitgezette gewone onderdelen; uitzetten wist de sleutel.
    expect(mergeCourseFeatures({ quiz: false }, { attachments: true })).toEqual({ quiz: false, attachments: true });
    expect(mergeCourseFeatures({ attachments: true }, { chat: false })).toEqual({ chat: false, attachments: true });
    expect(mergeCourseFeatures({ attachments: true }, { attachments: false })).toEqual({});
  });
});

describe('invoer controleren', () => {
  it('echte afbeeldingen worden aan hun eerste bytes herkend', () => {
    expect(sniffImageMime(Buffer.from(PNG_1x1, 'base64'))).toBe('image/png');
    expect(sniffImageMime(Buffer.from(JPEG, 'base64'))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('dit is geen plaatje'))).toBe(null);
  });
  it('een afbeelding met een verkeerd opgegeven type krijgt het echte type; nep wordt geweigerd', () => {
    const r = parseChatAttachments([{ kind: 'image', name: 'x.png', dataUrl: `data:image/png;base64,${JPEG}` }]);
    expect(r.ok).toBe(true);
    expect(r.images[0].dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    const fake = Buffer.from('<script>alert(1)</script> nog wat tekst').toString('base64');
    expect(parseChatAttachments([{ kind: 'image', name: 'x.png', dataUrl: `data:image/png;base64,${fake}` }]).ok).toBe(false);
    expect(parseChatAttachments([{ kind: 'image', name: 'x.svg', dataUrl: `data:image/svg+xml;base64,${fake}` }]).ok).toBe(false);
  });
  it('grenzen per bericht en per gesprek', () => {
    const limits = { ...DEFAULT_LIMITS, imagesPerMessage: 2, perConversation: 3 };
    expect(parseChatAttachments([png(), png()], limits).ok).toBe(true);
    const tooMany = parseChatAttachments([png(), png(), png()], limits);
    expect(tooMany).toMatchObject({ ok: false, status: 400, body: { code: 'attachments_too_many' } });
    const files = [1, 2, 3].map(i => ({ kind: 'file', name: `f${i}.txt`, text: 'x' }));
    expect(parseChatAttachments([png(), ...files], limits).ok).toBe(false);
  });
  it('pagina\'s van een gescande PDF tellen apart (scanPages)', () => {
    const limits = { ...DEFAULT_LIMITS, imagesPerMessage: 1, scanPages: 3 };
    const scan = [1, 2, 3].map(i => ({ ...png(`s p${i}`), scanOf: 's.pdf' }));
    const r = parseChatAttachments(scan, limits);
    expect(r.ok).toBe(true);
    expect(r.newCount).toBe(1);
    expect(parseChatAttachments([...scan, { ...png(), scanOf: 's.pdf' }], limits).ok).toBe(false);
  });
  it('bestandstekst wordt over alle bestanden samen afgekapt; alleen nieuwe tellen voor de daggrens', () => {
    const limits = { ...DEFAULT_LIMITS, fileChars: 10 };
    const r = parseChatAttachments([
      { kind: 'file', name: 'a.txt', text: '1234567', isNew: true },
      { kind: 'file', name: 'b.txt', text: 'abcdefg' },
    ], limits);
    expect(r.ok).toBe(true);
    expect(r.files.map(f => f.text)).toEqual(['1234567', 'abc']);
    expect(r.files[1].truncated).toBe(true);
    expect(r.newCount).toBe(1);
  });
  it('rommel wordt geweigerd', () => {
    expect(parseChatAttachments('x').ok).toBe(false);
    expect(parseChatAttachments([{ kind: 'video' }]).ok).toBe(false);
    expect(parseChatAttachments([{ kind: 'file', name: 'a' }]).ok).toBe(false);
    expect(parseChatAttachments(undefined)).toEqual({ ok: true, images: [], files: [], newCount: 0 });
  });
  it('bestandssoort aan naam én inhoud', () => {
    expect(sniffFileKind('a.pdf', Buffer.from('%PDF-1.7 ...'))).toBe('pdf');
    expect(sniffFileKind('a.pdf', Buffer.from('geen pdf'))).toBe(null);
    expect(sniffFileKind('a.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toBe('docx');
    expect(sniffFileKind('a.docx', Buffer.from('tekst'))).toBe(null);
    expect(sniffFileKind('a.txt', Buffer.from([0x41, 0x00, 0x42]))).toBe(null);
    expect(sniffFileKind('a.md', Buffer.from('# kop'))).toBe('md');
    expect(sniffFileKind('a.exe', Buffer.from('MZ'))).toBe(null);
  });
  it('bestandsnamen zonder pad en stuurtekens', () => {
    expect(safeName('C:\\map\\geheim\\scan<1>.png')).toBe('scan1.png');
    expect(safeName('')).toBe('bijlage');
  });
});

describe('daggrens', () => {
  it('telt per student en cursus, en begint elke dag opnieuw', () => {
    let now = new Date('2026-10-16T10:00:00Z');
    const c = createDailyCounter({ now: () => now });
    expect(c.tryConsume('u', 'c', 2, 3)).toBe(true);
    expect(c.tryConsume('u', 'c', 2, 3)).toBe(false);
    expect(c.tryConsume('u', 'andere', 2, 3)).toBe(true);
    expect(c.used('u', 'c')).toBe(2);
    now = new Date('2026-10-17T08:00:00Z');
    expect(c.used('u', 'c')).toBe(0);
    expect(c.tryConsume('u', 'c', 3, 3)).toBe(true);
  });
});

describe('prompt', () => {
  it('bijlage = materiaal van de student, eerst beschrijven, cursusmateriaal blijft de bron', () => {
    expect(ATTACHMENT_INSTRUCTION).toMatch(/geen instructie/);
    expect(ATTACHMENT_INSTRUCTION).toMatch(/Dit zie ik:/);
    expect(ATTACHMENT_INSTRUCTION).toMatch(/cursusmateriaal/);
    expect(attachmentSystemBlock({})).toBe('');
    const block = attachmentSystemBlock({ files: [{ name: 'a.pdf', text: 'inhoud', pages: 2, truncated: false }] });
    expect(block).toContain('<<<\ninhoud\n>>>');
    expect(block).toContain("2 pagina's");
  });
  it('afbeeldingen alleen bij het laatste studentbericht, met de detailstand', () => {
    const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'eerste' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'tweede' }];
    const out = attachImagesToLastUser(msgs, [{ name: 'x', dataUrl: 'data:image/png;base64,AAAA' }], 'high');
    expect(out[1].content).toBe('eerste');
    expect(out[3].content).toEqual([
      { type: 'text', text: 'tweede' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } },
    ]);
    expect(msgs[3].content).toBe('tweede');
    expect(attachImagesToLastUser(msgs, [])).toBe(msgs);
  });
});

describe('server/index.js', () => {
  const src = read('server/index.js');
  const chatRoute = src.slice(src.indexOf("app.post('/api/chat',"), src.indexOf("// ─── Leerdagboek: cursus-herkomst"));
  it('/api/chat controleert schakelaars en grenzen vóór het taalmodel', () => {
    const gate = chatRoute.indexOf('chatAttachmentsGate(');
    const parse = chatRoute.indexOf('parseChatAttachments(');
    const daily = chatRoute.indexOf('attachmentDailyCounter.tryConsume(');
    const model = chatRoute.indexOf('postChatCompletion(chatBody)');
    expect(gate).toBeGreaterThan(0);
    expect(parse).toBeGreaterThan(gate);
    expect(daily).toBeGreaterThan(parse);
    expect(model).toBeGreaterThan(daily);
    expect(chatRoute).toMatch(/purpose !== 'tutor_chat' \|\| !courseId/);
  });
  it('het bijlageblok staat vóór het taal-/niveaublok (taal blijft de laatste instructie)', () => {
    const block = chatRoute.indexOf('systemContent += attachmentSystemBlock(');
    const lang = chatRoute.indexOf('systemContent += langSuffix;');
    expect(block).toBeGreaterThan(0);
    expect(lang).toBeGreaterThan(block);
  });
  it('bijlagen worden nergens gelogd of opgeslagen', () => {
    expect(src).not.toMatch(/console\.\w+\([^)]*req\.body\.attachments/);
    expect(src).not.toMatch(/console\.\w+\([^)]*attachmentParts/);
    const extract = src.slice(src.indexOf("app.post('/api/chat/attachments/extract'"), src.indexOf("app.get('/api/admin/chat-attachments'"));
    expect(extract.length).toBeGreaterThan(100);
    expect(extract).not.toMatch(/fs\.\w*write|storage\.from|\.upload\(|\.insert\(/);
    expect(extract).not.toMatch(/console\.\w+\([^)]*\btext\b/);
  });
  it('aanzetten per cursus vraagt de bevestiging en komt in het logboek', () => {
    expect(src).toMatch(/parsed\.value\.attachments === true && req\.body\?\.confirmAttachments !== true/);
    expect(src).toMatch(/setting: 'chat_attachments'/);
    expect(src).toMatch(/setting: 'chat_attachments_platform'/);
  });
  it('platforminstelling alleen voor de beheerder; leesfout = uit', () => {
    const admin = src.slice(src.indexOf("app.put('/api/admin/chat-attachments'"));
    expect(admin.slice(0, 400)).toMatch(/isLeapAdmin\(auth\.profile\)/);
    expect(src).toMatch(/Leesfout = uit/);
  });
});

describe('database', () => {
  const up = read('supabase/migrations/20261016100000_chat_attachments.sql');
  const down = read('supabase/rollback/20261016100000_chat_attachments_down.sql');
  it('opt-in in de database, en geen ingebedde bestanden in berichten of Studiecafé', () => {
    expect(up).toMatch(/p_feature = ANY \(ARRAY\['attachments'\]\)[\s\S]*= 'true'/);
    for (const t of ['messages', 'studiecafe_threads', 'studiecafe_replies']) {
      expect(up).toMatch(new RegExp(`BEFORE INSERT OR UPDATE ON public\\.${t}`));
    }
    expect(up).toContain("NOTIFY pgrst, 'reload schema'");
  });
  it('heeft een terugdraaiscript', () => {
    expect(down).toContain('DROP TRIGGER IF EXISTS leap_messages_no_inline_files');
    expect(down).toContain('DROP TABLE IF EXISTS public.leap_setting_changes');
    expect(down).toMatch(/IS DISTINCT FROM 'false'/);
  });
});

describe('analyse', () => {
  it('chatverzoeken met bijlagen tellen apart', () => {
    expect(featureOf('/api/chat', { purpose: 'tutor_chat' })).toBe('chat');
    expect(featureOf('/api/chat', { purpose: 'tutor_chat', attachments: [{ kind: 'image' }] })).toBe('chat-attachments');
  });
});
