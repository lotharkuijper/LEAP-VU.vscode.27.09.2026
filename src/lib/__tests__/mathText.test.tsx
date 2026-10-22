// @vitest-environment jsdom
// Formules in tekst van studenten (src/lib/mathText.ts, MathText, FormulaButton) — 2026-10-22.
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { splitMath, hasMath, mathAt, guardCurrencyDollars } from '../mathText';
import { MathText } from '../../components/MathText';
import { insertFormula } from '../../components/formula/FormulaButton';
import { MarkdownMessage } from '../../components/MarkdownMessage';

const maths = (s: string) => splitMath(s).filter(x => x.kind === 'math').map(x => (x as { value: string }).value);

describe('formules herkennen (regel van Pandoc)', () => {
  it('herkent $…$, $$…$$, \\(…\\) en \\[…\\]', () => {
    expect(maths('de formule $x^2$ hier')).toEqual(['x^2']);
    expect(maths('blok $$\\frac{a}{b}$$')).toEqual(['\\frac{a}{b}']);
    expect(maths('ook \\(a+b\\) en \\[c\\]')).toEqual(['a+b', 'c']);
  });
  it('bedragen worden nooit een formule', () => {
    expect(hasMath('het kost $10 en $20 samen')).toBe(false);
    expect(hasMath('prijs $5')).toBe(false);
    expect(hasMath('van $ 3 tot $ 4')).toBe(false);
    expect(hasMath('\\$x\\$ is geen formule')).toBe(false);
  });
  it('$5$ is wél een formule; een formule loopt niet over een witregel', () => {
    expect(maths('$5$')).toEqual(['5']);
    expect(hasMath('$a\n\nb$')).toBe(false);
  });
  it('vindt de formule waar de cursor in staat', () => {
    const s = 'zie $x^2$ hier';
    expect(mathAt(s, 6)?.latex).toBe('x^2');
    expect(mathAt(s, 1)).toBe(null);
  });
});

describe('weergave', () => {
  it('maakt alleen formules op; de rest blijft tekst, ook * en #', () => {
    const { container } = render(<MathText text={'# geen kop *ook niet vet* en $x^2$'} />);
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.textContent).toContain('# geen kop *ook niet vet*');
  });
  it('geen links of ingesloten HTML via een formule; ongeldig blijft tekst', () => {
    const { container } = render(<MathText text={'$\\href{javascript:alert(1)}{x}$ en $\\frac{$'} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.innerHTML).not.toMatch(/href=/); // alleen als tekst, nooit als link
  });
  it('de markdown-weergave maakt een bedrag niet meer tot formule', () => {
    expect(guardCurrencyDollars('het kost $10 en $20')).toBe('het kost \\$10 en $20');
    expect(guardCurrencyDollars('formule $x^2$ en $5$')).toBe('formule $x^2$ en $5$');
    expect(guardCurrencyDollars('`$10 en $` in code')).toBe('`$10 en $` in code');
    const { container } = render(<MarkdownMessage content={'het kost $10 en $20 samen'} />);
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('$10 en $20');
  });
});

describe('formule invoegen', () => {
  it('op de cursor, als $…$', () => {
    expect(insertFormula('a  b', { start: 2, end: 2 }, 'x^2', false).next).toBe('a $x^2$ b');
  });
  it('plakt niet aan een woord of cijfer vast (anders geen geldige formule)', () => {
    const r = insertFormula('ab12', { start: 2, end: 2 }, 'x', false);
    expect(r.next).toBe('ab $x$ 12');
    expect(maths(r.next)).toEqual(['x']);
  });
  it('vervangt de formule waar de cursor in stond', () => {
    expect(insertFormula('zie $x$ nu', { start: 5, end: 5 }, 'y^2', false, { start: 4, end: 7 }).next).toBe('zie $y^2$ nu');
  });
  it('op een eigen regel als $$…$$', () => {
    expect(insertFormula('tekst', { start: 5, end: 5 }, '\\frac{a}{b}', true).next).toBe('tekst\n$$\\frac{a}{b}$$');
  });
});
