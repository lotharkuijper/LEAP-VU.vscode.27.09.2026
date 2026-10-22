// Formules in tekst van studenten (2026-10-22).
//
// Studenten kunnen overal TeX typen; dat wordt altijd opgemaakt, ook zonder de
// formule-editor. Deze module knipt een tekst in gewone tekst en formules.
//
// Herkend: $…$ (in de zin), $$…$$ (op een eigen regel), \(…\) en \[…\].
// Voor enkele dollars geldt de regel van Pandoc, zodat bedragen nooit als
// formule verschijnen ("het kost $10 en $20"):
//   - direct na het openende $ staat geen spatie;
//   - direct vóór het sluitende $ staat geen spatie;
//   - direct na het sluitende $ staat geen cijfer;
//   - \$ is een gewoon dollarteken.

export type MathSegment =
  | { kind: 'text'; value: string }
  | { kind: 'math'; value: string; display: boolean; start: number; end: number };

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isDigit = (c: string | undefined) => c !== undefined && /[0-9]/.test(c);

/** Zoekt het sluitende `$` van een enkele-dollarformule die bij `open` begint; -1 als er geen geldige is. */
function closingSingleDollar(s: string, open: number): number {
  if (isSpace(s[open + 1]) || s[open + 1] === '$') return -1;
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '\n' && s[i + 1] === '\n') return -1; // nooit over een witregel heen
    if (c === '$') {
      if (isSpace(s[i - 1]) || isDigit(s[i + 1])) return -1;
      return i;
    }
  }
  return -1;
}

export function splitMath(s: string): MathSegment[] {
  const out: MathSegment[] = [];
  let text = '';
  const flush = () => { if (text) { out.push({ kind: 'text', value: text }); text = ''; } };
  const push = (value: string, display: boolean, start: number, end: number) => {
    flush();
    out.push({ kind: 'math', value: value.trim(), display, start, end });
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '$') { text += '$'; i += 2; continue; }
    if (c === '\\' && (s[i + 1] === '(' || s[i + 1] === '[')) {
      const close = s[i + 1] === '(' ? '\\)' : '\\]';
      const j = s.indexOf(close, i + 2);
      if (j > i + 2) { push(s.slice(i + 2, j), s[i + 1] === '[', i, j + 2); i = j + 2; continue; }
    }
    if (c === '$' && s[i + 1] === '$') {
      const j = s.indexOf('$$', i + 2);
      if (j > i + 2) { push(s.slice(i + 2, j), true, i, j + 2); i = j + 2; continue; }
    }
    if (c === '$') {
      const j = closingSingleDollar(s, i);
      if (j > 0) { push(s.slice(i + 1, j), false, i, j + 1); i = j + 1; continue; }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

export function hasMath(s: string): boolean {
  return splitMath(s).some(seg => seg.kind === 'math');
}

/** De formule waar de cursor in staat (om hem in de editor te openen), of null. */
export function mathAt(s: string, caret: number): { latex: string; start: number; end: number; display: boolean } | null {
  for (const seg of splitMath(s)) {
    if (seg.kind === 'math' && caret > seg.start && caret < seg.end) {
      return { latex: seg.value, start: seg.start, end: seg.end, display: seg.display };
    }
  }
  return null;
}

/**
 * Voor de bestaande markdown-weergave (MarkdownMessage): bedragen nooit als
 * formule. Een enkele-dollarformule waarvan de inhoud met een cijfer begint en
 * met een spatie eindigt ("$10 en $20") is een bedrag: het openende $ wordt
 * dan \$. Formules zoals $x^2$, $5$ en $ x $ blijven ongemoeid. Codeblokken en
 * `inline code` worden overgeslagen.
 */
export function guardCurrencyDollars(md: string): string {
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, idx) => (idx % 2 === 1 ? part : part.replace(/(^|[^\\$])\$(?!\$)(\d[^$\n]*?\s)\$(?!\$)/g, (_m, pre, inner) => `${pre}\\$${inner}$`)))
    .join('');
}
