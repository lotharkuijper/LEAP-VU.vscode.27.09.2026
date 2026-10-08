import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Send, Loader2, Copy, Check, RotateCcw, Settings2, X, MapPin, HelpCircle } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { useAuth } from '../../contexts/AuthContext';
import { MarkdownMessage } from '../MarkdownMessage';
import { HelpTip } from '../help/HelpTip';
import { Tooltip } from '../help/Tooltip';

interface Msg { role: 'user' | 'assistant'; content: string }
interface Config { enabled: boolean; isAdmin: boolean; prompt?: string; isDefaultPrompt?: boolean }
/** Waar de docent in het beheer is; gaat mee naar de bot. */
export interface DesignContext { tab: string; step?: string | null; view?: string | null }

const STARTERS = ['admin.designAssistant.starter.goals', 'admin.designAssistant.starter.check', 'admin.designAssistant.starter.project'] as const;
const OPEN_KEY = 'leap-design-assistant-open';
const historyKey = (courseId: string) => `leap-design-assistant-${courseId}`;
/** Breedte van het paneel; ook gebruikt om het takenvak opzij te schuiven. */
export const DESIGN_PANEL_WIDTH = '24rem';

function loadHistory(courseId: string): Msg[] {
  try { return JSON.parse(sessionStorage.getItem(historyKey(courseId)) || '[]'); } catch { return []; }
}
function saveHistory(courseId: string, msgs: Msg[]) {
  try { sessionStorage.setItem(historyKey(courseId), JSON.stringify(msgs.slice(-40))); } catch { /* niet erg */ }
}
function readOpen(): boolean {
  try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
}

/**
 * Ontwerphulp — een optionele gesprekspartner in heel Beheer. Dicht: een smal
 * lipje aan de rechterrand. Open: een zijpaneel dat blijft staan terwijl je van
 * onderdeel wisselt, zodat je het gesprek in beeld houdt tijdens het werk. De
 * bot krijgt mee waar je bent (onderdeel + stap) en verandert zelf niets.
 */
export function DesignAssistantDock({ courseId, courseName, place, context, onNavigate, onOpenChange }: {
  courseId: string | null;
  courseName?: string | null;
  /** Leesbare plek, bv. "Cursusmateriaal → Begrippen". */
  place: string;
  context: DesignContext;
  /** Naar een ander onderdeel van het beheer (links in antwoorden). */
  onNavigate: (tab: string) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t, lang } = useLanguage();
  const { session } = useAuth();
  const navigate = useNavigate();
  const token = session?.access_token;
  const [open, setOpenState] = useState<boolean>(readOpen);
  const [config, setConfig] = useState<Config | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const setOpen = (v: boolean) => {
    setOpenState(v);
    try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* */ }
  };

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

  const available = !!config && (config.enabled || config.isAdmin);
  const visibleOpen = open && available;

  // Laat de pagina (opschuiven) en het takenvak weten dat het paneel open is.
  useEffect(() => {
    onOpenChange?.(visibleOpen);
    const root = document.documentElement;
    if (visibleOpen) root.style.setProperty('--leap-side-panel', DESIGN_PANEL_WIDTH);
    else root.style.removeProperty('--leap-side-panel');
    return () => { root.style.removeProperty('--leap-side-panel'); };
  }, [visibleOpen, onOpenChange]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || !courseId || !token || busy) return;
    const next: Msg[] = [...messages, { role: 'user', content: q }];
    setMessages(next); saveHistory(courseId, next); setInput(''); setBusy(true); setError(null);
    try {
      const r = await fetch('/api/admin/design-assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ courseId, messages: next, lang, context }),
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

  // Links in antwoorden bedienen het beheer achter het paneel; het paneel blijft open.
  const onLinkClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href') || '';
    if (!href.startsWith('/')) return;
    e.preventDefault();
    const m = href.match(/^\/admin\?tab=([a-z_]+)/);
    if (m) onNavigate(m[1]);
    else navigate(href);
  };

  if (!available) return null;

  if (!visibleOpen) {
    return (
      <button
          type="button"
          onClick={() => setOpen(true)}
          title={t('admin.designAssistant.openTooltip')}
          className="fixed right-0 top-1/2 z-40 -translate-y-1/2 rounded-l-xl border border-r-0 border-brand-200 bg-white px-1.5 py-3 text-brand-700 shadow-lg hover:bg-brand-50"
          data-testid="button-design-open"
        >
          <span className="flex flex-col items-center gap-2">
            <Sparkles className="h-4 w-4" />
            <span className="text-xs font-semibold [writing-mode:vertical-rl] rotate-180">{t('admin.designAssistant.title')}</span>
          </span>
        </button>
    );
  }

  const enabled = config!.enabled;
  return (
    <aside
      className="fixed bottom-0 right-0 top-16 z-40 flex w-full flex-col border-l border-gray-200 bg-white shadow-2xl sm:w-[24rem]"
      aria-label={t('admin.designAssistant.title')}
      data-testid="panel-design-assistant"
    >
      <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
        <Sparkles className="h-4 w-4 flex-shrink-0 text-brand-600" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-bold text-gray-900">{t('admin.designAssistant.title')}</h2>
        <HelpTip id="designAssistant.overview" />
        {messages.length > 0 && !showSettings && (
          <Tooltip label={t('admin.designAssistant.newConversation')}>
            <button type="button" onClick={reset} className="rounded p-1.5 text-gray-500 hover:bg-gray-100" data-testid="button-design-reset">
              <RotateCcw className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
        {config!.isAdmin && (
          <Tooltip label={t('admin.designAssistant.admin.title')}>
            <button type="button" onClick={() => setShowSettings(s => !s)} aria-pressed={showSettings} className={`rounded p-1.5 hover:bg-gray-100 ${showSettings ? 'text-brand-700' : 'text-gray-500'}`} data-testid="button-design-settings">
              <Settings2 className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
        <Tooltip label={t('admin.designAssistant.close')}>
          <button type="button" onClick={() => setOpen(false)} className="rounded p-1.5 text-gray-500 hover:bg-gray-100" data-testid="button-design-close">
            <X className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {showSettings && config!.isAdmin ? (
        <div className="flex-1 overflow-y-auto p-4">
          <DesignAssistantAdmin config={config!} token={token} onSaved={loadConfig} />
        </div>
      ) : (
        <>
          <div className="space-y-1 border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs text-gray-600">
            <p className="flex items-center gap-1.5" data-testid="text-design-place">
              <MapPin className="h-3.5 w-3.5 flex-shrink-0 text-brand-600" />
              <span className="min-w-0">{t('admin.designAssistant.youAreAt', { place })}{courseName ? ` · ${courseName}` : ''}</span>
            </p>
            {!enabled && <p className="text-amber-700">{t('admin.designAssistant.offAdmin')}</p>}
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" onClickCapture={onLinkClick} data-testid="list-design-messages">
            {!courseId ? (
              <p className="text-sm text-gray-600">{t('admin.designAssistant.noCourse')}</p>
            ) : (
              <>
                {messages.length === 0 && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-600">{t('admin.designAssistant.introShort')}</p>
                    <div className="flex flex-col items-start gap-2">
                      {STARTERS.map(k => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => void send(t(k))}
                          disabled={busy || !enabled}
                          className="rounded-2xl border border-brand-200 bg-brand-50 px-3 py-1.5 text-left text-xs text-brand-800 hover:bg-brand-100 disabled:opacity-50"
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
                      <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl bg-brand-600 px-3 py-2 text-sm text-white">{m.content}</div>
                    </div>
                  ) : (
                    <div key={i} className="rounded-2xl bg-gray-50 px-3 py-2.5 text-sm text-gray-800" data-testid={`design-reply-${i}`}>
                      <MarkdownMessage content={m.content} />
                      <div className="mt-1 flex justify-end">
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
              </>
            )}
            <div ref={endRef} />
          </div>

          {courseId && (
            <div className="border-t border-gray-100 p-3">
              <button
                type="button"
                onClick={() => void send(t('admin.designAssistant.explainHereQuestion', { place }))}
                disabled={busy || !enabled}
                className="mb-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50"
                data-testid="button-design-explain-here"
              >
                <HelpCircle className="h-3.5 w-3.5" />{t('admin.designAssistant.explainHere')}
              </button>
              <form className="flex items-end gap-2" onSubmit={e => { e.preventDefault(); void send(input); }}>
                <textarea
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }}
                  rows={2}
                  placeholder={t('admin.designAssistant.placeholder')}
                  aria-label={t('admin.designAssistant.placeholder')}
                  disabled={!enabled}
                  className="min-w-0 flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  data-testid="input-design-question"
                />
                <Tooltip label={t('admin.designAssistant.send')}>
                  <button
                    type="submit"
                    disabled={busy || !input.trim() || !enabled}
                    className="rounded-lg bg-brand-600 p-2.5 text-white hover:bg-brand-700 disabled:opacity-40"
                    data-testid="button-design-send"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                </Tooltip>
              </form>
            </div>
          )}
        </>
      )}
    </aside>
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
    <div className="space-y-3" data-testid="panel-design-assistant-admin">
      <h3 className="text-sm font-semibold text-gray-800">{t('admin.designAssistant.admin.title')}</h3>
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
          rows={16}
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
  );
}
