import { useMemo } from 'react';
import katex from 'katex';
import { splitMath } from '../lib/mathText';

// Tekst van een student met formules (src/lib/mathText.ts). Alleen formules
// worden opgemaakt; de rest blijft precies zoals getypt (geen markdown, zodat
// een * of # in gewone tekst niets verandert). KaTeX in de veilige stand:
// geen links of ingesloten HTML; een ongeldige formule verschijnt als tekst.

function renderMath(latex: string, display: boolean): string | null {
  try {
    return katex.renderToString(latex, {
      displayMode: display,
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      maxSize: 20,
      maxExpand: 300,
      output: 'htmlAndMathml',
    });
  } catch {
    return null;
  }
}

export function MathText({ text, className = '' }: { text: string; className?: string }) {
  const parts = useMemo(() => splitMath(text || ''), [text]);
  return (
    <span className={`whitespace-pre-wrap break-words ${className}`} data-math-text="">
      {parts.map((p, i) => {
        if (p.kind === 'text') return <span key={i}>{p.value}</span>;
        const html = renderMath(p.value, p.display);
        if (html === null) {
          return <span key={i}>{p.display ? `$$${p.value}$$` : `$${p.value}$`}</span>;
        }
        return p.display
          ? <span key={i} className="my-1 block overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />
          : <span key={i} dangerouslySetInnerHTML={{ __html: html }} />;
      })}
    </span>
  );
}
