import { useEffect, useState } from 'react';
import { Link2, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { useAuth } from '../../contexts/AuthContext';
import { HelpTip } from '../../components/help/HelpTip';
import { AdminHint } from '../../components/help/AdminHint';
import { Tooltip } from '../../components/help/Tooltip';

// Beheer → Instellingen: Canvas-omgevingen voor de LTI-koppeling
// (GET/PUT /api/admin/lti-platforms, server/lti/lti.js). Niets hiervan is geheim;
// de sleutel van LEAP zelf blijft in Key Vault en is voor inloggen niet nodig.
interface Platform { issuer: string; clientId: string; deploymentIds: string; authUrl: string; jwksUrl: string }
interface Attempt { issuer: string; clientId: string; deploymentId: string; at: string }
interface Info {
  env: Array<{ issuer: string; clientId: string }>;
  active: number;
  recentUnknown: Attempt[];
  configUrl: string;
}

const CLOUD = 'https://canvas.instructure.com';
const empty = (): Platform => ({ issuer: CLOUD, clientId: '', deploymentIds: '', authUrl: '', jwksUrl: '' });
const fromServer = (p: { issuer: string; clientId: string; deploymentIds: string[]; authUrl: string; jwksUrl: string }): Platform =>
  ({ ...p, deploymentIds: (p.deploymentIds || []).join(', ') });

export function CanvasPlatformsPanel() {
  const { t } = useLanguage();
  const { session } = useAuth();
  const token = session?.access_token;
  const [rows, setRows] = useState<Platform[] | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => {
    if (!token) return;
    fetch('/api/admin/lti-platforms', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) { setRows(d.saved.map(fromServer)); setInfo(d); } })
      .catch(() => {});
  };
  useEffect(load, [token]);

  const save = async (next: Platform[]) => {
    if (!token) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/admin/lti-platforms', {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ platforms: next }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || t('canvasPlatforms.saveFailed'));
      setRows(d.saved.map(fromServer));
      setInfo(i => (i ? { ...i, active: d.active } : i));
      setMsg({ ok: true, text: t('canvasPlatforms.saved') });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const update = (i: number, key: keyof Platform, value: string) =>
    setRows(rs => (rs ? rs.map((r, j) => (j === i ? { ...r, [key]: value } : r)) : rs));

  const adopt = (a: Attempt) => {
    const list = rows || [];
    const i = list.findIndex(r => r.issuer === a.issuer && r.clientId === a.clientId);
    if (i >= 0) {
      const deps = new Set(list[i].deploymentIds.split(',').map(s => s.trim()).filter(Boolean));
      if (a.deploymentId) deps.add(a.deploymentId);
      setRows(list.map((r, j) => (j === i ? { ...r, deploymentIds: [...deps].join(', ') } : r)));
    } else {
      setRows([...list, { ...empty(), issuer: a.issuer, clientId: a.clientId, deploymentIds: a.deploymentId }]);
    }
    setMsg({ ok: true, text: t('canvasPlatforms.adopted') });
  };

  const field = (i: number, key: keyof Platform, label: string, hint?: string) => (
    <label className="block min-w-0">
      <span className="text-xs font-medium text-gray-700">{label}</span>
      <input
        value={rows?.[i]?.[key] ?? ''}
        onChange={e => update(i, key, e.target.value)}
        className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-xs"
        data-testid={`input-lti-${key}-${i}`}
      />
      {hint && <span className="text-[11px] text-gray-500">{hint}</span>}
    </label>
  );

  return (
    <div className="p-4 border border-gray-200 rounded-lg space-y-3" data-testid="panel-canvas-platforms">
      <h3 className="font-semibold text-gray-900 flex items-center gap-1.5"><Link2 className="w-4 h-4" />{t('canvasPlatforms.title')}<HelpTip id="canvasPlatforms.settings" /></h3>
      <AdminHint variant="intro">{t('canvasPlatforms.intro')}</AdminHint>
      {!rows || !info ? (
        <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{t('common.loading')}</p>
      ) : (
        <>
          <p className={`text-sm ${info.active ? 'text-green-700' : 'text-amber-700'}`} data-testid="text-lti-status">
            {info.active ? t('canvasPlatforms.active', { n: String(info.active) }) : t('canvasPlatforms.inactive')}
          </p>
          {info.env.length > 0 && (
            <p className="text-xs text-gray-600">{t('canvasPlatforms.fromEnv', { list: info.env.map(p => `${p.issuer} (${p.clientId})`).join(', ') })}</p>
          )}

          {info.recentUnknown.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2" data-testid="list-lti-unknown">
              <p className="text-sm font-medium text-amber-900">{t('canvasPlatforms.recentTitle')}</p>
              <p className="text-xs text-amber-900">{t('canvasPlatforms.recentHint')}</p>
              {info.recentUnknown.map((a, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
                  <code className="min-w-0 break-all text-gray-800">{a.issuer} · {a.clientId || '—'}{a.deploymentId ? ` · ${a.deploymentId}` : ''}</code>
                  <span className="text-gray-500">{new Date(a.at).toLocaleString(t('common.locale'))}</span>
                  <button type="button" onClick={() => adopt(a)} className="whitespace-nowrap rounded-md border border-amber-300 bg-white px-2 py-1 text-amber-900 hover:bg-amber-100" data-testid={`button-lti-adopt-${i}`}>
                    {t('canvasPlatforms.adopt')}
                  </button>
                </div>
              ))}
            </div>
          )}

          {rows.map((_, i) => (
            <div key={i} className="rounded-lg border border-gray-200 p-3 space-y-2" data-testid={`row-lti-platform-${i}`}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-sm font-medium text-gray-800">{t('canvasPlatforms.rowTitle', { n: String(i + 1) })}</span>
                <Tooltip label={t('canvasPlatforms.remove')}>
                  <button type="button" onClick={() => setRows(rows.filter((__, j) => j !== i))} className="rounded p-1 text-red-600 hover:bg-red-50">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </Tooltip>
              </div>
              <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))]">
                {field(i, 'issuer', t('canvasPlatforms.issuer'), t('canvasPlatforms.issuerHint'))}
                {field(i, 'clientId', t('canvasPlatforms.clientId'))}
                {field(i, 'deploymentIds', t('canvasPlatforms.deploymentIds'), t('canvasPlatforms.deploymentHint'))}
                {field(i, 'authUrl', t('canvasPlatforms.authUrl'), t('canvasPlatforms.urlHint'))}
                {field(i, 'jwksUrl', t('canvasPlatforms.jwksUrl'), t('canvasPlatforms.urlHint'))}
              </div>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setRows([...rows, empty()])} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50" data-testid="button-lti-add">
              <Plus className="w-4 h-4" />{t('canvasPlatforms.add')}
            </button>
            <button type="button" onClick={() => save(rows)} disabled={busy} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50" data-testid="button-lti-save">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}{t('common.save')}
            </button>
            {msg && <span className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-700'}`} role="status">{msg.text}</span>}
          </div>
          <p className="text-xs text-gray-500">{t('canvasPlatforms.configFor')} <code className="break-all">{info.configUrl}</code></p>
        </>
      )}
    </div>
  );
}
