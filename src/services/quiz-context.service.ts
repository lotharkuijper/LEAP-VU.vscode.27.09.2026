/**
 * Cursusmateriaal ophalen als basis voor quizvragen (en hun controle).
 *
 * Achtergrond (diagnose 2026-09-25): de quiz zocht met ÉÉN zoekvraag van alleen
 * de onderwerpnamen ("Ecologisch onderzoek"), zonder verrijking, tegen drempel
 * 0.65. text-embedding-3-small scoort korte Nederlandse vaktermen laag: de beste
 * chunk haalde 0.610, terwijl het onderwerp wel degelijk in het materiaal staat.
 * Gevolg: "geen passend cursusmateriaal".
 *
 * Nu, net als in "Ik leg uit":
 *  - per onderwerp een eigen zoekvraag (geen onderwerp dat de rest wegdrukt),
 *    met query-uitbreiding (definitie + kernpunten) als de docent die voor de
 *    quiz heeft aangezet;
 *  - plus de bij conceptextractie vastgelegde bewijsfragmenten
 *    (concept_evidence). Die zijn al tegen de echte chunks getoetst, maar worden
 *    alleen gebruikt als hun document in een map staat die de docent voor de
 *    quiz heeft opengezet — de bronnenkeuze van de docent blijft leidend.
 * De drempel wordt NIET verlaagd.
 */

import { supabase } from '../lib/supabase';
import { getAccessibleFolders } from './permissions.service';
import { STORAGE_CONFIG } from '../config/storage.config';
import { purposeAllowsModule } from '../../server/filePurpose.js';
import {
  searchRelevantChunksWithStats,
  fetchConceptEvidence,
  getRAGEnabledFolders,
  type DocumentChunk,
  type RAGSearchStats,
} from './rag.service';

export interface QuizContextTopic {
  id: string;
  name: string;
  definition?: string | null;
  keyPoints?: string[] | null;
}

export interface QuizContextResult {
  chunks: DocumentChunk[];
  stats: Omit<RAGSearchStats, 'chunks'>;
  /** Hoeveel van de chunks uit vastgelegde bewijsfragmenten komen. */
  fromEvidence: number;
}

type Role = 'student' | 'docent' | 'admin';

export interface QuizContextDeps {
  search: typeof searchRelevantChunksWithStats;
  evidence: typeof fetchConceptEvidence;
  /** Document-id's in mappen die voor de quiz van deze cursus zijn opengezet (en voor de rol toegankelijk). */
  allowedDocumentIds: (courseId: string, role: Role) => Promise<Set<string>>;
}

async function defaultAllowedDocumentIds(courseId: string, role: Role): Promise<Set<string>> {
  // Zelfde scoping als searchRelevantChunksWithStats: quiz-mappen van de cursus,
  // voor niet-admins beperkt tot de mappen die de rol mag zien.
  const enabled = await getRAGEnabledFolders('quiz', courseId);
  if (enabled.length === 0) return new Set();
  let scoped = enabled;
  if (role !== 'admin') {
    const accessible = await getAccessibleFolders(role);
    scoped = enabled.filter(id => accessible.includes(id));
  }
  if (scoped.length === 0) return new Set();
  const { data } = await supabase
    .from('documents')
    .select('id, purpose')
    .in('folder_id', scoped)
    .eq('bucket', STORAGE_CONFIG.buckets.RAG_SOURCES);
  // Cursusinformatie levert geen quizbewijs (zie server/filePurpose.js).
  return new Set((data || [])
    .filter((d: { purpose?: string | null }) => purposeAllowsModule(d.purpose, 'quiz'))
    .map((d: { id: string }) => d.id));
}

const DEFAULT_DEPS: QuizContextDeps = {
  search: searchRelevantChunksWithStats,
  evidence: fetchConceptEvidence,
  allowedDocumentIds: defaultAllowedDocumentIds,
};

const chunkKey = (c: DocumentChunk) => c.id || `${c.documentId || ''}:${(c.content || '').slice(0, 80)}`;

export async function retrieveQuizContext(
  args: {
    topics: QuizContextTopic[];
    courseId: string;
    role: Role;
    threshold: number;
    matchCount: number;
    expansionEnabled: boolean;
  },
  deps: QuizContextDeps = DEFAULT_DEPS,
): Promise<QuizContextResult> {
  const { topics, courseId, role } = args;

  const [searches, evidenceLists, allowedDocs] = await Promise.all([
    Promise.all(topics.map(t =>
      deps.search(
        t.name,
        args.threshold,
        args.matchCount,
        'quiz',
        role,
        courseId,
        args.expansionEnabled
          ? { enabled: true, definition: t.definition || undefined, keyPoints: t.keyPoints || undefined }
          : undefined,
        [t.id],
      ).catch(err => {
        console.warn(`[quiz-context] zoeken voor "${t.name}" mislukt:`, err);
        return null;
      }),
    )),
    Promise.all(topics.map(t => deps.evidence(t.id).catch(() => [] as DocumentChunk[]))),
    deps.allowedDocumentIds(courseId, role).catch(() => new Set<string>()),
  ]);

  const merged = new Map<string, DocumentChunk>();
  const evidenceKeys = new Set<string>();
  const add = (c: DocumentChunk, isEvidence: boolean) => {
    const k = chunkKey(c);
    const cur = merged.get(k);
    if (!cur || (c.similarity || 0) > (cur.similarity || 0)) merged.set(k, c);
    if (isEvidence) evidenceKeys.add(k);
  };
  for (const s of searches) for (const c of s?.chunks ?? []) add(c, false);
  // Bewijsfragmenten alleen uit documenten die de docent voor de quiz heeft opengezet.
  for (const list of evidenceLists) {
    for (const c of list) {
      if (c.documentId && allowedDocs.has(c.documentId) && (c.content || '').trim()) add(c, true);
    }
  }

  const chunks = [...merged.values()].sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
  const done = searches.filter((s): s is RAGSearchStats => !!s);
  return {
    chunks,
    fromEvidence: chunks.filter(c => evidenceKeys.has(chunkKey(c))).length,
    stats: {
      threshold: args.threshold,
      matchCount: args.matchCount,
      maxSimilarity: Math.max(0, ...done.map(s => s.maxSimilarity)),
      candidatesConsidered: done.reduce((n, s) => n + s.candidatesConsidered, 0),
      searchPerformed: done.some(s => s.searchPerformed),
    },
  };
}
