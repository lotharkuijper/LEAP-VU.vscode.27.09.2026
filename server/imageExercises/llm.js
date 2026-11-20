// Het taalmodel met een JSON-antwoord, voor beeldoefeningen (docent- en studentkant).
// Gooit bij een fout; de aanroeper beslist over een tweede poging of een terugval.
import { OPENAI_MODEL, chatModelParams, openaiChatCompletion } from '../lib/azureOpenai.js';

/** Platte tekst (bijvoorbeeld een dagboeknotitie met vaste kopjes); '' bij een leeg antwoord. */
export async function llmText(prompt, maxTokens = 900) {
  const resp = await openaiChatCompletion({
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    ...chatModelParams({ temperature: 0.3, maxTokens }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(`taalmodel ${resp.status}`);
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

export async function llmJson(messages, maxTokens = 3000) {
  const resp = await openaiChatCompletion({
    model: OPENAI_MODEL,
    messages,
    response_format: { type: 'json_object' },
    ...chatModelParams({ temperature: 0.1, maxTokens }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(`taalmodel ${resp.status}`);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('leeg antwoord');
  return JSON.parse(content);
}
