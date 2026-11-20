import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, BookOpenCheck, Check, FileText, FileUp, ImagePlus, Loader2, Pencil, RotateCcw, Sparkles, Trash2, Unlink } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { AdminHint } from '../help/AdminHint';
import { ImageFeatureEditor } from './ImageFeatureEditor';
import { ImageDescriptionGuide } from './ImageDescriptionGuide';
import { LinkingTips } from './LinkingTips';
import {
  confirmImageExercises, deleteImageExercise, fetchImageExercises, regenerateFeatures, setImageFeatureCore,
  suggestImageMatches, updateImageExercise, uploadDescriptions, uploadImageExercisePhoto,
  type CountDisplay, type DescriptionResult, type Depth, type ImageExercise, type MatchSource,
} from '../../services/image-exercises.service';

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];
type Loose = DescriptionResult['unmatchedSections'][number];
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
/** Vanaf zoveel kenmerken vragen we de docent te kijken wat echt kern is. */
const LARGE_BOARD = 25;

/**
 * Beeldoefeningen, docentkant (stap 1): foto's en beschrijvingen uploaden,
 * koppelen (LEAP stelt voor, de docent bevestigt) en de kenmerken nalopen.
 * Beschrijvingen en kenmerken zijn de antwoordsleutel: studenten zien ze niet.
 */
export function ImageExercisesAdmin() {
  const { t } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const { activeCourseId: courseId } = useActiveCourse();
  const [items, setItems] = useState<ImageExercise[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loose, setLoose] = useState<DescriptionResult['unmatchedSections']>([]);
  // Voorstel van LEAP per foto: verwijst naar een los stuk tekst (niet naar een index,
  // want de lijst losse stukken verandert als je er een koppelt).
  const [suggested, setSuggested] = useState<Record<string, Loose>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<ImageExercise | null>(null);
  const [onlyDoubt, setOnlyDoubt] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);
  // Beschrijvingsbestand bij één bepaalde foto: welke foto, en het verborgen bestandsveld.
  const photoDocInput = useRef<HTMLInputElement>(null);
  const [docFor, setDocFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!courseId) return;
    try {
      setItems(await fetchImageExercises(courseId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [courseId]);

  useEffect(() => { setItems(null); setLoose([]); setSuggested({}); setDrafts({}); void load(); }, [load]);

  // Zolang LEAP kenmerken maakt, elke paar seconden kijken of ze klaar zijn.
  const pending = (items || []).some((e) => e.featuresStatus === 'pending');
  useEffect(() => {
    if (!pending) return undefined;
    const id = window.setInterval(() => { void load(); }, 4000);
    return () => window.clearInterval(id);
  }, [pending, load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try { await fn(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(null); }
  };

  if (!courseId) return <p className="text-sm text-gray-600">{t('imageEx.noCourse')}</p>;
  if (!items) return <div className="flex items-center gap-2 text-sm text-gray-600"><Loader2 className="h-4 w-4 animate-spin" />{t('imageEx.loading')}</div>;

  const toLink = items.filter((e) => !e.confirmed);
  const linked = toLink.filter((e) => e.description.trim());
  const done = items.filter((e) => e.confirmed);
  const doubts = done.filter((e) => e.featuresUncertain || e.featuresStatus === 'failed' || e.features.length > LARGE_BOARD);
  const shown = onlyDoubt ? doubts : done;

  const addPhotos = (files: FileList) => run('photos', async () => {
    const list = Array.from(files);
    const failed: string[] = [];
    for (const [i, f] of list.entries()) {
      setNotice(t('imageEx.upload.progress', { done: String(i + 1), total: String(list.length) }));
      if (f.size > MAX_PHOTO_BYTES) { failed.push(f.name); continue; }
      try { await uploadImageExercisePhoto(courseId, f); } catch { failed.push(f.name); }
    }
    setNotice(failed.length ? t('imageEx.upload.someFailed', { names: failed.join(', ') }) : t('imageEx.upload.done', { n: String(list.length) }));
    await load();
  });

  // Eén of meer beschrijvingsbestanden. Per bestand zoekt LEAP zelf de handigste
  // manier van koppelen (kopjes, bestandsnamen in de tekst, de naam van het bestand,
  // of de enige foto die nog wacht); wat niet lukt, komt bij "kies de foto".
  const addDescriptions = (files: FileList) => run('doc', async () => {
    const messages: string[] = [];
    const newLoose: DescriptionResult['unmatchedSections'] = [];
    let skipped = 0;
    for (const file of Array.from(files)) {
      try {
        const r = await uploadDescriptions(courseId, { file });
        newLoose.push(...r.unmatchedSections);
        skipped = Math.max(skipped, r.alreadyConfirmed);
        messages.push(`${file.name}: ${tk(`imageEx.desc.method.${r.method}`, { n: String(r.matched.length) })}`);
      } catch (err) {
        messages.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setLoose((l) => [...l, ...newLoose]);
    setSuggested({});
    setNotice(messages.join(' · ') + (skipped ? ` ${t('imageEx.desc.skipped', { n: String(skipped) })}` : ''));
    await load();
  });

  const addDescriptionForPhoto = (file: File, id: string) => run(`photodoc-${id}`, async () => {
    await uploadDescriptions(courseId, { file }, id);
    setNotice(t('imageEx.desc.method.photo', { n: '1' }));
    await load();
  });

  const suggest = () => run('suggest', async () => {
    const snapshot = [...loose];
    const r = await suggestImageMatches(courseId, snapshot.map((s) => `${s.heading}\n${s.text}`));
    const map: Record<string, Loose> = {};
    for (const s of r.suggestions) if (snapshot[s.section]) map[s.id] = snapshot[s.section];
    setSuggested(map);
    setNotice(t('imageEx.link.suggestDone', { n: String(r.suggestions.length) }));
  });

  const assignText = (e: ImageExercise, text: string, source: MatchSource) => run(`assign-${e.id}`, async () => {
    await updateImageExercise(courseId, e.id, { description: text, matchSource: source });
    setDrafts((d) => without(d, e.id));
    await load();
  });

  // De tekst die een foto nu heeft, gaat terug naar de losse stukken, zodat hij bij
  // een andere foto gezet kan worden (niets gaat verloren bij een verkeerde koppeling).
  const asLoose = (e: ImageExercise) => ({ heading: e.filename, text: e.description });

  const assignLoose = (e: ImageExercise, idx: number) => {
    const sec = loose[idx];
    if (!sec) return;
    const previous = e.description.trim() ? asLoose(e) : null;
    void assignText(e, sec.text, suggested[e.id] === sec ? 'suggested' : 'manual').then(() => {
      setLoose((l) => [...l.filter((x) => x !== sec), ...(previous ? [previous] : [])]);
      setSuggested((m) => Object.fromEntries(Object.entries(m).filter(([id, v]) => id !== e.id && v !== sec)));
    });
  };

  // Een voorstel van LEAP in één klik overnemen, en desgewenst meteen bevestigen.
  const takeSuggestions = (ids: string[], confirmToo: boolean) => run(`take-${ids.join(',')}`, async () => {
    const taken: Loose[] = [];
    const done: string[] = [];
    for (const id of ids) {
      const sec = suggested[id];
      if (!sec) continue;
      await updateImageExercise(courseId, id, { description: sec.text, matchSource: 'suggested' });
      taken.push(sec);
      done.push(id);
    }
    if (confirmToo && done.length) await confirmImageExercises(courseId, done);
    setLoose((l) => l.filter((x) => !taken.includes(x)));
    setSuggested((m) => Object.fromEntries(Object.entries(m).filter(([id]) => !ids.includes(id))));
    await load();
  });

  // Koppeling ongedaan maken: de foto heeft weer geen beschrijving, de tekst wordt een los stuk.
  const unlink = (e: ImageExercise) => {
    if (e.confirmed && !window.confirm(t('imageEx.link.unlinkConfirmed'))) return;
    const previous = asLoose(e);
    void run(`unlink-${e.id}`, async () => {
      await updateImageExercise(courseId, e.id, { description: '' });
      setLoose((l) => [...l, previous]);
      await load();
    });
  };

  const confirm = (ids: string[]) => run('confirm', async () => {
    await confirmImageExercises(courseId, ids);
    await load();
  });

  const remove = (e: ImageExercise) => {
    if (!window.confirm(t('imageEx.deleteConfirm', { name: e.filename }))) return;
    void run(`del-${e.id}`, async () => { await deleteImageExercise(courseId, e.id); await load(); });
  };

  const sourceLabel = (s: MatchSource | null) => (s ? tk(`imageEx.source.${s}`) : '');

  return (
    <div className="space-y-6" data-testid="panel-image-exercises">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-gray-900">{t('imageEx.title')}</h2>
        <AdminHint variant="intro">{t('imageEx.intro')}</AdminHint>
        <AdminHint variant="tip">{t('imageEx.secret')}</AdminHint>
        <AdminHint variant="warning">{t('imageEx.peopleWarning')}</AdminHint>
      </div>

      {/* 1. Uploaden */}
      <section className="space-y-3 rounded-2xl border border-gray-200 bg-white p-5" data-testid="section-image-upload">
        <h3 className="font-semibold text-gray-900">{t('imageEx.upload.title')}</h3>
        <div className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3" data-testid="callout-description-guide">
          <BookOpenCheck className="h-6 w-6 flex-shrink-0 text-amber-600" aria-hidden="true" />
          <p className="min-w-[14rem] flex-1 text-sm text-amber-900">{t('imageEx.guide.callout')}</p>
          <button type="button" onClick={() => setGuideOpen(true)} className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-600" data-testid="button-open-guide">
            <BookOpenCheck className="h-4 w-4" />{t('imageEx.guide.open')}
          </button>
        </div>
        <p className="text-sm text-gray-600">{t('imageEx.upload.howTo')}</p>
        <LinkingTips waiting={items.filter((e) => !e.confirmed && !e.description.trim()).length} />
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => photoInput.current?.click()} disabled={!!busy} className="btn-primary inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50" data-testid="button-add-photos">
            {busy === 'photos' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}{t('imageEx.upload.photos')}
          </button>
          <button type="button" onClick={() => docInput.current?.click()} disabled={!!busy || items.length === 0} className="inline-flex items-center gap-2 rounded-xl border border-sky-300 bg-white px-4 py-2 text-sm font-medium text-sky-800 hover:bg-sky-50 disabled:opacity-50" data-testid="button-add-descriptions">
            {busy === 'doc' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}{t('imageEx.upload.descriptions')}
          </button>
          <input ref={photoInput} type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { if (e.target.files?.length) void addPhotos(e.target.files); e.target.value = ''; }} data-testid="input-photos" />
          <input ref={docInput} type="file" multiple accept=".docx,.pdf,.txt,.md" className="hidden" onChange={(e) => { if (e.target.files?.length) void addDescriptions(e.target.files); e.target.value = ''; }} data-testid="input-descriptions" />
          <input ref={photoDocInput} type="file" accept=".docx,.pdf,.txt,.md" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f && docFor) void addDescriptionForPhoto(f, docFor); e.target.value = ''; setDocFor(null); }} data-testid="input-photo-description" />
        </div>
        {notice && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" data-testid="text-image-notice">{notice}</p>}
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" data-testid="text-image-error">{error}</p>}
      </section>

      {/* 2. Koppelen */}
      {toLink.length > 0 && (
        <section className="space-y-3 rounded-2xl border border-gray-200 bg-white p-5" data-testid="section-image-link">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-gray-900">{t('imageEx.link.title', { n: String(toLink.length) })}</h3>
            <div className="flex flex-wrap gap-2">
              {loose.length > 0 && toLink.some((e) => !e.description.trim()) && (
                <button type="button" onClick={() => void suggest()} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-xl border border-sky-300 px-3 py-1.5 text-sm text-sky-800 hover:bg-sky-50 disabled:opacity-50" data-testid="button-suggest-matches">
                  {busy === 'suggest' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{t('imageEx.link.suggest')}
                </button>
              )}
              {Object.keys(suggested).length > 0 && (
                <button type="button" onClick={() => void takeSuggestions(Object.keys(suggested), true)} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50" data-testid="button-take-all-suggestions">
                  <Sparkles className="h-4 w-4" />{t('imageEx.link.takeAll', { n: String(Object.keys(suggested).length) })}
                </button>
              )}
              {linked.length > 0 && (
                <button type="button" onClick={() => void confirm(linked.map((e) => e.id))} disabled={!!busy} className="btn-primary inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-semibold disabled:opacity-50" data-testid="button-confirm-all">
                  <Check className="h-4 w-4" />{t('imageEx.link.confirmAll', { n: String(linked.length) })}
                </button>
              )}
            </div>
          </div>
          <AdminHint variant="tip">{t('imageEx.link.howTo')}</AdminHint>
          <ul className="divide-y divide-gray-100">
            {toLink.map((e) => {
              const draft = drafts[e.id];
              const sug = suggested[e.id];
              return (
                <li key={e.id} className="flex flex-wrap gap-4 py-3" data-testid={`row-link-${e.id}`}>
                  <Thumb e={e} />
                  <div className="min-w-[14rem] flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium text-gray-900">{e.filename}</span>
                      {e.matchSource && <span className={`rounded-full px-2 py-0.5 text-xs ${e.matchSource === 'order' || e.matchSource === 'suggested' ? 'bg-amber-100 text-amber-800' : 'bg-sky-100 text-sky-800'}`}>{sourceLabel(e.matchSource)}</span>}
                      {!e.description.trim() && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800">{t('imageEx.link.none')}</span>}
                    </div>
                    {draft !== undefined ? (
                      <div className="space-y-2">
                        <textarea value={draft} onChange={(ev) => setDrafts((d) => ({ ...d, [e.id]: ev.target.value }))} rows={4} className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" aria-label={t('imageEx.link.typeLabel')} data-testid={`textarea-description-${e.id}`} />
                        <div className="flex gap-2">
                          <button type="button" onClick={() => void assignText(e, draft, 'typed')} disabled={!!busy || !draft.trim()} className="rounded-lg bg-sky-600 px-3 py-1 text-sm text-white disabled:opacity-50">{t('imageEx.save')}</button>
                          <button type="button" onClick={() => setDrafts((d) => without(d, e.id))} className="rounded-lg bg-gray-100 px-3 py-1 text-sm">{t('imageEx.cancel')}</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {e.description.trim() && <p className="line-clamp-4 whitespace-pre-wrap text-sm text-gray-700">{e.description}</p>}
                        {sug && (
                          <div className="space-y-1.5 rounded-lg border border-violet-200 bg-violet-50 p-2.5 text-sm" data-testid={`suggestion-${e.id}`}>
                            <p className="flex items-center gap-1.5 text-xs font-semibold text-violet-800"><Sparkles className="h-3.5 w-3.5" />{e.description.trim() ? t('imageEx.link.suggestionReplace') : t('imageEx.link.suggestionTitle')}</p>
                            <p className="line-clamp-3 whitespace-pre-wrap text-gray-700">{sug.heading ? `${sug.heading}: ` : ''}{sug.text}</p>
                            <div className="flex flex-wrap gap-2">
                              <button type="button" onClick={() => void takeSuggestions([e.id], true)} disabled={!!busy} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50" data-testid={`button-take-confirm-${e.id}`}><Check className="h-3.5 w-3.5" />{t('imageEx.link.takeConfirm')}</button>
                              <button type="button" onClick={() => void takeSuggestions([e.id], false)} disabled={!!busy} className="rounded-lg border border-violet-300 bg-white px-2.5 py-1 text-xs text-violet-800 disabled:opacity-50" data-testid={`button-take-${e.id}`}>{t('imageEx.link.take')}</button>
                              <button type="button" onClick={() => setSuggested((m) => without(m, e.id))} className="px-1 text-xs text-gray-600 underline" data-testid={`button-reject-suggestion-${e.id}`}>{t('imageEx.link.rejectSuggestion')}</button>
                            </div>
                          </div>
                        )}
                        {loose.length > 0 && (
                          <select className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" value="" onChange={(ev) => assignLoose(e, Number(ev.target.value))} aria-label={t('imageEx.link.choose')} data-testid={`select-description-${e.id}`}>
                            <option value="" disabled>{e.description.trim() ? t('imageEx.link.chooseOther') : t('imageEx.link.choose')}</option>
                            {loose.map((s, i) => <option key={i} value={i}>{s === sug ? '★ ' : ''}{s.heading}: {s.text.slice(0, 80)}</option>)}
                          </select>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex items-start gap-1">
                    {e.description.trim() && draft === undefined && (
                      <button type="button" onClick={() => void confirm([e.id])} disabled={!!busy} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-sm text-white disabled:opacity-50" data-testid={`button-confirm-${e.id}`}><Check className="h-4 w-4" />{t('imageEx.link.confirm')}</button>
                    )}
                    {draft === undefined && (
                      <button type="button" onClick={() => setDrafts((d) => ({ ...d, [e.id]: e.description }))} className="rounded-lg p-1.5 hover:bg-gray-100" aria-label={t('imageEx.link.type')} title={t('imageEx.link.type')} data-testid={`button-type-${e.id}`}><Pencil className="h-4 w-4 text-gray-600" /></button>
                    )}
                    {draft === undefined && e.description.trim() && (
                      <button type="button" onClick={() => unlink(e)} disabled={!!busy} className="rounded-lg p-1.5 hover:bg-gray-100 disabled:opacity-50" aria-label={t('imageEx.link.unlink')} title={t('imageEx.link.unlink')} data-testid={`button-unlink-${e.id}`}><Unlink className="h-4 w-4 text-gray-600" /></button>
                    )}
                    {draft === undefined && (
                      <button type="button" onClick={() => { setDocFor(e.id); photoDocInput.current?.click(); }} disabled={!!busy} className="rounded-lg p-1.5 hover:bg-gray-100 disabled:opacity-50" aria-label={t('imageEx.link.uploadForPhoto')} title={t('imageEx.link.uploadForPhoto')} data-testid={`button-upload-description-${e.id}`}>
                        {busy === `photodoc-${e.id}` ? <Loader2 className="h-4 w-4 animate-spin text-gray-600" /> : <FileUp className="h-4 w-4 text-gray-600" />}
                      </button>
                    )}
                    <button type="button" onClick={() => remove(e)} className="rounded-lg p-1.5 hover:bg-red-50" aria-label={t('imageEx.delete')} data-testid={`button-delete-photo-${e.id}`}><Trash2 className="h-4 w-4 text-red-600" /></button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Tekst uit het document die bij geen enkele foto terechtkwam: altijd melden. */}
      {loose.length > 0 && (
        <div className="space-y-2 rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" role="alert" data-testid="warning-loose-sections">
          <p className="flex items-start gap-2 font-semibold"><AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />{t('imageEx.link.loose', { n: String(loose.length) })}</p>
          <p>{t('imageEx.link.looseHelp')}</p>
          <p className="text-xs">{t('imageEx.link.looseNotSaved')}</p>
          <ul className="space-y-1">{loose.map((s, i) => <li key={i}><span className="font-medium">{s.heading}</span>: {s.text.slice(0, 160)}{s.text.length > 160 ? '…' : ''}</li>)}</ul>
          <button type="button" onClick={() => setLoose([])} className="text-xs underline" data-testid="button-dismiss-loose">{t('imageEx.link.looseDismiss')}</button>
        </div>
      )}

      {/* 3. Kenmerken */}
      {done.length > 0 && (
        <section className="space-y-3 rounded-2xl border border-gray-200 bg-white p-5" data-testid="section-image-features">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-gray-900">{t('imageEx.features.title', { n: String(done.length) })}</h3>
            {doubts.length > 0 && (
              <label className="flex items-center gap-2 text-sm text-amber-800">
                <input type="checkbox" checked={onlyDoubt} onChange={(e) => setOnlyDoubt(e.target.checked)} data-testid="checkbox-only-doubt" />
                {t('imageEx.features.onlyDoubt', { n: String(doubts.length) })}
              </label>
            )}
          </div>
          <AdminHint variant="tip">{t('imageEx.features.howTo')}</AdminHint>
          <ul className="divide-y divide-gray-100">
            {shown.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-4 py-3" data-testid={`row-features-${e.id}`}>
                <Thumb e={e} />
                <div className="min-w-[14rem] flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-gray-900">{e.filename}</span>
                    {e.featuresReviewed && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">{t('imageEx.features.reviewed')}</span>}
                  </div>
                  {drafts[e.id] !== undefined && (
                    <div className="space-y-2">
                      <AdminHint variant="warning">{t('imageEx.features.editDescriptionNote')}</AdminHint>
                      <textarea value={drafts[e.id]} onChange={(ev) => setDrafts((d) => ({ ...d, [e.id]: ev.target.value }))} rows={5} className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" aria-label={t('imageEx.link.typeLabel')} data-testid={`textarea-edit-description-${e.id}`} />
                      <div className="flex gap-2">
                        <button type="button" onClick={() => void assignText(e, drafts[e.id], 'typed')} disabled={!!busy || !drafts[e.id].trim()} className="rounded-lg bg-sky-600 px-3 py-1 text-sm text-white disabled:opacity-50">{t('imageEx.save')}</button>
                        <button type="button" onClick={() => setDrafts((d) => without(d, e.id))} className="rounded-lg bg-gray-100 px-3 py-1 text-sm">{t('imageEx.cancel')}</button>
                      </div>
                    </div>
                  )}
                  {e.featuresStatus === 'pending' && <p className="flex items-center gap-1.5 text-sm text-sky-700"><Loader2 className="h-4 w-4 animate-spin" />{t('imageEx.features.pending')}</p>}
                  {e.featuresStatus === 'failed' && <p className="text-sm text-red-700">{t('imageEx.features.failed')}</p>}
                  {e.featuresUncertain && e.featuresStatus === 'ready' && (
                    <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-900" data-testid={`text-doubt-${e.id}`}>
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />{t('imageEx.features.doubt')}{e.featuresNote ? ` ${e.featuresNote}` : ''}
                    </p>
                  )}
                  {e.featuresStatus === 'ready' && e.features.length > LARGE_BOARD && (
                    <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-900" data-testid={`text-large-board-${e.id}`}>
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />{t('imageEx.features.largeBoard', { n: String(e.features.length), core: String(e.features.filter((f) => f.is_core).length) })}
                    </p>
                  )}
                  {e.featuresStatus === 'ready' && (
                    <div className="flex flex-wrap gap-1.5">
                      {e.features.map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => f.id && void run(`core-${f.id}`, async () => { await setImageFeatureCore(courseId, f.id!, !f.is_core); await load(); })}
                          className={`rounded-full px-2.5 py-1 text-xs ${f.is_core ? 'bg-brand-600 font-semibold text-white' : 'border border-dashed border-gray-400 text-gray-700'}`}
                          title={`${f.is_core ? t('imageEx.core') : t('imageEx.extra')} · ${t('imageEx.features.toggle')}`}
                          data-testid={`chip-feature-${f.id}`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-3 text-xs text-gray-700">
                    <label className="flex items-center gap-1.5">{t('imageEx.depth.label')}
                      <select value={e.depth} onChange={(ev) => void run(`depth-${e.id}`, async () => { await updateImageExercise(courseId, e.id, { depth: ev.target.value as Depth }); await load(); })} className="rounded border border-gray-300 px-1.5 py-0.5" data-testid={`select-depth-${e.id}`}>
                        {(['name', 'describe', 'interpret'] as const).map((d) => <option key={d} value={d}>{tk(`imageEx.depth.${d}`)}</option>)}
                      </select>
                    </label>
                    <label className="flex items-center gap-1.5">{t('imageEx.count.label')}
                      <select value={e.countDisplay} onChange={(ev) => void run(`count-${e.id}`, async () => { await updateImageExercise(courseId, e.id, { countDisplay: ev.target.value as CountDisplay }); await load(); })} className="rounded border border-gray-300 px-1.5 py-0.5" data-testid={`select-count-${e.id}`}>
                        {(['approx', 'exact', 'none'] as const).map((c) => <option key={c} value={c}>{tk(`imageEx.count.${c}`)}</option>)}
                      </select>
                    </label>
                  </div>
                </div>
                <div className="flex items-start gap-1">
                  {e.featuresStatus === 'ready' && (
                    <button type="button" onClick={() => setEditing(e)} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-xs hover:bg-gray-50" data-testid={`button-edit-features-${e.id}`}><Pencil className="h-3.5 w-3.5" />{t('imageEx.features.edit')}</button>
                  )}
                  {(e.featuresStatus === 'failed' || e.featuresStatus === 'ready') && (
                    <button type="button" onClick={() => { if (e.featuresStatus === 'failed' || window.confirm(t('imageEx.features.regenerateConfirm'))) void run(`regen-${e.id}`, async () => { await regenerateFeatures(courseId, e.id); await load(); }); }} className="rounded-lg p-1.5 hover:bg-gray-100" aria-label={t('imageEx.features.regenerate')} title={t('imageEx.features.regenerate')} data-testid={`button-regenerate-${e.id}`}><RotateCcw className="h-4 w-4 text-gray-600" /></button>
                  )}
                  {drafts[e.id] === undefined && (
                    <button type="button" onClick={() => setDrafts((d) => ({ ...d, [e.id]: e.description }))} className="rounded-lg p-1.5 hover:bg-gray-100" aria-label={t('imageEx.features.editDescription')} title={t('imageEx.features.editDescription')} data-testid={`button-edit-description-${e.id}`}><FileText className="h-4 w-4 text-gray-600" /></button>
                  )}
                  {drafts[e.id] === undefined && (
                    <button type="button" onClick={() => unlink(e)} disabled={!!busy} className="rounded-lg p-1.5 hover:bg-gray-100 disabled:opacity-50" aria-label={t('imageEx.link.unlink')} title={t('imageEx.link.unlink')} data-testid={`button-unlink-done-${e.id}`}><Unlink className="h-4 w-4 text-gray-600" /></button>
                  )}
                  <button type="button" onClick={() => remove(e)} className="rounded-lg p-1.5 hover:bg-red-50" aria-label={t('imageEx.delete')} data-testid={`button-delete-done-${e.id}`}><Trash2 className="h-4 w-4 text-red-600" /></button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {items.length === 0 && <p className="text-sm text-gray-500" data-testid="text-image-empty">{t('imageEx.empty')}</p>}
      {guideOpen && <ImageDescriptionGuide onClose={() => setGuideOpen(false)} />}
      {editing && <ImageFeatureEditor courseId={courseId} exercise={editing} onClose={() => setEditing(null)} onSaved={() => void load()} />}
    </div>
  );
}

function Thumb({ e }: { e: ImageExercise }) {
  return e.imageUrl ? (
    <a href={e.imageUrl} target="_blank" rel="noopener noreferrer" className="block flex-shrink-0">
      <img src={e.imageUrl} alt={e.filename} className="h-24 w-32 rounded-lg border border-gray-200 object-cover" loading="lazy" />
    </a>
  ) : (
    <div className="h-24 w-32 flex-shrink-0 rounded-lg bg-gray-100" />
  );
}

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}
