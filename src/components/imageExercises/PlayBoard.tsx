import { useEffect, useState } from 'react';
import { ArrowLeft, BookText, Check, Flag, Lightbulb, Loader2, RotateCcw, Send, X, ZoomIn } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../i18n';
import { MathText } from '../MathText';
import {
  answerPlay, finishPlay, hintPlay, journalPlay, restartPlay, startPlay, PlayError,
  type PlayState, type PlayTile, type PlayTurn,
} from '../../services/image-play.service';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];

/**
 * Het speelbord voor één foto ("Wat zie ik?"), als een één-op-één gesprek: de foto,
 * direct eronder het invoervak en daaronder alleen de laatste reactie van LEAP (die
 * de vorige vervangt); het bord met de vakjes staat ernaast. Zo blijft de foto in beeld. Is alles
 * gevonden of onthuld, dan rondt de server vanzelf af; daarna kan de student de
 * bevindingen in het leerdagboek zetten.
 */
export function PlayBoard({ courseId, exerciseId, onBack, onNext }: {
  courseId: string;
  exerciseId: string;
  onBack: () => void;
  onNext?: () => void;
}) {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const [state, setState] = useState<PlayState | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    setState(null);
    startPlay(courseId, exerciseId).then(setState).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [courseId, exerciseId]);

  const act = async (key: string, fn: () => Promise<PlayState>) => {
    setBusy(key);
    setError(null);
    try {
      const next = await fn();
      setFresh(new Set((next.newly || []).map((n) => n.id)));
      setState(next);
      return true;
    } catch (e) {
      setError(e instanceof PlayError && e.code === 'slowDown' ? t('imagePlay.slowDown') : e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    if (await act('answer', () => answerPlay(courseId, exerciseId, value))) setText('');
  };

  if (error && !state) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>;
  if (!state) return <div className="flex items-center gap-2 text-sm text-gray-600"><Loader2 className="h-4 w-4 animate-spin" />{t('imagePlay.loading')}</div>;

  const { board, finished } = state;
  const core = board.tiles.filter((x) => x.core);
  const extra = board.tiles.filter((x) => !x.core);
  const count = board.count;
  const emptyCore = count.mode === 'exact' && !finished ? Math.max(0, count.core - core.length) : 0;
  const emptyExtra = count.mode === 'exact' && !finished ? Math.max(0, count.extra - extra.length) : 0;
  // Alleen de laatste uitwisseling: wat de student net schreef en wat LEAP terugzei.
  const shown = state.turns.filter((x) => x.kind !== 'journal');
  const lastLeap = [...shown].reverse().find((x) => x.role === 'leap' && x.kind !== 'closing');
  const lastIndex = lastLeap ? shown.lastIndexOf(lastLeap) : -1;
  const lastStudent = lastIndex > 0 && shown[lastIndex - 1]?.role === 'student' ? shown[lastIndex - 1] : null;
  const closing = [...shown].reverse().find((x) => x.kind === 'closing');

  return (
    <div className="space-y-3" data-testid="play-board">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-amber-700 hover:underline" data-testid="button-play-back">
        <ArrowLeft className="h-4 w-4" />{t('imagePlay.backToList')}
      </button>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* Eén-op-één: de foto, direct eronder het invoervak, daaronder de laatste reactie
            van LEAP (die steeds de vorige vervangt). Zo blijft de foto in beeld. */}
        <div className="chic-card space-y-3 p-3 lg:col-span-3" data-testid="play-conversation">
          <h2 className="text-lg font-bold text-gray-900">{t('imagePlay.photoTitle', { n: String(state.exercise.number) })}</h2>
          {state.exercise.imageUrl && (
            <button type="button" onClick={() => setZoom(true)} className="relative block w-full" aria-label={t('imagePlay.zoom')} data-testid="button-play-zoom">
              <img src={state.exercise.imageUrl} alt={t('imagePlay.photoTitle', { n: String(state.exercise.number) })} className="max-h-[50vh] w-full rounded-xl border border-gray-200 bg-gray-50 object-contain" />
              <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-lg bg-white/90 px-2 py-1 text-xs text-gray-700 shadow-sm"><ZoomIn className="h-3.5 w-3.5" />{t('imagePlay.zoom')}</span>
            </button>
          )}

          {finished ? (
            <Finished
              state={state}
              closing={closing}
              busy={busy}
              courseId={courseId}
              exerciseId={exerciseId}
              onRestart={() => void act('restart', () => restartPlay(courseId, exerciseId))}
              onNext={onNext}
              onJournalSaved={() => setState((s) => (s ? { ...s, journalSaved: true } : s))}
            />
          ) : (
            <>
              <div className="space-y-2">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(); }}
                  rows={3}
                  maxLength={3000}
                  placeholder={t('imagePlay.placeholder')}
                  className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none"
                  aria-label={t('imagePlay.placeholder')}
                  data-testid="textarea-play-answer"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => void send()} disabled={!!busy || !text.trim()} className="btn-primary inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50" data-testid="button-play-send">
                    {busy === 'answer' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{t('imagePlay.send')}
                  </button>
                  <button type="button" onClick={() => void act('hint', () => hintPlay(courseId, exerciseId))} disabled={!!busy} className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50" data-testid="button-play-hint">
                    {busy === 'hint' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lightbulb className="h-4 w-4" />}{t('imagePlay.hint')}
                  </button>
                  <button type="button" onClick={() => void act('finish', () => finishPlay(courseId, exerciseId))} disabled={!!busy} className="ml-auto inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50" data-testid="button-play-finish">
                    {busy === 'finish' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flag className="h-4 w-4" />}{board.coreDone ? t('imagePlay.finishDone') : t('imagePlay.finish')}
                  </button>
                </div>
                {state.answersLeft <= 5 && <p className="text-xs text-gray-500">{t('imagePlay.answersLeft', { n: String(state.answersLeft) })}</p>}
              </div>
              <div className="min-h-[3.5rem] space-y-1.5" aria-live="polite" data-testid="play-latest">
                {busy === 'answer' || busy === 'hint'
                  ? <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />{t('imagePlay.thinking')}</p>
                  : (
                    <>
                      {lastStudent && <p className="truncate text-xs text-gray-500" data-testid="text-play-last-answer">{t('imagePlay.youSaid')} {lastStudent.text}</p>}
                      {lastLeap ? <Reply turn={lastLeap} /> : <p className="text-sm text-gray-600">{t('imagePlay.start')}</p>}
                    </>
                  )}
              </div>
            </>
          )}
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" data-testid="text-play-error">{error}</p>}
        </div>

        {/* Het speelbord ernaast (op een telefoon eronder) */}
        <div className="chic-card space-y-4 p-4 lg:col-span-2 lg:self-start" data-testid="play-tiles">
          <div>
            <p className="text-sm font-medium text-gray-800">{tk(`imagePlay.depth.${state.exercise.depth}`)}</p>
            <p className="text-sm text-gray-600" data-testid="text-play-count">
              {count.mode === 'exact' ? t('imagePlay.count.exact', { core: String(count.core), extra: String(count.extra) })
                : count.mode === 'approx' ? t('imagePlay.count.approx', { n: String(count.about) })
                  : t('imagePlay.count.none')}
            </p>
          </div>
          <TileGroup title={t('imagePlay.core')} tiles={core} empty={emptyCore} fresh={fresh} finished={finished} />
          {(extra.length > 0 || emptyExtra > 0) && <TileGroup title={t('imagePlay.bonus')} tiles={extra} empty={emptyExtra} fresh={fresh} finished={finished} />}
          {board.coreDone && !finished && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800" data-testid="text-core-done">{t('imagePlay.coreDone')}</p>
          )}
          <Legend />
        </div>
      </div>

      {zoom && state.exercise.imageUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-black/80 p-4" role="dialog" aria-modal="true" onClick={() => setZoom(false)} data-testid="dialog-play-zoom">
          <button type="button" onClick={() => setZoom(false)} className="absolute right-4 top-4 rounded-full bg-white/90 p-2" aria-label={t('imagePlay.close')}><X className="h-5 w-5" /></button>
          <img src={state.exercise.imageUrl} alt="" className="max-h-full max-w-full object-contain" />
        </div>
      )}
    </div>
  );
}

function TileGroup({ title, tiles, empty, fresh, finished }: { title: string; tiles: PlayTile[]; empty: number; fresh: Set<string>; finished: boolean }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</p>
      <div className="flex flex-wrap gap-2">
        {tiles.map((tile) => <Tile key={tile.id} tile={tile} fresh={fresh.has(tile.id)} finished={finished} />)}
        {Array.from({ length: empty }, (_, i) => (
          <span key={`e${i}`} className="inline-flex h-9 min-w-[6rem] items-center justify-center rounded-xl border-2 border-dashed border-gray-300 px-3 text-gray-300" aria-hidden="true">· · ·</span>
        ))}
      </div>
    </div>
  );
}

function Tile({ tile, fresh, finished }: { tile: PlayTile; fresh: boolean; finished: boolean }) {
  const { t } = useLanguage();
  const style = tile.state === 'full'
    ? (tile.how === 'hint' ? 'bg-emerald-100 text-emerald-900 border-emerald-300' : 'bg-emerald-600 text-white border-emerald-600')
    : tile.state === 'half'
      ? 'bg-gradient-to-r from-amber-300 to-white text-amber-900 border-amber-300'
      : 'bg-gray-100 text-gray-500 border-gray-200';
  const title = tile.state === 'half' ? t('imagePlay.halfTip') : tile.how === 'hint' ? t('imagePlay.hintTip') : '';
  return (
    <span className={`inline-flex min-h-9 items-center gap-1.5 rounded-xl border px-3 py-1 text-sm font-medium ${style} ${fresh ? 'ring-4 ring-emerald-300 transition' : ''}`} title={title} data-testid={`tile-${tile.id}`}>
      {tile.state === 'full' && tile.how !== 'hint' && <Check className="h-4 w-4" />}
      {tile.how === 'hint' && <Lightbulb className="h-3.5 w-3.5" />}
      <span>{tile.label}</span>
      {finished && tile.state === 'none' && <span className="text-xs font-normal">({t('imagePlay.notFound')})</span>}
    </span>
  );
}

function Legend() {
  const { t } = useLanguage();
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
      <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded bg-emerald-600" />{t('imagePlay.legend.full')}</span>
      <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded bg-gradient-to-r from-amber-300 to-white ring-1 ring-amber-300" />{t('imagePlay.legend.half')}</span>
      <span className="inline-flex items-center gap-1"><Lightbulb className="h-3 w-3" />{t('imagePlay.legend.hint')}</span>
    </p>
  );
}

function Reply({ turn }: { turn: PlayTurn }) {
  const { t } = useLanguage();
  const tk = (k: string) => t(k as TKey);
  const text = turn.code ? tk(`imagePlay.fallback.${turn.code}`) : turn.text;
  const prefix = turn.kind === 'hint' ? `${t('imagePlay.hintPrefix')} ` : turn.kind === 'reveal' ? `${t('imagePlay.revealPrefix')} ` : '';
  return (
    <div className={`rounded-xl px-3 py-2 text-sm ${turn.kind === 'hint' || turn.kind === 'reveal' ? 'bg-sky-50 text-sky-900' : 'bg-amber-50 text-gray-800'}`} data-testid="turn-leap">
      {prefix && <span className="font-semibold">{prefix}</span>}<MathText text={text} />
    </div>
  );
}

function Finished({ state, closing, busy, courseId, exerciseId, onRestart, onNext, onJournalSaved }: {
  state: PlayState;
  closing?: PlayTurn;
  busy: string | null;
  courseId: string;
  exerciseId: string;
  onRestart: () => void;
  onNext?: () => void;
  onJournalSaved: () => void;
}) {
  const { t } = useLanguage();
  const tk = (k: string) => t(k as TKey);
  const [saving, setSaving] = useState(false);
  const [journalError, setJournalError] = useState<string | null>(null);
  const self = state.board.tiles.filter((x) => x.state !== 'none' && x.how !== 'hint');

  const toJournal = async () => {
    setSaving(true);
    setJournalError(null);
    try {
      await journalPlay(courseId, exerciseId);
      onJournalSaved();
    } catch (e) {
      if (e instanceof PlayError && e.code === 'alreadySaved') onJournalSaved();
      else setJournalError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-gray-100 pt-3" data-testid="play-finished">
      {state.autoFinished && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800" data-testid="text-auto-finished">{t('imagePlay.autoFinished')}</p>}
      <p className="text-sm font-semibold text-gray-900">
        {t('imagePlay.result', { self: String(self.length), total: String(state.board.tiles.length) })}
      </p>
      {closing && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-gray-800" data-testid="text-play-closing">
          <MathText text={closing.code ? tk(`imagePlay.fallback.${closing.code}`) : closing.text} />
        </p>
      )}
      <ul className="space-y-1.5">
        {state.board.tiles.map((tile) => (
          <li key={tile.id} className="text-sm text-gray-700">
            <span className={`font-medium ${tile.state === 'none' ? 'text-gray-500' : 'text-gray-900'}`}>{tile.label}</span>
            {tile.observation && <span>: {tile.observation}</span>}
            {tile.interpretation && <span className="text-gray-500"> ({tile.interpretation})</span>}
          </li>
        ))}
      </ul>
      {state.description && (
        <details className="rounded-lg bg-gray-50 p-3 text-sm" data-testid="details-teacher-description">
          <summary className="cursor-pointer font-medium text-gray-800">{t('imagePlay.teacherDescription')}</summary>
          <p className="mt-2 whitespace-pre-wrap text-gray-700">{state.description}</p>
        </details>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {state.journalSaved ? (
          <Link to="/feedback" className="inline-flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-800 hover:underline" data-testid="link-play-journal">
            <Check className="h-4 w-4" />{t('imagePlay.journalSaved')}
          </Link>
        ) : (
          <button type="button" onClick={() => void toJournal()} disabled={saving} className="btn-primary inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50" data-testid="button-play-journal">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BookText className="h-4 w-4" />}{t('imagePlay.toJournal')}
          </button>
        )}
        <button type="button" onClick={onRestart} disabled={!!busy} className="inline-flex items-center gap-2 rounded-xl border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50" data-testid="button-play-restart">
          {busy === 'restart' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}{t('imagePlay.restart')}
        </button>
        {onNext && (
          <button type="button" onClick={onNext} className="inline-flex items-center gap-2 rounded-xl border border-amber-300 px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-50" data-testid="button-play-next">
            {t('imagePlay.next')}
          </button>
        )}
      </div>
      {journalError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{journalError}</p>}
    </div>
  );
}
