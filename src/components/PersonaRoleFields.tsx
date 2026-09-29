import { useState } from 'react';
import { Compass, Gavel, Drama, Loader2, FlaskConical } from 'lucide-react';
import { useLanguage } from '../i18n';
import { HelpTip } from './help/HelpTip';
import { AdminHint } from './help/AdminHint';
import { RELATIONSHIP_BADGE, type RelationshipKey } from '../lib/relationshipLevels';

export type PersonaRole = 'conversational' | 'evaluator' | 'roleplayer';
export const LEVEL_KEYS: Array<Exclude<RelationshipKey, 'broken'>> = ['cold', 'strained', 'neutral', 'positive', 'warm'];

export interface ConductRules {
  positive?: string;
  negative?: string;
  levels?: Partial<Record<Exclude<RelationshipKey, 'broken'>, string>>;
}

/** De velden die bij de rol horen (gedeeld door sjabloon- en projecteditor). */
export interface RoleFieldValues {
  persona_type?: string | null;
  reputation_enabled?: boolean | null;
  conduct_rules?: ConductRules | null;
  start_level?: number | null;
  deliverable_label?: string | null;
  max_reviews?: number | null;
  badge_award_mode?: string | null;
}

/** Wat er naar de server gaat; velden die niet bij de rol horen worden daar neutraal gezet. */
export function roleFieldsPayload(v: RoleFieldValues) {
  const role = (v.persona_type || 'conversational') as PersonaRole;
  return {
    persona_type: role,
    reputation_enabled: role === 'roleplayer' && !!v.reputation_enabled,
    conduct_rules: role === 'roleplayer' ? (v.conduct_rules ?? null) : null,
    start_level: role === 'roleplayer' ? (v.start_level ?? 0) : 0,
    deliverable_label: role === 'evaluator' ? (v.deliverable_label?.trim() || null) : null,
    max_reviews: role === 'evaluator' ? (v.max_reviews ?? null) : null,
    badge_award_mode: role === 'evaluator' && v.badge_award_mode === 'group' ? 'group' : 'individual',
  };
}

const ROLES: Array<{ role: PersonaRole; Icon: typeof Compass; tone: string }> = [
  { role: 'conversational', Icon: Compass, tone: 'border-blue-300 bg-blue-50 text-blue-900' },
  { role: 'evaluator', Icon: Gavel, tone: 'border-purple-300 bg-purple-50 text-purple-900' },
  { role: 'roleplayer', Icon: Drama, tone: 'border-orange-300 bg-orange-50 text-orange-900' },
];

/**
 * Rolkeuze (Begeleider / Beoordelaar / Rolspeler) met alleen de instellingen die
 * bij die rol horen. Bij een rolspeler kan de docent de verstandhouding aanzetten
 * en de gedragsregels invullen, en die meteen uitproberen met een proefgesprek.
 */
export function PersonaRoleFields({ value, onChange, personaName, courseId, token, idPrefix }: {
  value: RoleFieldValues;
  onChange: (next: RoleFieldValues) => void;
  personaName: string;
  /** Nodig voor het proefgesprek (docent van deze cursus). */
  courseId: string | null;
  token: string | null;
  idPrefix: string;
}) {
  const { t, lang } = useLanguage();
  const role = (value.persona_type || 'conversational') as PersonaRole;
  const rules = value.conduct_rules || {};
  const setRules = (patch: ConductRules) => onChange({ ...value, conduct_rules: { ...rules, ...patch } });
  const name = personaName.trim() || t('admin.personaRole.thisPersona');

  const [testText, setTestText] = useState('');
  const [testLevel, setTestLevel] = useState<number>(value.start_level ?? 0);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ step: number; reason: string; key: RelationshipKey } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const runTest = async () => {
    if (!courseId || !token) return;
    setTesting(true); setTestError(null); setTestResult(null);
    try {
      const r = await fetch('/api/admin/personas/conduct-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ courseId, personaName: name, conduct_rules: rules, level: testLevel, transcript: testText, lang }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || t('admin.personaRole.test.failed'));
      setTestResult({ step: d.step, reason: d.reason, key: d.key });
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-700">
          {t('admin.personaRole.label')}<HelpTip id="personas.role" />
        </legend>
        <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(min(11rem,100%),1fr))]">
          {ROLES.map(({ role: r, Icon, tone }) => {
            const active = role === r;
            return (
              <label
                key={r}
                className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors ${active ? tone : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'}`}
                data-testid={`${idPrefix}-role-${r}`}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <input
                    type="radio"
                    name={`${idPrefix}-role`}
                    checked={active}
                    onChange={() => onChange({ ...value, persona_type: r })}
                    className="h-3.5 w-3.5 accent-blue-600"
                  />
                  <Icon className="h-4 w-4 flex-shrink-0" />{t(`admin.personaRole.${r}.title`)}
                </span>
                <span className="text-[11px] leading-snug opacity-80">{t(`admin.personaRole.${r}.desc`)}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {role === 'evaluator' && (
        <div className="grid gap-3 rounded-lg border border-purple-100 bg-purple-50/40 p-3 grid-cols-[repeat(auto-fit,minmax(min(14rem,100%),1fr))]">
          <div>
            <label htmlFor={`${idPrefix}-deliverable`} className="text-xs font-medium text-gray-700">{t('admin.personaRole.evaluator.deliverable')}</label>
            <input
              id={`${idPrefix}-deliverable`}
              value={value.deliverable_label || ''}
              onChange={e => onChange({ ...value, deliverable_label: e.target.value })}
              placeholder={t('admin.personaRole.evaluator.deliverablePlaceholder')}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              data-testid={`${idPrefix}-deliverable`}
            />
          </div>
          <div>
            <label htmlFor={`${idPrefix}-max-reviews`} className="flex items-center gap-1.5 text-xs font-medium text-gray-700">{t('admin.personaRole.evaluator.maxReviews')}<HelpTip id="personas.feedbackRounds" /></label>
            <input
              id={`${idPrefix}-max-reviews`}
              type="number"
              min={1}
              max={50}
              value={value.max_reviews ?? ''}
              placeholder={t('admin.personaRole.evaluator.unlimited')}
              onChange={e => {
                const v = e.target.value.trim();
                onChange({ ...value, max_reviews: v === '' ? null : Math.max(1, Math.min(50, Math.floor(Number(v)))) });
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              data-testid={`${idPrefix}-max-reviews`}
            />
          </div>
          <div>
            <label htmlFor={`${idPrefix}-badge-mode`} className="text-xs font-medium text-gray-700">{t('admin.projects.personas.badgeAwardModeLabel')}</label>
            <select
              id={`${idPrefix}-badge-mode`}
              value={value.badge_award_mode === 'group' ? 'group' : 'individual'}
              onChange={e => onChange({ ...value, badge_award_mode: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white"
              data-testid={`${idPrefix}-badge-mode`}
            >
              <option value="individual">{t('admin.projects.personas.badgeAwardModeIndividual')}</option>
              <option value="group">{t('admin.projects.personas.badgeAwardModeGroup')}</option>
            </select>
          </div>
          <AdminHint variant="tip" className="col-span-full">{t('admin.personaRole.evaluator.hint')}</AdminHint>
        </div>
      )}

      {role === 'roleplayer' && (
        <div className="space-y-3 rounded-lg border border-orange-100 bg-orange-50/40 p-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!value.reputation_enabled}
              onChange={e => onChange({ ...value, reputation_enabled: e.target.checked })}
              className="mt-0.5"
              data-testid={`${idPrefix}-reputation`}
            />
            <span>
              <span className="font-medium inline-flex items-center gap-1.5">{t('admin.personaRole.roleplayer.reputation')}<HelpTip id="personas.reputation" /></span>
              <span className="block text-[11px] text-gray-600">{t('admin.personaRole.roleplayer.reputationDesc', { name })}</span>
            </span>
          </label>

          {value.reputation_enabled && (
            <>
              <div>
                <label htmlFor={`${idPrefix}-start-level`} className="text-xs font-medium text-gray-700">{t('admin.personaRole.roleplayer.startLevel')}</label>
                <select
                  id={`${idPrefix}-start-level`}
                  value={value.start_level ?? 0}
                  onChange={e => onChange({ ...value, start_level: Number(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white"
                  data-testid={`${idPrefix}-start-level`}
                >
                  {[...LEVEL_KEYS].reverse().map((k, i) => (
                    <option key={k} value={2 - i}>{t(`room.relationship.label.${k}`)}</option>
                  ))}
                </select>
              </div>

              <div>
                <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-700">{t('admin.personaRole.rules.title')}<HelpTip id="personas.conductRules" /></p>
                <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(min(16rem,100%),1fr))]">
                  <div>
                    <label htmlFor={`${idPrefix}-rules-positive`} className="text-[11px] font-medium text-emerald-800">{t('admin.personaRole.rules.positive', { name })}</label>
                    <textarea
                      id={`${idPrefix}-rules-positive`}
                      value={rules.positive || ''}
                      onChange={e => setRules({ positive: e.target.value })}
                      rows={4}
                      placeholder={t('admin.personaRole.rules.positivePlaceholder')}
                      className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                      data-testid={`${idPrefix}-rules-positive`}
                    />
                  </div>
                  <div>
                    <label htmlFor={`${idPrefix}-rules-negative`} className="text-[11px] font-medium text-amber-800">{t('admin.personaRole.rules.negative', { name })}</label>
                    <textarea
                      id={`${idPrefix}-rules-negative`}
                      value={rules.negative || ''}
                      onChange={e => setRules({ negative: e.target.value })}
                      rows={4}
                      placeholder={t('admin.personaRole.rules.negativePlaceholder')}
                      className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                      data-testid={`${idPrefix}-rules-negative`}
                    />
                  </div>
                </div>
              </div>

              <details className="rounded border border-gray-200 bg-white p-2">
                <summary className="cursor-pointer text-xs font-medium text-gray-700">{t('admin.personaRole.rules.levelsTitle', { name })}</summary>
                <p className="mt-1 text-[11px] text-gray-500">{t('admin.personaRole.rules.levelsHint')}</p>
                <div className="mt-2 space-y-1.5">
                  {[...LEVEL_KEYS].reverse().map(k => (
                    <div key={k} className="grid items-center gap-2 grid-cols-[minmax(6rem,auto)_1fr]">
                      <label htmlFor={`${idPrefix}-level-${k}`} className={`inline-flex items-center gap-1 text-[11px] font-medium ${RELATIONSHIP_BADGE[k].text}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${RELATIONSHIP_BADGE[k].dot}`} />{t(`room.relationship.label.${k}`)}
                      </label>
                      <input
                        id={`${idPrefix}-level-${k}`}
                        value={rules.levels?.[k] || ''}
                        onChange={e => setRules({ levels: { ...(rules.levels || {}), [k]: e.target.value } })}
                        placeholder={t(`admin.personaRole.rules.levelDefault.${k}`)}
                        className="w-full min-w-0 px-2 py-1 border border-gray-300 rounded text-xs"
                        data-testid={`${idPrefix}-level-${k}`}
                      />
                    </div>
                  ))}
                </div>
              </details>

              <AdminHint variant="warning">{t('admin.personaRole.roleplayer.brokenWarning', { name })}</AdminHint>

              <details className="rounded border border-gray-200 bg-white p-2" data-testid={`${idPrefix}-test`}>
                <summary className="cursor-pointer text-xs font-medium text-gray-700 inline-flex items-center gap-1.5">
                  <FlaskConical className="h-3.5 w-3.5" />{t('admin.personaRole.test.title')}
                </summary>
                <p className="mt-1 text-[11px] text-gray-500">{t('admin.personaRole.test.hint', { name })}</p>
                <textarea
                  value={testText}
                  onChange={e => setTestText(e.target.value)}
                  rows={5}
                  placeholder={t('admin.personaRole.test.placeholder', { name })}
                  className="mt-2 w-full px-3 py-2 border border-gray-300 rounded text-xs font-mono"
                  data-testid={`${idPrefix}-test-text`}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <label htmlFor={`${idPrefix}-test-level`} className="text-[11px] text-gray-600">{t('admin.personaRole.test.currentLevel')}</label>
                  <select
                    id={`${idPrefix}-test-level`}
                    value={testLevel}
                    onChange={e => setTestLevel(Number(e.target.value))}
                    className="px-2 py-1 border border-gray-300 rounded text-xs bg-white"
                  >
                    {[...LEVEL_KEYS].reverse().map((k, i) => (
                      <option key={k} value={2 - i}>{t(`room.relationship.label.${k}`)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={runTest}
                    disabled={testing || !testText.trim() || !courseId}
                    className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-orange-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-40"
                    data-testid={`${idPrefix}-test-run`}
                  >
                    {testing && <Loader2 className="h-3 w-3 animate-spin" />}{t('admin.personaRole.test.run')}
                  </button>
                </div>
                {testError && <p className="mt-2 text-[11px] text-red-700">{testError}</p>}
                {testResult && (
                  <p className={`mt-2 rounded border px-2 py-1.5 text-[11px] ${RELATIONSHIP_BADGE[testResult.key].chip}`} data-testid={`${idPrefix}-test-result`}>
                    {testResult.step === 0
                      ? t('admin.personaRole.test.same')
                      : t(testResult.step > 0 ? 'admin.personaRole.test.up' : 'admin.personaRole.test.down', { label: t(`room.relationship.label.${testResult.key}`) })}
                    {testResult.reason && <span> — {testResult.reason}</span>}
                  </p>
                )}
                <p className="mt-2 text-[10px] text-gray-400">{t('admin.personaRole.test.nothingSaved')}</p>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}
