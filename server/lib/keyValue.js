// Kleine sleutel-waardeopslag in chatbot_prompts (is_active = false), voor
// administratie per cursus die geen eigen tabel waard is. Sleutels met het
// voorvoegsel __ worden overal uitgesloten waar prompts worden getoond of gekozen.

/** Laatste begrippenzoektocht + doorzochte documenten (server/concepts/conceptSearchScope.js). */
export const conceptRegenKey = (courseId) => `__concepts_regen_${courseId}__`;
/** Begrippen die de docent verwijderde: komen bij zoeken niet vanzelf terug. */
export const conceptRemovedKey = (courseId) => `__concepts_regen_removed_${courseId}__`;
/** Weggeklikte samenvoegvoorstellen. */
export const mergeDismissKey = (courseId) => `__concepts_regen_merge_dismissed_${courseId}__`;
/** Laatste wijziging aan de cursusdocumenten. */
export const docMutationKey = (courseId) => `__doc_mutation_${courseId}__`;

export async function readKeyValue(db, name) {
  const { data } = await db.from('chatbot_prompts').select('content').eq('name', name).maybeSingle();
  return data?.content ?? null;
}

export async function writeKeyValue(db, name, content) {
  const { data: existing } = await db.from('chatbot_prompts').select('id').eq('name', name).maybeSingle();
  if (existing) {
    await db.from('chatbot_prompts').update({ content, updated_at: new Date().toISOString() }).eq('name', name);
  } else {
    await db.from('chatbot_prompts').insert({ name, content, is_active: false });
  }
}
