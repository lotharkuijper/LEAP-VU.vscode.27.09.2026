import { useEffect, useState } from 'react';
import { Gauge, Loader2, Save } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { useAuth } from '../../contexts/AuthContext';
import { HelpTip } from '../../components/help/HelpTip';
import { AdminHint } from '../../components/help/AdminHint';

// Beheer → Instellingen: tokenbudget voor accounts uit open registratie
// (GET/PUT /api/admin/token-budget, server/account/tokenBudget.js). Alleen totalen,
// nooit verbruik per persoon.
interface Settings { weekTokens: number; dayTokens: number; openWeekTotal: number; registrationsPerHourAlert: number }

export function TokenBudgetPanel() {
  const { t } = useLanguage();
  const { session } = useAuth();
  const token = session?.access_token;
  const [s, setS] = useState<Settings | null>(null);
  const [info, setInfo] = useState<{ openWeekUsed: number; openAccounts: number; tokensPerHour: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch('/api/admin/token-budget', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) { setS(d.settings); setInfo({ openWeekUsed: d.openWeekUsed, openAccounts: d.openAccounts, tokensPerHour: d.tokensPerHour }); } })
      .catch(() => {});
  }, [token]);

  const save = async () => {
    if (!s || !token) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/admin/token-budget', {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(s),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || t('tokenBudget.admin.saveFailed'));
      setS(d.settings);
      setMsg({ ok: true, text: t('tokenBudget.admin.saved') });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const fmt = (n: number) => n.toLocaleString(t('common.locale'));
  const hours = (n: number) => (info ? Math.round((10 * n) / info.tokensPerHour) / 10 : 0);
  const field = (key: keyof Settings, label: string, hint?: string) => (
    <label className="block">
      <span className="text-xs font-medium text-gray-700">{label}</span>
      <input
        type="number" min={1} value={s?.[key] ?? ''}
        onChange={e => s && setS({ ...s, [key]: Math.max(1, Math.round(Number(e.target.value) || 0)) })}
        className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
        data-testid={`input-token-budget-${key}`}
      />
      {hint && <span className="text-[11px] text-gray-500">{hint}</span>}
    </label>
  );

  return (
    <div className="p-4 border border-gray-200 rounded-lg space-y-3" data-testid="panel-token-budget">
      <h3 className="font-semibold text-gray-900 flex items-center gap-1.5"><Gauge className="w-4 h-4" />{t('tokenBudget.admin.title')}<HelpTip id="tokenBudget.settings" /></h3>
      <AdminHint variant="intro">{t('tokenBudget.admin.intro')}</AdminHint>
      {!s || !info ? (
        <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{t('common.loading')}</p>
      ) : (
        <>
          <p className="text-sm text-gray-700" data-testid="text-token-budget-usage">
            {t('tokenBudget.admin.usage', {
              accounts: String(info.openAccounts), used: fmt(info.openWeekUsed),
              pct: String(Math.floor((100 * info.openWeekUsed) / Math.max(1, s.openWeekTotal))),
            })}
          </p>
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(14rem,100%),1fr))]">
            {field('weekTokens', t('tokenBudget.admin.week'), t('tokenBudget.admin.hours', { hours: String(hours(s.weekTokens)) }))}
            {field('dayTokens', t('tokenBudget.admin.day'), t('tokenBudget.admin.hours', { hours: String(hours(s.dayTokens)) }))}
            {field('openWeekTotal', t('tokenBudget.admin.total'), t('tokenBudget.admin.totalHint'))}
            {field('registrationsPerHourAlert', t('tokenBudget.admin.regAlert'))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={save} disabled={busy} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50" data-testid="button-save-token-budget">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}{t('common.save')}
            </button>
            {msg && <span className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-700'}`} role="status">{msg.text}</span>}
          </div>
        </>
      )}
    </div>
  );
}
