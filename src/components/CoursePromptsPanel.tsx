import { useEffect, useState } from 'react';
import { useLanguage } from '../i18n';
import { Check, Copy, Eye, EyeOff, Lock, MessageSquareText, Pencil, Sparkles } from 'lucide-react';
import { AdminHint } from './help/AdminHint';
import { HelpTip } from './help/HelpTip';
import { useCourseFeatures } from '../hooks/useCourseFeatures';

// Cursusinstructies per onderdeel (2026-10-20). De docent schrijft per onderdeel
// een eigen instructie; het veld begint leeg. Zolang het leeg is, krijgen
// studenten het sjabloon — dat staat er dan als waarschuwing bij. Het sjabloon
// is te bekijken en te kopiëren, maar alleen de beheerder kan het aanpassen, en
// pas na "Pas sjabloon aan" (server/prompts/promptTemplates.js).

type Section = 'chat' | 'explain';
const SECTIONS: Section[] = ['chat', 'explain'];

interface Props {
  courseId: string | null;
  courseName?: string;
  accessToken?: string;
}

export function CoursePromptsPanel({ courseId, courseName, accessToken }: Props) {
  const { t } = useLanguage();
  return (
    <div className="space-y-6" data-testid="course-prompts-panel">
      {courseId ? (
        <AdminHint variant="intro">{t('coursePrompts.forCourse', { course: courseName || '' })}</AdminHint>
      ) : (
        <AdminHint variant="warning">{t('coursePrompts.noCourse')}</AdminHint>
      )}
      {SECTIONS.map(s => (
        <PromptSectionBlock key={s} section={s} courseId={courseId} accessToken={accessToken} />
      ))}
    </div>
  );
}

function PromptSectionBlock({ section, courseId, accessToken }: { section: Section; courseId: string | null; accessToken?: string }) {
  const { t } = useLanguage();
  const { features } = useCourseFeatures();
  const auth: Record<string, string> = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const base = section === 'chat' ? '/api/admin/chat-prompt' : '/api/admin/explain-prompt';
  const Icon = section === 'chat' ? MessageSquareText : Sparkles;

  const [saved, setSaved] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const [showTpl, setShowTpl] = useState(false);
  const [tpl, setTpl] = useState<{ content: string; canEdit: boolean; coursesOnTemplate?: number } | null>(null);
  const [tplEditing, setTplEditing] = useState(false);
  const [tplDraft, setTplDraft] = useState('');
  const [tplSaving, setTplSaving] = useState(false);
  const [tplMsg, setTplMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const hasOwn = saved.trim().length > 0;
  const dirty = draft !== saved;

  useEffect(() => {
    setSaved(''); setDraft(''); setMsg(null); setConfirmClear(false);
    if (!courseId || !accessToken) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${base}?courseId=${encodeURIComponent(courseId)}`, { headers: auth })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => {
        if (cancelled) return;
        // Alleen de EIGEN instructie komt in het veld; het sjabloon nooit.
        const own = d.hasOverride ? String(d.content || '') : '';
        setSaved(own); setDraft(own);
      })
      .catch(() => { if (!cancelled) setMsg({ ok: false, text: t('coursePrompts.loadError') }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, accessToken, section]);

  const loadTemplate = async () => {
    try {
      const r = await fetch(`/api/admin/prompt-templates/${section}`, { headers: auth });
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      setTpl({ content: d.content || '', canEdit: !!d.canEdit, coursesOnTemplate: d.coursesOnTemplate });
    } catch {
      setTplMsg({ ok: false, text: t('coursePrompts.templateLoadError') });
    }
  };

  const toggleTemplate = async () => {
    const next = !showTpl;
    setShowTpl(next);
    setTplEditing(false); setTplMsg(null); setCopied(false);
    if (next && !tpl) await loadTemplate();
  };

  const save = async () => {
    if (!courseId || !draft.trim()) return;
    setSaving(true); setMsg(null);
    try {
      const r = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ courseId, content: draft }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || String(r.status));
      setSaved(draft);
      setMsg({ ok: true, text: t('coursePrompts.saved') });
    } catch (e) {
      setMsg({ ok: false, text: `${t('coursePrompts.saveError')} ${(e as Error).message}` });
    }
    setSaving(false);
  };

  const clearOwn = async () => {
    if (!courseId) return;
    setSaving(true); setMsg(null);
    try {
      const r = await fetch(`${base}/${encodeURIComponent(courseId)}`, { method: 'DELETE', headers: auth });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || String(r.status));
      setSaved(''); setDraft(''); setConfirmClear(false);
      setMsg({ ok: true, text: t('coursePrompts.cleared') });
    } catch (e) {
      setMsg({ ok: false, text: `${t('coursePrompts.saveError')} ${(e as Error).message}` });
    }
    setSaving(false);
  };

  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(tpl?.content || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setTplMsg({ ok: false, text: t('coursePrompts.copyError') });
    }
  };

  const saveTemplate = async () => {
    setTplSaving(true); setTplMsg(null);
    try {
      const r = await fetch(`/api/admin/prompt-templates/${section}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ content: tplDraft }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || String(r.status));
      setTpl(prev => (prev ? { ...prev, content: tplDraft } : prev));
      setTplEditing(false);
      setTplMsg({ ok: true, text: t('coursePrompts.templateSaved') });
    } catch (e) {
      setTplMsg({ ok: false, text: `${t('coursePrompts.saveError')} ${(e as Error).message}` });
    }
    setTplSaving(false);
  };

  const featureOff = features[section] === false;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 space-y-3" data-testid={`prompt-block-${section}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon className="w-5 h-5 text-blue-600 flex-shrink-0" />
        <h3 className="text-base font-bold text-gray-900">{t(`coursePrompts.${section}.title`)}</h3>
        <HelpTip id="chatInstructions.perCourse" />
        {courseId && !loading && (
          hasOwn ? (
            <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 whitespace-nowrap" data-testid={`status-prompt-own-${section}`}>
              {t('coursePrompts.statusOwn')}
            </span>
          ) : null
        )}
        {featureOff && (
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 whitespace-nowrap">
            {t('coursePrompts.featureOff')}
          </span>
        )}
      </div>
      <AdminHint variant="intro">{t(`coursePrompts.${section}.desc`)}</AdminHint>

      {courseId && !loading && !hasOwn && (
        <AdminHint variant="warning" testId={`warning-prompt-template-${section}`}>
          {t('coursePrompts.usingTemplate')}
        </AdminHint>
      )}

      {courseId && (loading ? (
        <p className="text-sm text-gray-400 italic">{t('common.loading')}</p>
      ) : (
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={10}
          placeholder={t('coursePrompts.placeholder')}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-500"
          data-testid={`textarea-prompt-${section}`}
        />
      ))}

      {msg && (
        <p className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-700'}`} data-testid={`text-prompt-msg-${section}`}>{msg.text}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {courseId && (
          <button
            onClick={save}
            disabled={saving || loading || !draft.trim() || !dirty}
            className="whitespace-nowrap rounded-lg bg-blue-600 px-4 py-1.5 text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            data-testid={`button-save-prompt-${section}`}
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        )}
        <button
          onClick={toggleTemplate}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-300 bg-white px-4 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-50"
          data-testid={`button-toggle-template-${section}`}
          aria-expanded={showTpl}
        >
          {showTpl ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          {showTpl ? t('coursePrompts.hideTemplate') : t('coursePrompts.showTemplate')}
        </button>
        {courseId && hasOwn && (confirmClear ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="text-sm text-red-700">{t('coursePrompts.clearConfirm')}</span>
            <button onClick={clearOwn} disabled={saving} className="whitespace-nowrap rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50" data-testid={`button-confirm-clear-prompt-${section}`}>
              {t('coursePrompts.clear')}
            </button>
            <button onClick={() => setConfirmClear(false)} className="whitespace-nowrap rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
              {t('common.cancelAction')}
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirmClear(true)}
            disabled={saving}
            className="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
            data-testid={`button-clear-prompt-${section}`}
          >
            {t('coursePrompts.clear')}
          </button>
        ))}
      </div>

      {showTpl && (
        <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3" data-testid={`template-panel-${section}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Lock className="w-4 h-4 text-gray-500 flex-shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-sm font-semibold text-gray-800">{t('coursePrompts.templateTitle')}</p>
            {tpl && !tplEditing && (
              <button onClick={copyTemplate} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-300 bg-white px-3 py-1 text-sm text-gray-700 hover:bg-gray-100" data-testid={`button-copy-template-${section}`}>
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? t('coursePrompts.copied') : t('coursePrompts.copy')}
              </button>
            )}
            {tpl?.canEdit && !tplEditing && (
              <button
                onClick={() => { setTplDraft(tpl.content); setTplEditing(true); setTplMsg(null); }}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-amber-300 bg-white px-3 py-1 text-sm text-amber-800 hover:bg-amber-50"
                data-testid={`button-edit-template-${section}`}
              >
                <Pencil className="w-4 h-4" />
                {t('coursePrompts.editTemplate')}
              </button>
            )}
          </div>
          <AdminHint variant="intro">{t(tpl?.canEdit ? 'coursePrompts.templateIntroAdmin' : 'coursePrompts.templateIntro')}</AdminHint>
          {!tpl && !tplMsg && <p className="text-sm text-gray-400 italic">{t('common.loading')}</p>}
          {tpl && tplEditing && (
            <AdminHint variant="warning" testId={`warning-template-edit-${section}`}>
              {t('coursePrompts.templateEditWarning', { count: String(tpl.coursesOnTemplate ?? 0) })}
            </AdminHint>
          )}
          {tpl && (
            <textarea
              value={tplEditing ? tplDraft : tpl.content}
              onChange={e => setTplDraft(e.target.value)}
              readOnly={!tplEditing}
              rows={12}
              className={`w-full rounded-lg border px-3 py-2 font-mono text-sm outline-none ${tplEditing ? 'border-amber-300 bg-white focus:ring-2 focus:ring-amber-400' : 'border-gray-200 bg-gray-100 text-gray-700'}`}
              data-testid={`textarea-template-${section}`}
            />
          )}
          {tplMsg && <p className={`text-sm ${tplMsg.ok ? 'text-green-700' : 'text-red-700'}`}>{tplMsg.text}</p>}
          {tplEditing && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={saveTemplate}
                disabled={tplSaving || tplDraft.trim().length < 10 || tplDraft === tpl?.content}
                className="whitespace-nowrap rounded-lg bg-amber-600 px-4 py-1.5 text-sm text-white hover:bg-amber-700 disabled:opacity-50"
                data-testid={`button-save-template-${section}`}
              >
                {tplSaving ? t('common.saving') : t('coursePrompts.saveTemplate')}
              </button>
              <button
                onClick={() => { setTplEditing(false); setTplMsg(null); }}
                className="whitespace-nowrap rounded-lg border border-gray-300 bg-white px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                data-testid={`button-cancel-template-${section}`}
              >
                {t('common.cancelAction')}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
