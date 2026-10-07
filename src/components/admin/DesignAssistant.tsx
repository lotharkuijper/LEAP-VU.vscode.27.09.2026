import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Send, Loader2, Copy, Check, RotateCcw, Settings2 } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { useAuth } from '../../contexts/AuthContext';
import { MarkdownMessage } from '../MarkdownMessage';
import { HelpTip } from '../help/HelpTip';
import { AdminHint } from '../help/AdminHint';
import { Tooltip } from '../help/Tooltip';

interface Msg { role: 'user' | 'assistant'; content: string }
interface Config { enabled: boolean; isAdmin: boolean; prompt?: string; isDefaultPrompt?: boolean }

const STARTERS = ['admin.designAssistant.starter.goals', 'admin.designAssistant.starter.check', 'admin.designAssistant.starter.project'] as const;
const storageKey = (courseId: string) => `leap-design-assistant-${courseId}`;

/** Bewaarde gesprekken per cursus, alleen in dit browsertabblad. */
function loadHistory(courseId: string): Msg[] {
  try { return JSON.parse(sessionStorage.getItem(storageKey(courseId)) || '[]'); } catch { return []; }
}
function saveHistory(courseId: string, msgs: Msg[]) {
  try { sessionStorage.setItem(storageKey(courseId), JSON.stringify(msgs.slice(-40))); } catch { /* niet erg */ }
}

/**
 * Ontwerphulp — een optionele gesprekspartner voor docenten die hun cursus
 * inrichten. De bot kent LEAP (hulpteksten, handleiding, onderdelen van het
 * beheer) en de actuele stand van deze cursus, en levert voorstellen en
 * concepten die de docent zelf overneemt. Hij verandert zelf niets.
 */
export function DesignAssistant({ courseId, courseName, onNavigate }: {
  courseId: string | null;
  courseName?: string | null;
  /** Naar een ander tabblad van het beheer (links in antwoorden). */
  onNavigate: (tab: string) => void;
}) {
  const { t, lang } = useLanguage();
  const { session } = useAuth();
  const navigate = useNavigate();
  const token = session?.access_token;
  const [config, setConfig] = useState<Config | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const loadConfig = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch('/api/admin/design-assistant/config', { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setConfig(await r.json());
    } catch { /* toon niets */ }
  }, [token]);
  useEffect(() => { void loadConfig(); }, [loadConfig]);
  useEffect(() => { setMessages(courseId ? loadHistory(courseId) : []); setError(null); }, [courseId]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' }); }, [messages, busy]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || !courseId || !token || busy) return;
    const next: Msg[] = [...messages, { role: 'user', content: q }];
    setMessages(next); saveHistory(courseId, next); setInput(''); setBusy(true); setError(null);
    try {
      const r = await fetch('/api/admin/design-assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ courseId, messages: next, lang }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || t('admin.designAssistant.failed'));
      const withReply: Msg[] = [...next, { role: 'assistant', content: d.reply }];
      setMessages(withReply); saveHistory(courseId, withReply);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => { if (courseId) saveHistory(courseId, []); setMessages([]); setError(null); };

  const copy = async (i: number) => {
    try { await navigator.clipboard.writeText(messages[i].content); setCopied(i); setTimeout(() => setCopied(null), 1500); } catch { /* */ }
  };

  // Links in antwoorden naar het beheer openen in dit venster.
  const onLinkClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href') || '';
    if (!href.startsWith('/')) return;
    e.preventDefault();
    const m = href.match(/^\/admin\?tab=([a-z_]+)/);
    if (m) onNavigate(m[1]);
    else navigate(href);
  };

  if (config && !config.enabled && !config.isAdmin) {
    return <div className="chic-card p-6"><AdminHint variant="intro">{t('admin.designAssistant.off')}</AdminHint></div>;
  }

  return (
    <div className="space-y-4" data-testid="panel-design-assistant">
      <div className="chic-card p-5">
        <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-brand-600" />{t('admin.designAssistant.title')}<HelpTip id="designAssistant.overview" />
        </h2>
        <AdminHint variant="intro" className="mt-1 max-w-3xl">{t('admin.designAssistant.intro')}</AdminHint>
        {config && !config.enabled && config.isAdmin && (
          <AdminHint variant="warning" className="mt-2">{t('admin.designAssistant.offAdmin')}</AdminHint>
        )}
      </div>

      {!courseId ? (
        <div className="chic-card p-6 text-sm text-gray-600">{t('admin.designAssistant.noCourse')}</div>
      ) : (
        <div className="chic-card flex flex-col p-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
            <span className="min-w-0 text-sm text-gray-600">{t('admin.designAssistant.forCourse', { course: courseName || '' })}</span>
            {messages.length > 0 && (
              <button type="button" onClick={reset} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100" data-testid="button-design-reset">
                <RotateCcw className="h-3.5 w-3.5" />{t('admin.designAssistant.newConversation')}
              </button>
            )}
          </div>

          <div className="max-h-[60vh] min-h-[16rem] space-y-3 overflow-y-auto px-4 py-4" onClickCapture={onLinkClick} data-testid="list-design-messages">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-sm text-gray-600">{t('admin.designAssistant.empty')}</p>
                <div className="flex flex-wrap gap-2">
                  {STARTERS.map(k => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => void send(t(k))}
                      disabled={busy || (config ? !config.enabled : false)}
                      className="rounded-full border border-brand-200 bg-brand-50 px-3 py-1.5 text-left text-xs text-brand-800 hover:bg-brand-100 disabled:opacity-50"
                      data-testid={`button-design-starter-${k.split('.').pop()}`}
                    >
                      {t(k)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              m.role === 'user' ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-brand-600 px-3.5 py-2 text-sm text-white">{m.content}</div>
                </div>
              ) : (
                <div key={i} className="max-w-full rounded-2xl bg-gray-50 px-4 py-3 text-sm text-gray-800" data-testid={`design-reply-${i}`}>
                  <MarkdownMessage content={m.content} />
                  <div className="mt-2 flex justify-end">
                    <Tooltip label={copied === i ? t('admin.designAssistant.copied') : t('admin.designAssistant.copy')}>
                      <button type="button" onClick={() => void copy(i)} className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700">
                        {copied === i ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </Tooltip>
                  </div>
                </div>
              )
            ))}
            {busy && (
              <p className="flex items-center gap-2 text-sm text-gray-500" data-testid="text-design-busy">
                <Loader2 className="h-4 w-4 animate-spin" />{t('admin.designAssistant.thinking')}
              </p>
            )}
            {error && <p className="text-sm text-red-700" data-testid="text-design-error">{error}</p>}
            <div ref={endRef} />
          </div>

          <form
            className="flex items-end gap-2 border-t border-gray-100 p-3"
            onSubmit={e => { e.preventDefault(); void send(input); }}
          >
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }}
              rows={2}
              placeholder={t('admin.designAssistant.placeholder')}
              aria-label={t('admin.designAssistant.placeholder')}
              disabled={config ? !config.enabled : false}
              className="min-w-0 flex-1 resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm"
              data-testid="input-design-question"
            />
            <Tooltip label={t('admin.designAssistant.send')}>
              <button
                type="submit"
                disabled={busy || !input.trim() || (config ? !config.enabled : false)}
                className="rounded-lg bg-brand-600 p-2.5 text-white hover:bg-brand-700 disabled:opacity-40"
                data-testid="button-design-send"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </Tooltip>
          </form>
        </div>
      )}

      {config?.isAdmin && <DesignAssistantAdmin config={config} token={token} onSaved={loadConfig} />}
    </div>
  );
}

/** Alleen voor de beheerder: aan/uit en de instructie van de bot. */
function DesignAssistantAdmin({ config, token, onSaved }: { config: Config; token?: string; onSaved: () => void }) {
  const { t } = useLanguage();
  const [prompt, setPrompt] = useState(config.prompt || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { setPrompt(config.prompt || ''); }, [config.prompt]);

  const save = async (body: Record<string, unknown>) => {
    if (!token) return;
    setSaving(true); setMsg(null);
    try {
      const r = await fetch('/api/admin/design-assistant/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || t('admin.designAssistant.admin.saveFailed'));
      setMsg(t('admin.designAssistant.admin.saved'));
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="chic-card p-5" data-testid="panel-design-assistant-admin">
      <summary className="cursor-pointer text-sm font-semibold text-gray-800 inline-flex items-center gap-2">
        <Settings2 className="h-4 w-4" />{t('admin.designAssistant.admin.title')}
      </summary>
      <div className="mt-3 space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={e => void save({ enabled: e.target.checked })}
            disabled={saving}
            data-testid="checkbox-design-enabled"
          />
          {t('admin.designAssistant.admin.enabled')}
        </label>
        <div>
          <label htmlFor="textarea-design-prompt" className="text-xs font-medium text-gray-700">
            {t('admin.designAssistant.admin.prompt')}{config.isDefaultPrompt ? ` (${t('admin.designAssistant.admin.default')})` : ''}
          </label>
          <textarea
            id="textarea-design-prompt"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={14}
            className="w-full rounded border border-gray-300 px-3 py-2 font-mono text-xs"
            data-testid="textarea-design-prompt"
          />
          <p className="mt-1 text-[11px] text-gray-500">{t('admin.designAssistant.admin.promptHint')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void save({ prompt })} disabled={saving} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm text-white hover:bg-brand-700 disabled:opacity-40" data-testid="button-design-prompt-save">
            {saving ? t('common.busy') : t('common.save')}
          </button>
          {!config.isDefaultPrompt && (
            <button type="button" onClick={() => void save({ prompt: null })} disabled={saving} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50" data-testid="button-design-prompt-reset">
              {t('admin.designAssistant.admin.resetPrompt')}
            </button>
          )}
          {msg && <span className="text-xs text-gray-600">{msg}</span>}
        </div>
      </div>
    </details>
  );
}
