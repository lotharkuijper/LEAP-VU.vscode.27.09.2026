import { computeChatConfig } from '../chat/chatConfig.js';
import { embeddingsRequestWithRetry } from './embeddingsRetry.js';
import { completionTokenBudget, postChatCompletionWithRetry } from './openaiSampling.js';

// === Azure OpenAI (chat/completions) ===
// Alle chat-/completion-aanroepen lopen via de Azure OpenAI-resource van de VU
// (leap-openai-vu). Routing gebeurt via de deployment in de URL; authenticatie
// via de 'api-key'-header (niet Bearer). Embeddings lopen óók via Azure — zie de
// embedding-config hieronder (text-embedding-3-small, géén publieke OpenAI).
// De chat-configuratie (URL + guard) wordt door een pure helper berekend zodat
// hij in tests verifieerbaar is zonder de Express-app te starten. Géén
// OpenAI-fallback voor chat: als Azure niet is geconfigureerd blijft de URL
// leeg en falen chat-calls expliciet (de endpoints gaten bovendien op
// AZURE_CHAT_READY). Zie server/chat/chatConfig.js + chatConfig.test.js (Task #249).
export const {
  endpoint: AZURE_OPENAI_ENDPOINT,
  apiKey: AZURE_OPENAI_API_KEY,
  apiVersion: AZURE_OPENAI_API_VERSION,
  deployment: AZURE_OPENAI_DEPLOYMENT,
  azureChatReady: AZURE_CHAT_READY,
  chatUrl: OPENAI_CHAT_URL,
} = computeChatConfig(process.env);

export const LLM_NOT_CONFIGURED_MSG = 'Azure OpenAI is niet geconfigureerd op de server (AZURE_OPENAI_ENDPOINT en AZURE_OPENAI_API_KEY ontbreken).';

console.log(`[API Server] Azure chat ${AZURE_CHAT_READY ? 'gereed' : 'NIET geconfigureerd'} — deployment=${AZURE_OPENAI_DEPLOYMENT}, api-version=${AZURE_OPENAI_API_VERSION}`);

// Auth-headers voor een chat-call. Azure verwacht de 'api-key'-header.
export function chatAuthHeaders() {
  return { 'api-key': AZURE_OPENAI_API_KEY, 'Content-Type': 'application/json' };
}

export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// GPT-5 en o1/o3 modellen accepteren geen 'max_tokens' meer; ze vereisen
// 'max_completion_tokens'. We detecteren dat aan de modelnaam zodat alle
// fetches automatisch de juiste sleutel meesturen.
export const IS_REASONING_MODEL = /^(gpt-5|o1|o3|o4)/i.test(OPENAI_MODEL);

export const MAX_TOKENS_PARAM = IS_REASONING_MODEL
  ? 'max_completion_tokens'
  : 'max_tokens';

// Reasoning-modellen verbruiken een deel van het tokenbudget aan 'reasoning'.
// Houd die inspanning laag zodat er ruimte overblijft voor zichtbare output;
// non-reasoning-modellen kennen deze parameter niet (zou een 400 geven).
export const REASONING_EFFORT = 'low';

// Model-afhankelijke parameters voor de "satelliet"-LLM-aanroepen (quizgeneratie,
// beoordeling, samenvattingen, project-evaluaties, document-oordelen, cues, …).
// Reasoning-modellen (gpt-5.x / o1 / o3 / o4) weigeren een aangepaste temperature/
// top_p met een HTTP 400 en gebruiken in plaats daarvan 'reasoning_effort'; non-
// reasoning-modellen krijgen de meegegeven temperature. De juiste max-tokens-sleutel
// (max_completion_tokens vs max_tokens) wordt altijd gezet. Het centrale /api/chat-
// pad heeft zijn eigen, uitgebreidere afhandeling (retry + lege/afgekapte detectie).
// `maxTokens` is de bedoelde antwoordlengte; reasoning-modellen krijgen daar
// ruimte bovenop (completionTokenBudget), anders komt een te lang antwoord leeg
// terug in plaats van afgekapt.
export function chatModelParams({ temperature, maxTokens, reasoningEffort } = {}) {
  const params = {};
  if (maxTokens != null) params[MAX_TOKENS_PARAM] = completionTokenBudget(maxTokens, IS_REASONING_MODEL);
  if (IS_REASONING_MODEL) {
    params.reasoning_effort = reasoningEffort || REASONING_EFFORT;
  } else if (temperature != null) {
    params.temperature = temperature;
  }
  return params;
}

// === Azure OpenAI (embeddings) ===
// Embeddings (RAG-ingestie, RAG-zoekvragen, concept-extractie) lopen óók via de
// Azure OpenAI-resource van de VU (text-embedding-3-small). Net als bij chat:
// routing via de deployment-naam in de URL, authenticatie via de 'api-key'-header.
// Géén terugval naar de publieke OpenAI-API: zonder embedding-deployment
// (AZURE_OPENAI_EMBEDDING_DEPLOYMENT) is AZURE_EMBEDDINGS_READY=false en falen
// alle embedding-calls expliciet met een 503.
export const AZURE_OPENAI_EMBEDDING_DEPLOYMENT = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || '';

export const AZURE_OPENAI_EMBEDDING_API_VERSION = process.env.AZURE_OPENAI_EMBEDDING_API_VERSION || AZURE_OPENAI_API_VERSION;

export const AZURE_EMBEDDINGS_READY = Boolean(AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_API_KEY && AZURE_OPENAI_EMBEDDING_DEPLOYMENT);

export const OPENAI_EMBEDDINGS_URL = AZURE_EMBEDDINGS_READY
  ? `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${encodeURIComponent(AZURE_OPENAI_EMBEDDING_DEPLOYMENT)}/embeddings?api-version=${AZURE_OPENAI_EMBEDDING_API_VERSION}`
  : '';

export const EMBEDDINGS_NOT_CONFIGURED_MSG = 'Azure OpenAI embeddings zijn niet geconfigureerd op de server (AZURE_OPENAI_EMBEDDING_DEPLOYMENT ontbreekt). Embeddings/RAG lopen uitsluitend via VU-Azure; er is geen terugval naar de publieke OpenAI.';

// Auth-headers voor een embedding-call. Azure verwacht de 'api-key'-header.
export function embeddingAuthHeaders() {
  return { 'api-key': AZURE_OPENAI_API_KEY, 'Content-Type': 'application/json' };
}

console.log(`[API Server] Azure embeddings ${AZURE_EMBEDDINGS_READY ? 'gereed' : 'NIET geconfigureerd'} — deployment=${AZURE_OPENAI_EMBEDDING_DEPLOYMENT || '(leeg)'}, api-version=${AZURE_OPENAI_EMBEDDING_API_VERSION}`);

// Thin wrapper rond postChatCompletionWithRetry: alle "satelliet" chat-completion-
// aanroepen (quiz, beoordeling, project-evaluatie, samenvattingen) lopen hierdoor,
// zodat ze (1) de Azure-auth-headers + Azure-URL gebruiken en (2) bij een 400 op
// temperature/top_p één keer opnieuw proberen zonder die params. De body bevat
// model/messages plus de via chatModelParams() opgebouwde sampling-parameters.
// Een tijdelijke storing van Azure (429/5xx) wordt één keer opnieuw geprobeerd;
// een aanroeper die snel moet reageren (persona-chat) geeft een timeoutMs mee.
export function openaiChatCompletion(body, { timeoutMs = null, transientRetries = 1 } = {}) {
  return postChatCompletionWithRetry({ url: OPENAI_CHAT_URL, headers: chatAuthHeaders(), body, timeoutMs, transientRetries });
}

// Kleine pauze tussen embedding-batches om bursts richting de Azure-limiet te
// dempen (vooral bij documenten met veel chunks).
const EMBEDDINGS_BATCH_PACING_MS = 250;

export const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Één embeddings-batch via Azure met herhaalpoging + backoff bij 429
// (snelheidslimiet). Injecteert de echte server-afhankelijkheden in de
// testbare helper uit ./embeddingsRetry.js.
export function embedBatchWithRetry(input) {
  return embeddingsRequestWithRetry(input, {
    fetchImpl: fetch,
    url: OPENAI_EMBEDDINGS_URL,
    headers: embeddingAuthHeaders,
    sleep: sleepMs,
    log: (msg) => console.warn(msg),
  });
}

// Embed een lijst teksten via Azure (text-embedding-3-small), gebatcht. Bij een
// Azure-snelheidslimiet (HTTP 429) wacht elke batch automatisch de gevraagde
// tijd en probeert opnieuw i.p.v. het hele document te laten falen.
export async function embedTextsServer(texts, _openaiKey, batchSize = 64) {
  if (!AZURE_EMBEDDINGS_READY) throw new Error(EMBEDDINGS_NOT_CONFIGURED_MSG);
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const data = await embedBatchWithRetry(batch);
    for (const row of data.data) out.push(row.embedding);
    if (i + batchSize < texts.length) {
      await sleepMs(EMBEDDINGS_BATCH_PACING_MS);
    }
  }
  return out;
}
