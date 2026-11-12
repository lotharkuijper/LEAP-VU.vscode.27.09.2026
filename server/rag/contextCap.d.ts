// Typen voor server/rag/contextCap.js (gedeeld met de frontend).
export const RAG_CONTEXT_MAX_CHUNKS: number;
export const RAG_CONTEXT_MAX_CHARS: number;

export interface FormattedContext {
  context: string;
  usedChunks: number;
  totalChunks: number;
  truncated: boolean;
  charTrimmed: boolean;
}

export function buildContextWithCap(
  chunks: Array<{ content: string; documentTitle?: string }>,
  maxChunks?: number,
  maxChars?: number,
): FormattedContext;
