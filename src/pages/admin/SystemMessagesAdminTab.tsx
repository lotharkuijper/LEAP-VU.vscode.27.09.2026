import { useEffect, useState } from 'react';
import { Megaphone, Send, Loader2, StopCircle, Trash2 } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { AdminHint } from '../../components/help/AdminHint';
import { HelpTip } from '../../components/help/HelpTip';
import { ListRow } from '../../components/ui/ListRow';
import { SystemMessages } from '../../components/SystemMessages';
import { loadSystemMessages } from '../../lib/systemMessages';

// Beheer → Berichten (alleen beheerder): systeemberichten op het Dashboard
// (server/system/systemMessages.js). Eenrichtingsverkeer; je ziet alleen totalen.

type TKey = Parameters<ReturnType<typeof useLanguage>['t']>[0];
type Audience = 'all' | 'students' | 'teachers' | 'course';

interface AdminMessage {
  id: string;
  title: string;
  body: string;
  kind: 'info' | 'warning';
  audience: Audience;
  course_id: string | null;
  course_name: string | null;
  course_role: 'students' | 'all' | null;
  starts_at: string;
  ends_at: string | null;
  created_at: string;
  status: 'scheduled' | 'active' | 'ended';
  recipients: number;
  dismissed: number;
}

const EMPTY = { title: '', body: '', kind: 'info' as 'info' | 'warning', audience: 'all' as Audience, courseId: '', courseRole: 'students' as 'students' | 'all', startsAt: '', endsAt: '' };

export function SystemMessagesAdminTab() {
  const { t, lang } = useLanguage();
  const tk = (k: string, v?: Record<string, string>) => t(k as TKey, v);
  const { session } = useAuth();
  const token = session?.access_token;
  const [form, setForm] = useState(EMPTY);
  const [courses, setCourses] = useState<Array<{ id: string; name: string }>>([]);
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);

  const api = async (url: string, init: RequestInit = {}) => {
    const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };
  const load = async () => {
    if (!token) return;
    try {
      const d = await api('/api/admin/messages');
      setMessages(d.messages || []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => {
    void load();
    supabase.from('courses').select('id, name').order('name').then(({ data }) => setCourses(data || []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const send = async () => {
    setBusy(true); setError(null); setSent(false);
    try {
      await api('/api/admin/messages', {
        method: 'POST',
        body: JSON.stringify({
          title: form.title, body: form.body, kind: form.kind, audience: form.audience,
          ...(form.audience === 'course' ? { courseId: form.courseId, courseRole: form.courseRole } : {}),
          ...(form.startsAt ? { startsAt: new Date(form.startsAt).toISOString() } : {}),
          ...(form.endsAt ? { endsAt: new Date(form.endsAt).toISOString() } : {}),
        }),
      });
      await load();
      setForm(EMPTY); setSent(true); setConfirmSend(false);
      void loadSystemMessages();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const act = async (url: string, method: 'POST' | 'DELETE') => {
    setBusy(true); setError(null);
    try { await api(url, { method }); await load(); void loadSystemMessages(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const audienceLabel = (m: { audience: Audience; course_name?: string | null; course_role?: string | null }) => m.audience === 'course'
    ? tk(m.course_role === 'all' ? 'admin.messages.audience.courseAll' : 'admin.messages.audience.courseStudents', { course: m.course_name || '?' })
    : tk(`admin.messages.audience.${m.audience}`);
  const canSend = form.title.trim() && (form.audience !== 'course' || form.courseId) && !busy;
  const preview = form.title.trim() ? [{ id: 'preview', title: form.title, body: form.body, kind: form.kind, starts_at: new Date().toISOString(), ends_at: null }] : [];

  return (
    <div className="space-y-5" data-testid="panel-system-messages-admin">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
          <Megaphone className="h-5 w-5 text-blue-600" aria-hidden />
          {t('admin.messages.title')}
          <HelpTip id="systemMessages.compose" />
        </h2>
        <AdminHint variant="intro" className="mt-1">{t('admin.messages.intro')}</AdminHint>
      </div>

      <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
        <label className="block text-sm font-medium text-gray-900">
          {t('admin.messages.titleLabel')}
          <input value={form.title} maxLength={120} onChange={(e) => setForm({ ...form, title: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder={t('admin.messages.titlePlaceholder')} data-testid="input-message-title" />
        </label>
        <label className="block text-sm font-medium text-gray-900">
          {t('admin.messages.bodyLabel')}
          <textarea value={form.body} maxLength={2000} rows={4} onChange={(e) => setForm({ ...form, body: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder={t('admin.messages.bodyPlaceholder')} data-testid="input-message-body" />
        </label>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] gap-3">
          <label className="block text-sm font-medium text-gray-900">
            {t('admin.messages.kindLabel')}
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'info' | 'warning' })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" data-testid="select-message-kind">
              <option value="info">{t('admin.messages.kind.info')}</option>
              <option value="warning">{t('admin.messages.kind.warning')}</option>
            </select>
          </label>
          <label className="block text-sm font-medium text-gray-900">
            {t('admin.messages.audienceLabel')}
            <select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as Audience })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" data-testid="select-message-audience">
              {(['all', 'students', 'teachers', 'course'] as const).map((a) => <option key={a} value={a}>{tk(`admin.messages.audienceOption.${a}`)}</option>)}
            </select>
          </label>
          {form.audience === 'course' && (
            <>
              <label className="block text-sm font-medium text-gray-900">
                {t('admin.messages.courseLabel')}
                <select value={form.courseId} onChange={(e) => setForm({ ...form, courseId: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" data-testid="select-message-course">
                  <option value="">{t('admin.messages.chooseCourse')}</option>
                  {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="block text-sm font-medium text-gray-900">
                {t('admin.messages.courseRoleLabel')}
                <select value={form.courseRole} onChange={(e) => setForm({ ...form, courseRole: e.target.value as 'students' | 'all' })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" data-testid="select-message-course-role">
                  <option value="students">{t('admin.messages.courseRole.students')}</option>
                  <option value="all">{t('admin.messages.courseRole.all')}</option>
                </select>
              </label>
            </>
          )}
          <label className="block text-sm font-medium text-gray-900">
            {t('admin.messages.startsLabel')}
            <input type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" data-testid="input-message-starts" />
            <span className="block text-xs font-normal text-gray-500">{t('admin.messages.startsHint')}</span>
          </label>
          <label className="block text-sm font-medium text-gray-900">
            {t('admin.messages.endsLabel')}
            <input type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" data-testid="input-message-ends" />
            <span className="block text-xs font-normal text-gray-500">{t('admin.messages.endsHint')}</span>
          </label>
        </div>

        {preview.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{t('admin.messages.preview')}</p>
            <div className="pointer-events-none"><SystemMessages messages={preview} translate={false} /></div>
          </div>
        )}

        {confirmSend ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1">{tk('admin.messages.confirm', { audience: audienceLabel({ audience: form.audience, course_name: courses.find((c) => c.id === form.courseId)?.name, course_role: form.courseRole }) })}</span>
            <button type="button" disabled={!canSend} onClick={send} className="flex whitespace-nowrap items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50" data-testid="button-confirm-send-message">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{t('admin.messages.sendNow')}
            </button>
            <button type="button" onClick={() => setConfirmSend(false)} className="whitespace-nowrap rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-gray-700">{t('common.cancelAction')}</button>
          </div>
        ) : (
          <button type="button" disabled={!canSend} onClick={() => setConfirmSend(true)} className="flex whitespace-nowrap items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50" data-testid="button-send-message">
            <Send className="h-4 w-4" />{t('admin.messages.send')}
          </button>
        )}
        {sent && <p className="text-sm text-accent-700" data-testid="text-message-sent">{t('admin.messages.sent')}</p>}
        {error && <p className="text-sm text-red-700" data-testid="text-message-error">{error}</p>}
      </div>

      <div className="space-y-2">
        <h3 className="font-semibold text-gray-900">{t('admin.messages.listTitle')}</h3>
        {messages.length === 0 ? (
          <p className="text-sm text-gray-500">{t('admin.messages.none')}</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
            {messages.map((m) => (
              <li key={m.id} className="px-4 py-3" data-testid={`row-message-${m.id}`}>
                <ListRow
                  title={m.title}
                  badges={<>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${m.status === 'active' ? 'bg-emerald-100 text-emerald-800' : m.status === 'scheduled' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>{tk(`admin.messages.status.${m.status}`)}</span>
                    {m.kind === 'warning' && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">{t('admin.messages.kind.warning')}</span>}
                  </>}
                  meta={<>
                    <span className="block">{audienceLabel(m)} · {tk('admin.messages.counts', { recipients: String(m.recipients), dismissed: String(m.dismissed) })}</span>
                    <span className="block">{fmt(m.starts_at)}{m.ends_at ? ` – ${fmt(m.ends_at)}` : ''}</span>
                  </>}
                  actions={[
                    ...(m.status !== 'ended' ? [{ key: 'end', label: t('admin.messages.end'), icon: StopCircle, disabled: busy, onClick: () => act(`/api/admin/messages/${m.id}/end`, 'POST'), testId: `button-end-message-${m.id}` }] : []),
                    { key: 'delete', label: t('admin.messages.delete'), icon: Trash2, tone: 'danger' as const, inMenu: true, disabled: busy, onClick: () => act(`/api/admin/messages/${m.id}`, 'DELETE') },
                  ]}
                  menuTestId={`menu-message-${m.id}`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
