import { useState } from 'react';
import { MarkdownMessage } from './MarkdownMessage';
import { SourceList, type SourceItem } from './SourceList';
import { ragDocumentDownloadUrl } from '../services/rag.service';
import { useLanguage } from '../i18n';

/** Bron zoals de server hem bij een persona-antwoord meestuurt/bewaart (server/citationSources.js). */
export interface PersonaSource {
  index: number;
  title: string;
  documentId?: string;
  similarity?: number;
  slideStart?: number;
  slideEnd?: number;
  pageStart?: number;
  pageEnd?: number;
  /** Projectmateriaal (2026-10-10): document van de docent of upload van de groep. */
  kind?: 'project_document' | 'persona_document';
  documentRef?: string;
}

/** Wat de projectruimte nodig heeft om een bron te openen. */
export interface PersonaSourceTarget {
  documentId?: string;
  title: string;
  page?: number;
  kind?: PersonaSource['kind'];
  documentRef?: string;
}

/** Sleutel per bron: cursusdocument-id, of "<soort>:<id>" voor projectmateriaal. */
const keyOf = (s: PersonaSource) => (s.kind && s.documentRef ? `${s.kind}:${s.documentRef}` : s.documentId);

/**
 * Bruikbare bronnen uit `rag_sources`. Berichten van vóór 2026-09-27 bewaarden
 * alleen { documentId, similarity, excerpt } zonder titel of nummer; die slaan
 * we over (het antwoord verwees er ook niet met [n] naar).
 */
export function personaSourcesFrom(raw: unknown): PersonaSource[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is PersonaSource => !!s && typeof s === 'object'
      && Number.isFinite((s as PersonaSource).index) && typeof (s as PersonaSource).title === 'string')
    .sort((a, b) => a.index - b.index);
}

/**
 * Antwoord van een persona in de projectruimte, gelijk aan de chat: opmaak
 * (markdown), klikbare [n]-verwijzingen naar het cursusmateriaal en onderaan
 * een uitklapbare bronnenlijst.
 */
export function PersonaMessageBody({
  messageId,
  content,
  sources,
  onOpenSource,
}: {
  messageId: string;
  content: string;
  sources: PersonaSource[];
  onOpenSource: (s: PersonaSourceTarget) => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const citationSources = sources.map(s => ({
    index: s.index,
    title: s.title,
    documentId: keyOf(s),
    href: s.kind ? undefined : ragDocumentDownloadUrl(s.documentId),
  }));
  const listItems: SourceItem[] = sources.map(s => ({
    title: s.title,
    similarity: s.similarity ?? 0,
    documentId: keyOf(s),
    href: s.kind ? undefined : ragDocumentDownloadUrl(s.documentId),
    slideStart: s.slideStart,
    slideEnd: s.slideEnd,
    pageStart: s.pageStart,
    pageEnd: s.pageEnd,
  }));
  const openById = (key: string | undefined) => {
    const s = sources.find(x => keyOf(x) === key);
    if (!s) return;
    if (s.kind && s.documentRef) {
      onOpenSource({ title: s.title, kind: s.kind, documentRef: s.documentRef });
      return;
    }
    if (!s.documentId) return;
    onOpenSource({ documentId: s.documentId, title: s.title, page: s.pageStart ?? s.slideStart });
  };
  const scrollTo = (idx: number) => {
    setOpen(true);
    requestAnimationFrame(() => {
      const el = document.getElementById(`source-${messageId}-${idx}`);
      if (el && 'scrollIntoView' in el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };
  return (
    <>
      <MarkdownMessage
        content={content}
        sources={citationSources}
        onCitationClick={scrollTo}
        onSourceOpen={(s) => openById(s.documentId)}
      />
      {listItems.length > 0 && (
        <SourceList
          sources={listItems}
          label={t('chat.sourcesFromMaterial')}
          showSimilarity={false}
          open={open}
          onOpenChange={setOpen}
          idPrefix={messageId}
          onOpenSource={(s) => openById(s.documentId)}
          uniqueLabel={t('chat.uniqueWord')}
          slideWord={t('quiz.slideWord')}
          pageWord={t('sources.pageWord')}
        />
      )}
    </>
  );
}
