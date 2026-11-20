// YouTube-video als cursusbron (2026-11-18). De docent plakt de link en het
// transcript dat YouTube onder de video toont ("Transcript weergeven"). LEAP haalt
// zelf niets van YouTube op behalve de titel via de officiële oEmbed-route: geen
// ondertitels of beelden (voorwaarden van YouTube, en Azure wordt geblokkeerd).
//
// Een video wordt opgeslagen als een gewone webbron (documents.file_type 'web',
// file_path = de video-URL). Zo gelden alle bestaande regels voor webbronnen
// (openen, doel wijzigen, verwijderen, begrippen) zonder dat die code verandert.
// Elk fragment krijgt in zijn metadata source 'youtube', videoId en de begin- en
// eindtijd, zodat de bronvermelding naar het juiste moment in de video springt.
//
// Wat alleen in beeld te zien is, staat niet in een transcript. Een fragment dat
// naar het beeld verwijst ("hier zie je…") krijgt daarom een notitie voor het
// taalmodel: niet invullen wat er te zien is, maar naar dat moment verwijzen.

export const YOUTUBE_LIMITS = {
  MAX_TRANSCRIPT_CHARS: 400_000,
  MIN_TEXT_CHARS: 200,
  CHUNK_TARGET_CHARS: 900,
  CHUNK_MAX_CHARS: 1400,
  CHUNK_MAX_SECONDS: 120,
  // Ruim genoeg voor een video van vele uren; begrenst de kosten van één verzoek.
  MAX_CHUNKS: 600,
  OEMBED_TIMEOUT_MS: 8000,
};

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be',
]);

/** Video-id uit een YouTube-link (watch, youtu.be, shorts, embed, live), anders null. */
export function parseYouTubeId(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;
  let id = null;
  if (host === 'youtu.be') {
    id = u.pathname.split('/')[1] || null;
  } else if (u.pathname === '/watch') {
    id = u.searchParams.get('v');
  } else {
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
    id = m ? m[1] : null;
  }
  return id && VIDEO_ID_RE.test(id) ? id : null;
}

/** De vaste vorm waaronder een video wordt opgeslagen (documents.file_path). */
export function canonicalYouTubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Link naar een moment in de video. */
export function youTubeTimeUrl(videoId, seconds) {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  return t > 0 ? `${canonicalYouTubeUrl(videoId)}&t=${t}s` : canonicalYouTubeUrl(videoId);
}

/** Is deze opgeslagen URL een YouTube-video? (gedeeld met de frontend) */
export function isYouTubeUrl(url) {
  return parseYouTubeId(url) !== null;
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatVideoTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// "1:02", "01:02:03", "00:00:01,000" of "00:00:01.000" → seconden.
function toSeconds(stamp) {
  const parts = stamp.replace(/[.,]\d+$/, '').split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const STAMP_ONLY_RE = /^\(?(\d{1,2}(?::\d{2}){1,2})\)?$/;
const STAMP_LEAD_RE = /^\(?(\d{1,2}(?::\d{2}){1,2})\)?\s+(.+)$/;
const CUE_RE = /^(\d{1,2}(?::\d{2}){1,2}[.,]\d{1,3})\s*-->\s*\d/;
// De transcriptweergave van YouTube zet onder elk tijdstip een voorleesregel als
// "2 seconden" of "1 minute, 5 seconds"; die hoort niet bij de tekst.
const SPOKEN_DURATION_RE = /^\d+\s+\p{L}+(?:,?\s+\d+\s+\p{L}+)*$/u;

/**
 * Leest een geplakt transcript: de tekst uit "Transcript weergeven" (tijdstip op
 * een eigen regel of vóór de tekst) en ook SRT/WebVTT. Geeft segmenten
 * [{ start, text }] in tijdsvolgorde; tekst zonder tijdstip vooraf telt vanaf 0.
 */
export function parseTranscript(raw) {
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim());
  const segments = [];
  let current = null;
  let afterStamp = false;
  const open = (start) => {
    if (current && current.text) segments.push(current);
    current = { start, text: '' };
  };
  for (const line of lines) {
    if (!line || line === 'WEBVTT' || /^\d+$/.test(line)) { afterStamp = afterStamp && !line; continue; }
    const cue = line.match(CUE_RE);
    if (cue) { open(toSeconds(cue[1])); afterStamp = false; continue; }
    const only = line.match(STAMP_ONLY_RE);
    if (only) { open(toSeconds(only[1])); afterStamp = true; continue; }
    if (afterStamp && SPOKEN_DURATION_RE.test(line)) { afterStamp = false; continue; }
    afterStamp = false;
    const lead = line.match(STAMP_LEAD_RE);
    let text = line;
    if (lead) { open(toSeconds(lead[1])); text = lead[2]; }
    if (!current) current = { start: 0, text: '' };
    // WebVTT-opmaak (<c>, <00:00:01.000>) weghalen.
    text = text.replace(/<[^>]+>/g, '').trim();
    if (text) current.text = current.text ? `${current.text} ${text}` : text;
  }
  if (current && current.text) segments.push(current);
  return segments
    .filter((s) => Number.isFinite(s.start))
    .sort((a, b) => a.start - b.start);
}

/**
 * Knipt segmenten in fragmenten per tijdvak (~1 minuut), bij voorkeur op een
 * zinseinde. Elk fragment: { start, end, text }; end = begin van het volgende
 * segment (of het eigen begin bij het laatste).
 */
export function chunkTranscript(segments, opts = {}) {
  const target = opts.targetChars ?? YOUTUBE_LIMITS.CHUNK_TARGET_CHARS;
  const max = opts.maxChars ?? YOUTUBE_LIMITS.CHUNK_MAX_CHARS;
  const maxSec = opts.maxSeconds ?? YOUTUBE_LIMITS.CHUNK_MAX_SECONDS;
  const chunks = [];
  let cur = null;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const nextStart = i + 1 < segments.length ? segments[i + 1].start : seg.start;
    if (!cur) cur = { start: seg.start, end: seg.start, text: '' };
    cur.text = cur.text ? `${cur.text} ${seg.text}` : seg.text;
    cur.end = Math.max(cur.end, nextStart);
    const len = cur.text.length;
    const atSentenceEnd = /[.!?…]["')\]]?$/.test(seg.text);
    if ((len >= target && atSentenceEnd) || len >= max || cur.end - cur.start >= maxSec) {
      chunks.push(cur);
      cur = null;
    }
  }
  if (cur && cur.text) {
    // Een heel kort staartje hoort bij het vorige fragment.
    const prev = chunks[chunks.length - 1];
    if (prev && cur.text.length < target / 4) {
      prev.text = `${prev.text} ${cur.text}`;
      prev.end = Math.max(prev.end, cur.end);
    } else {
      chunks.push(cur);
    }
  }
  return chunks;
}

// Zinnen waarmee een spreker naar het beeld verwijst. Bewust ruim: liever een
// notitie te veel (dan verwijst LEAP naar de video) dan dat het model gaat
// invullen wat er te zien is.
const VISUAL_REF_RE = new RegExp([
  // Nederlands
  'hier zie je', 'zie je hier', 'zoals je (?:hier )?(?:kunt )?zien', 'zoals je ziet', 'je ziet hier',
  'kijk (?:eens )?(?:hier|naar)', 'in (?:dit|deze) (?:plaatje|afbeelding|figuur|tekening|animatie|schema|beeld)',
  'op (?:dit|deze) (?:plaatje|afbeelding|figuur|tekening|animatie|schema)', 'hier in (?:het )?(?:rood|blauw|groen|geel|paars|oranje)',
  // Engels
  'as you can see', 'you can see', 'here you (?:can )?see', 'if you look', 'look at', 'shown here', 'as shown',
  'in (?:this|the) (?:picture|image|figure|diagram|drawing|animation|slide)',
  'this (?:picture|image|figure|diagram|drawing|animation) shows',
  'in (?:red|blue|green|yellow|purple|orange) here', 'right here', 'over here',
  // Duits / Frans
  'hier sieht man', 'wie man (?:hier )?sieht', 'comme (?:on|vous) (?:le )?(?:voy|pouv)', 'ici on voit',
].map((p) => `\\b${p}\\b`).join('|'), 'i');

/** Verwijst dit stuk tekst naar wat er in beeld te zien is? */
export function refersToVisual(text) {
  return VISUAL_REF_RE.test(String(text || ''));
}

/**
 * Tekst van een fragment zoals die wordt ingebed en aan het taalmodel wordt
 * gegeven: tijdvak vooraan, bij een verwijzing naar het beeld een notitie.
 */
export function chunkContent(chunk) {
  const span = `[Video ${formatVideoTime(chunk.start)}–${formatVideoTime(chunk.end)}]`;
  const note = refersToVisual(chunk.text)
    ? `\n[Note: here the video shows something on screen that this transcript does not describe. Do not describe or guess what is shown; refer the student to the video at ${formatVideoTime(chunk.start)}.]`
    : '';
  return `${span}\n${chunk.text}${note}`;
}

/** Metadata per fragment (document_chunks.metadata). */
export function chunkMetadata(videoId, chunk) {
  return {
    source: 'youtube',
    sourceUrl: canonicalYouTubeUrl(videoId),
    videoId,
    timeStart: Math.floor(chunk.start),
    timeEnd: Math.floor(chunk.end),
    ...(refersToVisual(chunk.text) ? { visualRef: true } : {}),
  };
}

/**
 * Titel en maker via YouTube oEmbed (vaste host, geen gebruikers-URL wordt
 * opgehaald). Geeft null bij elke fout: de docent kan dan zelf een titel geven.
 */
export async function fetchYouTubeTitle(videoId, fetchImpl = fetch, timeoutMs = YOUTUBE_LIMITS.OEMBED_TIMEOUT_MS) {
  if (!VIDEO_ID_RE.test(String(videoId || ''))) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonicalYouTubeUrl(videoId))}`;
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'manual' });
    if (!res.ok) return null;
    const data = await res.json();
    const title = typeof data?.title === 'string' ? data.title.trim().slice(0, 250) : '';
    const author = typeof data?.author_name === 'string' ? data.author_name.trim().slice(0, 120) : '';
    return title ? { title, author } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Slaat een video op als webbron met fragmenten. Embeddings eerst (de trage,
 * faalbare stap): mislukken die, dan blijft een bestaande versie heel. Mislukt
 * daarna het opslaan van de fragmenten, dan staat de video op 'failed' en
 * voegt de docent hem opnieuw toe.
 * Dezelfde video in dezelfde map wordt bijgewerkt in plaats van verdubbeld.
 *
 * @param {object} db  supabaseAdmin
 * @param {object} p
 * @param {(texts: string[]) => Promise<number[][]>} p.embed
 * @param {(s: string) => string} [p.clean]  tekst-sanering (sanitizeText)
 * @returns {Promise<{documentId: string, chunks: number, visualRefs: number, updated: boolean}>}
 */
export async function saveYouTubeDocument(db, { folderId, videoId, title, purpose, userId, chunks, embed, clean = (s) => s }) {
  const url = canonicalYouTubeUrl(videoId);
  const contents = chunks.map((c) => clean(chunkContent(c)));
  const embeddings = await embed(contents);
  if (!Array.isArray(embeddings) || embeddings.length !== contents.length) {
    throw new Error('Embeddings onvolledig');
  }

  const { data: existing, error: exErr } = await db.from('documents')
    .select('id').eq('folder_id', folderId).eq('file_path', url).eq('file_type', 'web').maybeSingle();
  if (exErr) throw new Error(`Kon bestaande video niet opzoeken: ${exErr.message}`);

  const labels = { purpose, purpose_confirmed_at: new Date().toISOString() };
  let docId;
  if (existing) {
    docId = existing.id;
    const { error: resetErr } = await db.from('documents').update({ processing_status: 'processing', total_chunks: 0 }).eq('id', docId);
    if (resetErr) throw new Error(`Kon video niet bijwerken: ${resetErr.message}`);
    const { error: delErr } = await db.from('document_chunks').delete().eq('document_id', docId);
    if (delErr) throw new Error(`Kon oude fragmenten niet verwijderen: ${delErr.message}`);
  } else {
    const { data: created, error: insErr } = await db.from('documents').insert({
      title, filename: title, file_path: url, file_type: 'web', bucket: 'rag_sources',
      folder_id: folderId, mime_type: 'text/html', processing_status: 'processing',
      total_chunks: 0, uploaded_by: userId, ...labels,
    }).select('id').single();
    if (insErr || !created) throw new Error(`Kon video niet opslaan: ${insErr?.message || 'onbekend'}`);
    docId = created.id;
  }

  const rows = chunks.map((c, idx) => ({
    document_id: docId,
    content: contents[idx],
    embedding: embeddings[idx],
    chunk_index: idx,
    metadata: chunkMetadata(videoId, c),
  }));
  const { error: chunkErr } = await db.from('document_chunks').insert(rows);
  if (chunkErr) {
    await db.from('documents').update({ processing_status: 'failed' }).eq('id', docId);
    throw new Error(`Kon fragmenten niet opslaan: ${chunkErr.message}`);
  }
  const { error: finErr } = await db.from('documents').update({
    title, filename: title, processing_status: 'completed', total_chunks: rows.length, ...labels,
  }).eq('id', docId);
  if (finErr) throw new Error(`Kon video niet afronden: ${finErr.message}`);

  return {
    documentId: docId,
    chunks: rows.length,
    visualRefs: rows.filter((r) => r.metadata.visualRef).length,
    updated: !!existing,
  };
}
