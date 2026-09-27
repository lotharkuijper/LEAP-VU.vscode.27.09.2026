// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { LanguageProvider } from '../../i18n';
import { PersonaAvatar } from '../PersonaAvatar';
import { PersonaAvatarEditor, currentPartValue, setPartValue, stepPart } from '../PersonaAvatarEditor';
import { AVATAR_STYLES, resolveAvatar, loadStyle, avatarDataUriSync, type AvatarConfig } from '../../lib/personaAvatar';
// JS zonder type-declaraties; vandaar de ts-ignore.
// @ts-ignore
import { sanitizeAvatar } from '../../../server/personaAvatar.js';
import nl from '../../i18n/locales/nl.json';

afterEach(cleanup);
const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>);
const top = AVATAR_STYLES[0].parts.find(p => p.key === 'top')!;

describe('persona-avatar logica', () => {
  it('zonder opgeslagen avatar: robotje dat uit de naam volgt', () => {
    const a = resolveAvatar(null, 'Mevrouw Jansen');
    expect(a.style).toBe('bottts');
    expect(a.seed).toBe('Mevrouw Jansen');
    expect(resolveAvatar({ style: 'onbekend' }, 'X').style).toBe('bottts');
  });

  it('elk label in de editor bestaat in de vertalingen', () => {
    const keys = AVATAR_STYLES.flatMap(s => [s.labelKey, ...s.parts.map(p => p.labelKey)]);
    for (const k of keys) expect((nl as Record<string, string>)[k], k).toBeTruthy();
  });

  it('bladeren loopt rond en kent "geen" als het onderdeel weg mag', () => {
    expect(stepPart(['a', 'b'], false, null, 1)).toBe('a');
    expect(stepPart(['a', 'b'], false, 'b', 1)).toBe('a');
    expect(stepPart(['a', 'b'], true, 'b', 1)).toBe('__none');
    expect(stepPart(['a', 'b'], true, null, -1)).toBe('b');
  });

  it('"geen" zet de kans op 0; een keuze zet hem terug op 100', () => {
    const base: AvatarConfig = { style: 'bottts', seed: 's', options: {} };
    const none = setPartValue(base, top, '__none', true);
    expect(none.options).toEqual({ topProbability: 0 });
    expect(currentPartValue(none, top)).toBe('__none');
    const pick = setPartValue(none, top, 'antenna', true);
    expect(pick.options).toEqual({ top: ['antenna'], topProbability: 100 });
    expect(currentPartValue(setPartValue(pick, top, null, true), top)).toBeNull();
  });

  it('alle keuzes uit de editor komen ongeschonden door de servercontrole', async () => {
    for (const s of AVATAR_STYLES) {
      const m = await loadStyle(s.id);
      const options: Record<string, string[] | number> = { backgroundColor: ['b6e3f4'] };
      for (const p of s.parts) {
        const prop = m.schema.properties[p.key];
        const vals: string[] = p.kind === 'shape' ? prop.items.enum : prop.default;
        options[p.key] = [vals[vals.length - 1]];
        if (m.schema.properties[`${p.key}Probability`]) options[`${p.key}Probability`] = 100;
      }
      const cfg = { style: s.id, seed: 'test', options };
      expect(sanitizeAvatar(cfg)).toEqual(cfg);
      expect(avatarDataUriSync(cfg)).toMatch(/^data:image\/svg\+xml/);
    }
  });
});

describe('PersonaAvatar', () => {
  it('toont een afbeelding voor de persona', async () => {
    const { container } = render(<PersonaAvatar avatar={null} name="Robo" size={24} />);
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/));
  });
});

describe('PersonaAvatarEditor', () => {
  function Harness({ onValue }: { onValue: (v: AvatarConfig | null) => void }) {
    const [v, setV] = useState<AvatarConfig | null>(null);
    return <PersonaAvatarEditor value={v} name="Docent" onChange={n => { setV(n); onValue(n); }} />;
  }

  it('stijl kiezen, onderdeel wisselen en terug naar het robotje', async () => {
    let last: AvatarConfig | null = null;
    wrap(<Harness onValue={v => { last = v; }} />);
    fireEvent.click(screen.getByTestId('button-avatar-style-avataaars'));
    expect(last!.style).toBe('avataaars');
    const next = await screen.findByTestId('button-avatar-next-eyes');
    fireEvent.click(next);
    expect(Array.isArray(last!.options.eyes)).toBe(true);
    fireEvent.click(screen.getByTestId('button-avatar-reset'));
    expect(last).toBeNull();
  });
});
