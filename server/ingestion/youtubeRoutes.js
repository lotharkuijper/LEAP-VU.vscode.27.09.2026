// POST /api/admin/import-youtube — een YouTube-video als cursusbron (2026-11-18).
// Body: { courseId, url, transcript, title?, purpose? }. Alleen een docent van de
// cursus of een admin. De video wordt een webbron in de RAG-map van de cursus;
// zie server/ingestion/youtubeImport.js voor de regels.
import { WEB_SOURCE_PURPOSES, recordDocMutation } from '../documents/courseFiles.js';
import { isStaffForCourse, resolveAdminUser } from '../lib/auth.js';
import { AZURE_EMBEDDINGS_READY, EMBEDDINGS_NOT_CONFIGURED_MSG, embedTextsServer } from '../lib/azureOpenai.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { sanitizeText } from '../lib/sanitizeText.js';
import { ensureCourseRagFolder } from './pipeline.js';
import {
  YOUTUBE_LIMITS,
  chunkTranscript,
  fetchYouTubeTitle,
  parseTranscript,
  parseYouTubeId,
  saveYouTubeDocument,
} from './youtubeImport.js';

export function registerYouTubeRoutes(app) {
  app.post('/api/admin/import-youtube', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);

    const { courseId, url, transcript, title: givenTitle, purpose = 'course_material' } = req.body || {};
    if (!courseId || typeof courseId !== 'string') return res.status(400).json({ error: 'courseId is verplicht.' });
    if (!(await isStaffForCourse(r.user, r.profile, courseId))) {
      return res.status(403).json({ error: 'Je bent geen docent van deze cursus.' });
    }
    if (!WEB_SOURCE_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: 'Een video kan alleen leerstof of cursusinformatie zijn.' });
    }
    const videoId = parseYouTubeId(url);
    if (!videoId) return res.status(400).json({ error: 'Dit is geen geldige YouTube-link.', code: 'badUrl' });
    if (typeof transcript !== 'string' || transcript.length > YOUTUBE_LIMITS.MAX_TRANSCRIPT_CHARS) {
      return res.status(400).json({ error: 'Plak het transcript van de video.', code: 'noTranscript' });
    }
    const segments = parseTranscript(transcript);
    const textChars = segments.reduce((n, s) => n + s.text.length, 0);
    if (textChars < YOUTUBE_LIMITS.MIN_TEXT_CHARS) {
      return res.status(400).json({ error: 'Het transcript bevat te weinig tekst.', code: 'noTranscript' });
    }
    const chunks = chunkTranscript(segments);
    if (chunks.length > YOUTUBE_LIMITS.MAX_CHUNKS) {
      return res.status(400).json({ error: 'Deze video is te lang om in één keer toe te voegen.', code: 'tooLong' });
    }
    if (!AZURE_EMBEDDINGS_READY) return res.status(503).json({ error: EMBEDDINGS_NOT_CONFIGURED_MSG });

    try {
      const { data: course } = await supabaseAdmin.from('courses').select('id, name').eq('id', courseId).maybeSingle();
      if (!course) return res.status(404).json({ error: 'Cursus niet gevonden.' });

      const own = typeof givenTitle === 'string' ? givenTitle.trim().slice(0, 250) : '';
      const meta = own ? null : await fetchYouTubeTitle(videoId);
      const title = own || meta?.title || `YouTube ${videoId}`;

      const { folderId } = await ensureCourseRagFolder(courseId, course.name, r.user.id);
      const result = await saveYouTubeDocument(supabaseAdmin, {
        folderId,
        videoId,
        title,
        purpose,
        userId: r.user.id,
        chunks,
        embed: (texts) => embedTextsServer(texts, null),
        clean: sanitizeText,
      });
      try { await recordDocMutation(supabaseAdmin, courseId); } catch (e) { console.warn('[import-youtube] documentwijziging niet geregistreerd:', e.message); }
      return res.json({ ok: true, title, author: meta?.author || null, ...result });
    } catch (err) {
      console.error('[import-youtube] fout:', err.message);
      return res.status(500).json({ error: 'Video toevoegen mislukt.' });
    }
  });
}
