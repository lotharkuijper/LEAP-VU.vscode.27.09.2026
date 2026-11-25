// "Begrippen zoeken" (Cursusmateriaal → Begrippen): de drie manieren van zoeken
// en de melding achteraf. Pure helpers, los te testen; het paneel staat in
// src/components/material/ConceptSearchPanel.tsx.

import { DEFAULT_EXTRACTION_OPTIONS, extractionBody, type ExtractionOptions } from './conceptExtractionJob';

/**
 * - files: alleen in gekozen bestanden (standaard de nieuwe en gewijzigde), aanvullen
 * - all: in alle leerstof, aanvullen
 * - rebuild: de lijst opnieuw samenstellen uit alle leerstof
 */
export type SearchMode = 'files' | 'all' | 'rebuild';

/** Pure: verzoek voor de extractie bij deze keuze. */
export function searchBody(courseId: string, mode: SearchMode, language: ExtractionOptions['language'], documentIds: string[]) {
  return extractionBody(courseId, mode === 'rebuild', {
    ...DEFAULT_EXTRACTION_OPTIONS,
    language,
    documentIds: mode === 'files' ? documentIds : [],
  });
}

/** Pure: welke keuze staat standaard aan. */
export function defaultSearchMode(newCount: number): SearchMode {
  return newCount > 0 ? 'files' : 'all';
}

export interface SearchResponse {
  concepts?: Array<{ name: string }>;
  netTotal?: number;
  needsReview?: boolean;
  removedSkipped?: number;
  staleHidden?: number;
  staleDeleted?: number;
  failedDocuments?: string[];
}

export interface ResultLine { key: string; vars?: Record<string, string> }

/** Pure: wat de docent na afloop te lezen krijgt (vertaalsleutels met waarden). */
export function describeSearchResult(r: SearchResponse, mode: SearchMode): ResultLine[] {
  const names = (r.concepts || []).map((c) => c.name);
  const lines: ResultLine[] = [];
  if (mode === 'rebuild') {
    lines.push({ key: 'material.search.result.rebuilt', vars: { total: String(r.netTotal ?? names.length) } });
    if ((r.staleDeleted || 0) > 0) lines.push({ key: 'material.search.result.staleDeleted', vars: { n: String(r.staleDeleted) } });
    if ((r.staleHidden || 0) > 0) lines.push({ key: 'material.search.result.staleHidden', vars: { n: String(r.staleHidden) } });
  } else if (names.length === 0) {
    lines.push({ key: 'material.search.result.none' });
  } else {
    lines.push({
      key: r.needsReview ? 'material.search.result.foundReview' : 'material.search.result.foundVisible',
      vars: { n: String(names.length), names: names.slice(0, 12).join(', ') + (names.length > 12 ? ', …' : '') },
    });
  }
  if ((r.removedSkipped || 0) > 0) lines.push({ key: 'material.search.result.removedSkipped', vars: { n: String(r.removedSkipped) } });
  if ((r.failedDocuments || []).length > 0) {
    lines.push({ key: 'material.search.result.failed', vars: { files: (r.failedDocuments || []).join(', ') } });
  }
  return lines;
}
