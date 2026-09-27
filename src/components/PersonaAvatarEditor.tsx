import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Shuffle, RotateCcw, RefreshCw } from 'lucide-react';
import { useLanguage } from '../i18n';
import { PersonaAvatar } from './PersonaAvatar';
import { Tooltip } from './help/Tooltip';
import {
  AVATAR_STYLES, AVATAR_BACKGROUNDS, defaultAvatar, resolveAvatar, loadStyle,
  partChoices, partCanBeEmpty, randomSeed,
  type AvatarConfig, type AvatarPart, type AvatarStyle,
} from '../lib/personaAvatar';

const NONE = '__none';

/** Huidige keuze voor een onderdeel: een waarde, NONE, of null (= automatisch uit de seed). */
export function currentPartValue(cfg: AvatarConfig, part: AvatarPart): string | null {
  if (cfg.options[`${part.key}Probability`] === 0) return NONE;
  const v = cfg.options[part.key];
  return Array.isArray(v) && v.length ? v[0] : null;
}

/** Pure: zet een onderdeel op een waarde (NONE = weglaten, null = automatisch). */
export function setPartValue(cfg: AvatarConfig, part: AvatarPart, value: string | null, canBeEmpty: boolean): AvatarConfig {
  const options = { ...cfg.options };
  const probKey = `${part.key}Probability`;
  if (value === NONE) {
    delete options[part.key];
    options[probKey] = 0;
  } else if (value === null) {
    delete options[part.key];
    delete options[probKey];
  } else {
    options[part.key] = [value];
    if (canBeEmpty) options[probKey] = 100;
  }
  return { ...cfg, options };
}

/** Pure: volgende/vorige keuze in de rij (met "geen" vooraan als dat kan). */
export function stepPart(choices: string[], canBeEmpty: boolean, current: string | null, dir: 1 | -1): string | null {
  const list = canBeEmpty ? [NONE, ...choices] : choices;
  if (list.length === 0) return current;
  const idx = current === null ? -1 : list.indexOf(current);
  if (idx < 0) return dir === 1 ? list[0] : list[list.length - 1];
  return list[(idx + dir + list.length) % list.length];
}

/**
 * Editor voor het gezicht van een persona: stijl kiezen, per onderdeel
 * bladeren (◀ ▶), kleuren, achtergrond, "Verras me" en varianten.
 * `value` null = het standaard-robotje (afgeleid van de naam).
 */
export function PersonaAvatarEditor({ value, name, onChange }: {
  value: AvatarConfig | null | undefined;
  name: string;
  onChange: (next: AvatarConfig | null) => void;
}) {
  const { t } = useLanguage();
  const cfg = value ? resolveAvatar(value, name) : defaultAvatar(name);
  const styleDef = AVATAR_STYLES.find(s => s.id === cfg.style) || AVATAR_STYLES[0];
  const [, setTick] = useState(0);
  const [variantSeeds, setVariantSeeds] = useState<string[]>(() => Array.from({ length: 8 }, randomSeed));

  useEffect(() => {
    let alive = true;
    loadStyle(cfg.style).then(() => { if (alive) setTick(n => n + 1); }).catch(() => {});
    return () => { alive = false; };
  }, [cfg.style]);

  const bg = Array.isArray(cfg.options.backgroundColor) && cfg.options.backgroundColor.length === 1
    ? cfg.options.backgroundColor[0] : null;

  const chooseStyle = (style: AvatarStyle) => {
    onChange({ style, seed: cfg.seed || name, options: bg ? { backgroundColor: [bg] } : {} });
  };
  const surprise = () => {
    onChange({ ...cfg, seed: randomSeed(), options: cfg.options.backgroundColor ? { backgroundColor: cfg.options.backgroundColor } : {} });
    setVariantSeeds(Array.from({ length: 8 }, randomSeed));
  };
  const variants = useMemo(
    () => variantSeeds.map(seed => ({ ...cfg, seed })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [variantSeeds, JSON.stringify(cfg.options), cfg.style],
  );

  return (
    <div className="border border-gray-200 rounded-xl p-3 bg-gray-50 space-y-3" data-testid="persona-avatar-editor">
      <div className="flex items-start gap-3">
        <PersonaAvatar avatar={cfg} name={name} size={88} className="ring-2 ring-white shadow" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('persona.avatar.styleLabel')}>
            {AVATAR_STYLES.map(s => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={s.id === cfg.style}
                onClick={() => chooseStyle(s.id)}
                className={`flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full text-xs border ${s.id === cfg.style ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:border-blue-400'}`}
                data-testid={`button-avatar-style-${s.id}`}
              >
                <PersonaAvatar avatar={{ style: s.id, seed: cfg.seed || name, options: bg ? { backgroundColor: [bg] } : {} }} name={name} size={22} />
                {t(s.labelKey)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={surprise} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-white border border-gray-300 rounded-lg hover:bg-blue-50" data-testid="button-avatar-surprise">
              <Shuffle className="w-3.5 h-3.5" />{t('persona.avatar.surprise')}
            </button>
            {value && (
              <button type="button" onClick={() => onChange(null)} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-white border border-gray-300 rounded-lg hover:bg-gray-100" data-testid="button-avatar-reset">
                <RotateCcw className="w-3.5 h-3.5" />{t('persona.avatar.reset')}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
        {styleDef.parts.map(part => {
          const choices = partChoices(cfg.style, part);
          if (choices.length === 0) return null;
          const canBeEmpty = partCanBeEmpty(cfg.style, part);
          const current = currentPartValue(cfg, part);
          if (part.kind === 'color') {
            return (
              <div key={part.key} className="sm:col-span-2 flex items-center gap-2">
                <span className="text-xs text-gray-600 w-28 flex-shrink-0">{t(part.labelKey)}</span>
                <div className="flex flex-wrap gap-1">
                  {choices.map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => onChange(setPartValue(cfg, part, c, false))}
                      aria-label={`${t(part.labelKey)} #${c}`}
                      aria-pressed={current === c}
                      className={`w-5 h-5 rounded-full border ${current === c ? 'ring-2 ring-blue-500 ring-offset-1 border-white' : 'border-gray-300'}`}
                      style={{ background: `#${c}` }}
                    />
                  ))}
                  <button type="button" onClick={() => onChange(setPartValue(cfg, part, null, false))} aria-pressed={current === null}
                    className={`px-1.5 h-5 text-[10px] rounded-full border bg-white ${current === null ? 'ring-2 ring-blue-500 ring-offset-1' : 'border-gray-300 text-gray-500'}`}>
                    {t('persona.avatar.auto')}
                  </button>
                </div>
              </div>
            );
          }
          const list = canBeEmpty ? [NONE, ...choices] : choices;
          const pos = current === null ? t('persona.avatar.auto')
            : current === NONE ? t('persona.avatar.none')
            : `${list.indexOf(current) + 1 - (canBeEmpty ? 1 : 0)}/${choices.length}`;
          return (
            <div key={part.key} className="flex items-center gap-1">
              <span className="text-xs text-gray-600 w-28 flex-shrink-0">{t(part.labelKey)}</span>
              <Tooltip label={t('persona.avatar.previous')}>
                <button type="button" onClick={() => onChange(setPartValue(cfg, part, stepPart(choices, canBeEmpty, current, -1), canBeEmpty))}
                  className="p-1 rounded bg-white border border-gray-300 hover:bg-blue-50" data-testid={`button-avatar-prev-${part.key}`}>
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
              <span className="text-[11px] text-gray-700 w-14 text-center tabular-nums">{pos}</span>
              <Tooltip label={t('persona.avatar.next')}>
                <button type="button" onClick={() => onChange(setPartValue(cfg, part, stepPart(choices, canBeEmpty, current, 1), canBeEmpty))}
                  className="p-1 rounded bg-white border border-gray-300 hover:bg-blue-50" data-testid={`button-avatar-next-${part.key}`}>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            </div>
          );
        })}
        <div className="sm:col-span-2 flex items-center gap-2">
          <span className="text-xs text-gray-600 w-28 flex-shrink-0">{t('persona.avatar.part.background')}</span>
          <div className="flex flex-wrap gap-1">
            {AVATAR_BACKGROUNDS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => onChange({ ...cfg, options: { ...cfg.options, backgroundColor: [c] } })}
                aria-label={c === 'transparent' ? t('persona.avatar.none') : `${t('persona.avatar.part.background')} #${c}`}
                aria-pressed={bg === c}
                className={`w-5 h-5 rounded-full border ${bg === c ? 'ring-2 ring-blue-500 ring-offset-1 border-white' : 'border-gray-300'}`}
                style={c === 'transparent'
                  ? { background: 'repeating-conic-gradient(#e5e7eb 0% 25%, #fff 0% 50%) 50% / 8px 8px' }
                  : { background: `#${c}` }}
              />
            ))}
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-gray-600">{t('persona.avatar.variants')}</span>
          <Tooltip label={t('persona.avatar.moreVariants')}>
            <button type="button" onClick={() => setVariantSeeds(Array.from({ length: 8 }, randomSeed))} className="p-1 rounded hover:bg-gray-200" data-testid="button-avatar-more-variants">
              <RefreshCw className="w-3.5 h-3.5 text-gray-500" />
            </button>
          </Tooltip>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {variants.map(v => (
            <button
              key={v.seed}
              type="button"
              onClick={() => onChange(v)}
              aria-label={t('persona.avatar.pickVariant')}
              className="rounded-full hover:ring-2 hover:ring-blue-400"
              data-testid="button-avatar-variant"
            >
              <PersonaAvatar avatar={v} name={name} size={40} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
