import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SECTION_COLORS } from '../sectionColors';

const src = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('kleur per onderdeel', () => {
  it('elk onderdeel dat studenten zien heeft een eigen kleur', () => {
    const student = ['chat', 'explain', 'quiz', 'projects', 'studiecafe', 'journal', 'resources'] as const;
    const families = student.map(k => SECTION_COLORS[k].family);
    expect(new Set(families).size).toBe(families.length);
  });

  it('Ik leg uit is geel en het Studiecafé zacht paars (niet warm zoals Projecten)', () => {
    expect(SECTION_COLORS.explain.family).toBe('amber');
    expect(SECTION_COLORS.studiecafe.family).toBe('violet');
    expect(SECTION_COLORS.projects.family).toBe('orange');
  });

  it('menu en Dashboard halen de kleur uit dezelfde lijst (geen losse kleuren meer)', () => {
    const layout = src('components/Layout.tsx');
    for (const k of ['chat', 'explain', 'quiz', 'projects', 'studiecafe', 'journal']) {
      expect(layout).toContain(`SECTION_COLORS.${k}.gradient`);
    }
    const dash = src('pages/DashboardPage.tsx');
    for (const k of ['chat', 'explain', 'quiz', 'projects']) expect(dash).toContain(`tileColors('${k}')`);
    expect(dash).toContain('SECTION_COLORS.journal');
  });

  it('de pagina "Ik leg uit" gebruikt geen blauw meer als eigen kleur', () => {
    expect(src('pages/ExplainPage.tsx')).not.toMatch(/\b(from|to|bg|text|border)-blue-\d/);
  });
});
