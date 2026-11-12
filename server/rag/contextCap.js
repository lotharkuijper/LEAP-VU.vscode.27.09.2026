// Cursusfragmenten samenvoegen tot één context voor het taalmodel, met een
// bovengrens aan fragmenten en tekens (gedeeld met de frontend: src/services/rag.service.ts).

export const RAG_CONTEXT_MAX_CHUNKS = 15;
export const RAG_CONTEXT_MAX_CHARS = 18000;

/**
 * Neemt de fragmenten in volgorde (hoogste score eerst) tot de grens is bereikt.
 * @param {Array<{content: string, documentTitle?: string}>} chunks
 */
export function buildContextWithCap(chunks, maxChunks = RAG_CONTEXT_MAX_CHUNKS, maxChars = RAG_CONTEXT_MAX_CHARS) {
  const total = chunks.length;
  if (total === 0) {
    return { context: '', usedChunks: 0, totalChunks: 0, truncated: false, charTrimmed: false };
  }
  const limitN = Math.min(maxChunks, total);
  const SEP = '\n\n---\n\n';
  const parts = [];
  let runningChars = 0;
  let used = 0;
  let charTrimmed = false;
  for (let i = 0; i < limitN; i++) {
    const chunk = chunks[i];
    const header = `[Bron ${i + 1}: ${chunk.documentTitle}]\n`;
    const sepLen = parts.length === 0 ? 0 : SEP.length;
    const headroom = maxChars - runningChars - sepLen - header.length;
    if (headroom <= 0) break; // geen ruimte meer voor de kop van dit fragment
    // Ook het eerste (mogelijk grote) fragment blijft strikt onder maxChars.
    let content = chunk.content;
    if (chunk.content.length > headroom) {
      content = chunk.content.slice(0, Math.max(0, headroom - 20)) + '…[ingekort]';
      charTrimmed = true;
    }
    const part = header + content;
    parts.push(part);
    runningChars += part.length + sepLen;
    used += 1;
  }
  return {
    context: parts.join(SEP),
    usedChunks: used,
    totalChunks: total,
    truncated: used < total || charTrimmed,
    charTrimmed,
  };
}
