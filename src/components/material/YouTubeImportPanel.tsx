import { useState } from 'react';
import { Loader2, Video } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { importYouTubeVideo, CourseFilesError, type YouTubeImportResult } from '../../services/course-files.service';
import { parseYouTubeId } from '../../../server/ingestion/youtubeImport.js';
import { AdminHint } from '../help/AdminHint';

/**
 * YouTube-video als cursusbron: de docent geeft de link en plakt het transcript
 * dat YouTube onder de video toont. LEAP haalt zelf geen ondertitels op.
 */
export function YouTubeImportPanel({ courseId, onImported }: { courseId: string; onImported: () => void }) {
  const { t } = useLanguage();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [transcript, setTranscript] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<YouTubeImportResult | null>(null);

  const videoId = parseYouTubeId(url);
  const urlInvalid = url.trim().length > 0 && !videoId;
  const canSubmit = !!videoId && transcript.trim().length > 0 && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await importYouTubeVideo(courseId, url.trim(), transcript, title.trim() || undefined);
      setResult(r);
      onImported();
    } catch (err) {
      const known = { badUrl: 'material.youtube.error.badUrl', noTranscript: 'material.youtube.error.noTranscript', tooLong: 'material.youtube.error.tooLong' } as const;
      const code = err instanceof CourseFilesError ? err.code : undefined;
      if (code && code in known) {
        setError(t(known[code as keyof typeof known]));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setUrl('');
    setTitle('');
    setTranscript('');
    setResult(null);
    setError(null);
  };

  if (result) {
    return (
      <div className="space-y-3" data-testid="youtube-import-result">
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" data-testid="text-youtube-imported">
          {t(result.updated ? 'material.youtube.updated' : 'material.youtube.done', { title: result.title, n: String(result.chunks) })}
        </p>
        {result.visualRefs > 0 && (
          <AdminHint variant="tip">{t('material.youtube.visualNote', { n: String(result.visualRefs) })}</AdminHint>
        )}
        <AdminHint variant="intro">{t('material.youtube.conceptsHint')}</AdminHint>
        <button type="button" onClick={reset} className="text-sm text-sky-700 hover:underline" data-testid="button-youtube-another">
          {t('material.youtube.another')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="panel-youtube-import">
      <AdminHint variant="intro">{t('material.youtube.intro')}</AdminHint>
      <AdminHint variant="warning">{t('material.youtube.permission')}</AdminHint>

      <label className="block text-sm">
        <span className="font-medium text-gray-800">{t('material.youtube.urlLabel')}</span>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
          aria-invalid={urlInvalid}
          data-testid="input-youtube-url"
        />
        {urlInvalid && <span className="mt-1 block text-xs text-red-700" data-testid="text-youtube-url-invalid">{t('material.youtube.error.badUrl')}</span>}
      </label>

      <label className="block text-sm">
        <span className="font-medium text-gray-800">{t('material.youtube.titleLabel')}</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={250}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
          data-testid="input-youtube-title"
        />
        <span className="mt-1 block text-xs text-gray-500">{t('material.youtube.titleHint')}</span>
      </label>

      <label className="block text-sm">
        <span className="font-medium text-gray-800">{t('material.youtube.transcriptLabel')}</span>
        <span className="mt-1 block text-xs text-gray-600">{t('material.youtube.howTo')}</span>
        <textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          rows={10}
          placeholder={'0:00\n…'}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs focus:border-sky-400 focus:outline-none"
          data-testid="input-youtube-transcript"
        />
      </label>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" data-testid="text-youtube-error">{error}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className="btn-primary inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50"
        data-testid="button-youtube-submit"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
        {busy ? t('material.youtube.busy') : t('material.youtube.submit')}
      </button>
    </div>
  );
}
