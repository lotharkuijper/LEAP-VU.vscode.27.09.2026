import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { CitationText, type CitationSource } from './CitationText';
import { prepareLatex } from '../lib/mathDelimiters';

// Kleine, dependency-vrije remark-stap (vervangt remark-breaks): zet enkele
// regeleindes binnen tekst-nodes om naar harde `break`-nodes, zodat
// regel-per-regel bronmateriaal (dichte dia's/pagina's) zijn regelindeling
// behoudt in plaats van in één paragraaf samen te vloeien. Draait ná
// remark-math, dus formule-nodes ($…$, $$…$$) blijven onaangeroerd: we splitsen
// uitsluitend `text`-nodes.
interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

function splitTextNodes(node: MdastNode): void {
  if (!node.children) return;
  const next: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('\n')) {
      const segments = child.value.split('\n');
      segments.forEach((seg, i) => {
        if (i > 0) next.push({ type: 'break' });
        if (seg) next.push({ type: 'text', value: seg });
      });
    } else {
      splitTextNodes(child);
      next.push(child);
    }
  }
  node.children = next;
}

function remarkHardBreaks() {
  return (tree: MdastNode) => {
    splitTextNodes(tree);
  };
}

/**
 * Het model schrijft soms Markdown-voetnoten ([^1] met onderaan "[^1]: …")
 * in plaats van de afgesproken [1]. Verwijzen die naar een bekende bron, dan
 * maken we er een gewone bronverwijzing van en laten we het voetnotenblok weg
 * (de bronnenlijst staat er al onder). Andere voetnoten blijven staan.
 */
export function normalizeFootnoteCitations(content: string, sources: CitationSource[]): string {
  if (!content || sources.length === 0) return content;
  const valid = new Set(sources.map(s => s.index));
  const out = content
    .replace(/^\[\^(\d{1,3})\]:[^\n]*(?:\n[ \t]+[^\n]*)*/gm, (m, n) => (valid.has(Number(n)) ? '' : m))
    .replace(/\[\^(\d{1,3})\]/g, (m, n) => (valid.has(Number(n)) ? `[${n}]` : m));
  return out === content ? content : out.replace(/\n{3,}/g, '\n\n').trim();
}

const RAG_DOC_LINK_RE = /\/api\/rag\/documents\/([0-9a-f-]{36})\//i;

interface MarkdownMessageProps {
  content: string;
  sources?: CitationSource[];
  onCitationClick?: (index: number) => void;
  onSourceOpen?: (source: CitationSource) => void;
  className?: string;
  style?: React.CSSProperties;
  /** Behoud enkele regeleindes als harde breaks (regel-per-regel bronmateriaal). */
  hardBreaks?: boolean;
}

export function MarkdownMessage({
  content,
  sources = [],
  onCitationClick,
  onSourceOpen,
  className,
  style,
  hardBreaks = false,
}: MarkdownMessageProps) {
  const wrap = (children: React.ReactNode) =>
    sources.length > 0 ? (
      <CitationText
        sources={sources}
        onCitationClick={onCitationClick}
        onSourceOpen={onSourceOpen}
      >
        {children}
      </CitationText>
    ) : (
      <>{children}</>
    );

  return (
    <div
      className={
        className ??
        'prose prose-sm max-w-none ' +
        'prose-p:my-2 prose-headings:mt-3 prose-headings:mb-2 ' +
        'prose-table:my-2 prose-th:bg-gray-50 prose-th:px-2 prose-th:py-1 ' +
        'prose-td:px-2 prose-td:py-1 prose-td:border prose-th:border ' +
        'prose-code:before:hidden prose-code:after:hidden prose-code:bg-gray-100 ' +
        'prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.9em] ' +
        'prose-pre:bg-gray-900 prose-pre:text-gray-100 ' +
        'prose-a:text-blue-600 prose-a:underline'
      }
      style={style}
      data-testid="markdown-message"
    >
      <ReactMarkdown
        remarkPlugins={hardBreaks ? [remarkGfm, remarkMath, remarkHardBreaks] : [remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        skipHtml
        components={{
          p: ({ children }) => <p>{wrap(children)}</p>,
          li: ({ children }) => <li>{wrap(children)}</li>,
          td: ({ children }) => <td>{wrap(children)}</td>,
          th: ({ children }) => <th>{wrap(children)}</th>,
          h1: ({ children }) => <h1>{wrap(children)}</h1>,
          h2: ({ children }) => <h2>{wrap(children)}</h2>,
          h3: ({ children }) => <h3>{wrap(children)}</h3>,
          h4: ({ children }) => <h4>{wrap(children)}</h4>,
          a: ({ href, children }) => {
            const h = href || '';
            // Sprong binnen het antwoord (bv. een voetnoot): hier blijven,
            // niet in een nieuw tabblad (dat opende LEAP opnieuw).
            if (h.startsWith('#')) {
              return (
                <a href={h} onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(h.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }}>{children}</a>
              );
            }
            // Link naar een cursusdocument: in LEAP openen, op de plek van de bron.
            const doc = h.match(RAG_DOC_LINK_RE);
            if (doc && onSourceOpen) {
              const src = sources.find(s => s.documentId === doc[1]) || { index: 0, title: String(children ?? ''), documentId: doc[1] };
              return <a href={h} onClick={(e) => { e.preventDefault(); onSourceOpen(src); }}>{children}</a>;
            }
            // Externe link: nieuw tabblad. Interne link: gewoon in LEAP.
            return /^https?:\/\//i.test(h)
              ? <a href={h} target="_blank" rel="noopener noreferrer">{children}</a>
              : <a href={h}>{children}</a>;
          },
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="border-collapse">{children}</table>
            </div>
          ),
        }}
      >
        {prepareLatex(normalizeFootnoteCitations(content, sources))}
      </ReactMarkdown>
    </div>
  );
}
