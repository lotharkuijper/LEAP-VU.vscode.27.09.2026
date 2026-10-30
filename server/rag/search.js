import { purposeAllowsModule } from './filePurpose.js';
import { AZURE_EMBEDDINGS_READY, OPENAI_EMBEDDINGS_URL, embeddingAuthHeaders } from '../lib/azureOpenai.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { expandQuery } from './queryExpansion.js';

export const RAG_MODULE_DEFAULTS = {
  chat:    { similarity_threshold: 0.70, match_count: 5,  rag_strict_mode: false, query_expansion_enabled: false },
  explain: { similarity_threshold: 0.50, match_count: 5,  rag_strict_mode: true,  query_expansion_enabled: true  },
  quiz:    { similarity_threshold: 0.65, match_count: 5,  rag_strict_mode: true,  query_expansion_enabled: false },
  project: { similarity_threshold: 0.60, match_count: 7,  rag_strict_mode: false, query_expansion_enabled: false },
};

export const RAG_EXTRACTION_DEFAULTS = {
  similarity_threshold: 0.55,
  min_evidence_chunks: 1,
  // null = geen limiet (bestaand gedrag ongewijzigd totdat een docent dit
  // expliciet instelt). Bij een limiet: hoge match en lage overlap gaan
  // voor (selectConcepts), zie POST /api/admin/extract-concepts.
  max_concepts: null,
  // Minimum (2026-10-16): onder het minimum vult LEAP aan met kandidaten die
  // wél bewijs hebben maar onder de bewijsdrempel bleven (te beoordelen), en
  // meldt het anders. Nooit begrippen zonder bewijs. null = geen minimum.
  min_concepts: null,
};

// allowedFolderIds semantiek:
//   null / undefined  → geen folderfilter (alle chunks)
//   []                → expliciet geen toegang (geen resultaten)
//   [id, id, ...]     → alleen chunks uit deze folders
// `module` (optioneel, bv. 'concepts'): sluit documenten uit waarvan het
// bestandsdoel die module niet toestaat (cursusinformatie levert geen begrippen).
export async function searchChunksServerSide(queryText, threshold, matchCount, allowedFolderIds, expansion, lang = 'nl', module = null, opts = {}) {
  if (!AZURE_EMBEDDINGS_READY || !supabaseAdmin) return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery: queryText };

  // Expliciet lege toegestane mappen → geen toegang
  if (Array.isArray(allowedFolderIds) && allowedFolderIds.length === 0) {
    return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery: queryText };
  }
  // opts.documentIds: alleen in deze documenten zoeken (kennis van een persona).
  // Leeg = niets; de mappen dienen dan alleen nog als extra grens.
  if (Array.isArray(opts.documentIds) && opts.documentIds.length === 0) {
    return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery: queryText };
  }

  // Verrijk de zoekterm wanneer expansion-opties zijn meegegeven (synoniemen,
  // definitie, key_points). Dit geeft het embedding-model meer signaal voor
  // korte Nederlandse vaktermen waar text-embedding-3-small anders laag scoort.
  const embedQuery = (expansion && expansion.enabled)
    ? expandQuery(queryText, { definition: expansion.definition, keyPoints: expansion.keyPoints, aliases: expansion.aliases }, lang)
    : queryText;

  try {
    const embRes = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: embeddingAuthHeaders(),
      body: JSON.stringify({ model: 'text-embedding-3-small', input: [embedQuery] }),
    });
    if (!embRes.ok) {
      // Niet stil slikken: een mislukte Azure-embedding (bijv. 404 ontbrekende
      // deployment, 401 verkeerde key) leidde anders tot onzichtbare "0 resultaten".
      const errText = await embRes.text().catch(() => '');
      console.error(`[searchChunksServerSide] Azure embedding-call mislukt: HTTP ${embRes.status} — ${errText.slice(0, 300)}`);
      return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery };
    }
    const embData = await embRes.json();
    const embedding = embData.data?.[0]?.embedding;
    if (!embedding) {
      console.error('[searchChunksServerSide] Azure embedding-respons bevatte geen vector');
      return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery };
    }

    // Bepaal de toegestane documenten VÓÓR de zoekopdracht zodat de
    // vector-zoekfunctie op documentniveau kan filteren (Task #394). Zo wordt de
    // kandidatenpool uit de cursus zelf getrokken in plaats van uit een globale
    // top-N waar een grote multi-cursus-corpus de eigen chunks wegcrowdt.
    let filterDocumentIds = null;
    if (Array.isArray(allowedFolderIds) && allowedFolderIds.length > 0) {
      const { data: docs } = await supabaseAdmin
        .from('documents')
        .select('id, folder_id, purpose')
        .in('folder_id', allowedFolderIds);
      filterDocumentIds = (docs || [])
        .filter(d => !module || purposeAllowsModule(d.purpose, module))
        .map(d => d.id);
      // Geen documenten in de toegestane mappen → niets te vinden.
      if (filterDocumentIds.length === 0) {
        return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery };
      }
    }
    if (Array.isArray(opts.documentIds)) {
      const wanted = new Set(opts.documentIds);
      filterDocumentIds = filterDocumentIds ? filterDocumentIds.filter(id => wanted.has(id)) : [...wanted];
      if (filterDocumentIds.length === 0) {
        return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery };
      }
    }

    // Ruime, cursus-gescopete kandidatenpool: omdat we op documentniveau filteren
    // is een grote pool goedkoop en eerlijk, en blijft een zwak-scorende maar
    // relevante chunk binnen bereik ook als de corpus groeit.
    const { data: candidate, error } = await supabaseAdmin.rpc('match_document_chunks', {
      query_embedding: embedding,
      match_threshold: 0,
      match_count: Math.max(matchCount * 5, 60),
      filter_document_ids: filterDocumentIds,
    });
    if (error || !candidate) {
      if (error) console.error('[searchChunksServerSide] match_document_chunks RPC-fout:', error.message || JSON.stringify(error));
      return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery };
    }

    return {
      matched: candidate.filter(c => c.similarity >= threshold).slice(0, matchCount),
      maxScore: candidate.length > 0 ? Math.max(...candidate.map(c => c.similarity)) : 0,
      candidatesInAllowed: candidate.length,
      embedQuery,
      // De query-embedding zelf teruggeven: extract-concepts hergebruikt hem
      // om kandidaat-begripsnamen onderling te vergelijken (near-duplicate
      // detectie), zonder daarvoor een aparte embedding-call te doen.
      embedding,
    };
  } catch (err) {
    console.error('[searchChunksServerSide] Error:', err.message);
    return { matched: [], maxScore: 0, candidatesInAllowed: 0, embedQuery };
  }
}

export async function loadRagSettings(courseId) {
  if (!supabaseAdmin) return { ...RAG_MODULE_DEFAULTS, extraction: { ...RAG_EXTRACTION_DEFAULTS } };
  const keys = courseId
    ? [`__rag_settings_${courseId}__`, '__rag_settings_global__']
    : ['__rag_settings_global__'];
  for (const key of keys) {
    const { data } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('content')
      .eq('name', key)
      .maybeSingle();
    if (data?.content) {
      try {
        const parsed = JSON.parse(data.content);
        const merged = {};
        for (const mod of Object.keys(RAG_MODULE_DEFAULTS)) {
          merged[mod] = { ...RAG_MODULE_DEFAULTS[mod], ...(parsed[mod] || {}) };
        }
        merged.extraction = { ...RAG_EXTRACTION_DEFAULTS, ...(parsed.extraction || {}) };
        return merged;
      } catch { /* fall through to next key */ }
    }
  }
  return { ...RAG_MODULE_DEFAULTS, extraction: { ...RAG_EXTRACTION_DEFAULTS } };
}
