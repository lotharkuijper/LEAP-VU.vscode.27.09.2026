// Pure helper rond OpenAI sampling-parameters, los van server/index.js zodat
// hij in tests geïmporteerd kan worden zonder de hele Express-app te starten.

// Sommige reasoning-modellen (o1/o3/o4 en bepaalde gpt-5-varianten) accepteren
// alleen de standaard 'temperature'/'top_p' en weigeren een aangepaste waarde
// met een 400. Detecteer die specifieke fout zodat de aanroeper het verzoek
// één keer opnieuw kan doen zonder die sampling-parameters in plaats van te
// falen met "het taalmodel weigerde het verzoek".
export function isUnsupportedSamplingParamError(data) {
  const err = data && data.error;
  if (!err) return false;
  const param = (err.param || '').toLowerCase();
  if (param === 'temperature' || param === 'top_p') return true;
  const msg = (err.message || '').toLowerCase();
  return (
    (msg.includes('temperature') || msg.includes('top_p')) &&
    (msg.includes('unsupported') ||
      msg.includes('does not support') ||
      msg.includes('only the default') ||
      msg.includes('not supported'))
  );
}

// Reasoning-modellen (gpt-5/o1/o3/o4) verbruiken hun tokenbudget deels aan
// 'reasoning'. Bij een zware, gestructureerde opdracht kan een chat-completion
// daardoor een HTTP 200 met lege of afgekapte content opleveren
// (finish_reason: "length"). Detecteer dat zodat de aanroeper één keer opnieuw
// kan proberen met een ruimer budget i.p.v. een misleidende lege 200 door te
// geven. Een succesvolle respons met echte tekst en finish_reason "stop"
// levert hier false op.
export function isEmptyOrTruncatedCompletion(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : undefined;
  if (!choice) return true;
  const content = choice.message && choice.message.content;
  if (!content || !String(content).trim()) return true;
  if (choice.finish_reason === 'length') return true;
  return false;
}

// Extra tokenruimte bovenop de bedoelde antwoordlengte voor reasoning-modellen.
// Bij gpt-5.x telt max_completion_tokens de interne reasoning mee, en een
// antwoord dat het budget overschrijdt komt LEEG terug (finish_reason
// "length", alle tokens als reasoning geteld) in plaats van afgekapt. Gemeten
// 2026-09-27: een persona-antwoord van ~1300–1700 tokens bij een budget van
// 700 gaf structureel "(Geen antwoord)". Alleen werkelijk gebruikte tokens
// worden gerekend, dus ruimte geven kost niets extra.
export const REASONING_TOKEN_HEADROOM = 2000;

/** Pure: het max-tokens-budget dat we naar het model sturen. */
export function completionTokenBudget(maxTokens, isReasoningModel) {
  if (maxTokens == null) return maxTokens;
  return isReasoningModel ? maxTokens + REASONING_TOKEN_HEADROOM : maxTokens;
}

// Gedeelde helper voor álle chat-completion-aanroepen (quiz, beoordeling,
// project-evaluatie, samenvattingen, …). Doet de POST en, wanneer het model een
// aangepaste temperature/top_p weigert met een 400, probeert het verzoek één
// keer opnieuw zonder die sampling-parameters. response_format, token-limieten
// en alle overige velden blijven ongemoeid. De auth-headers worden door de
// aanroeper meegegeven (Azure 'api-key' of OpenAI 'Authorization: Bearer'),
// zodat dezelfde helper voor zowel Azure als publieke OpenAI werkt.
//
// Geeft een Response-achtig object terug ({ ok, status, json(), text() }) zodat
// bestaande aanroepers — die `.ok`, `.status`, `await resp.json()` of
// `await resp.text()` gebruiken — vrijwel ongewijzigd kunnen blijven. De body
// wordt intern al gelezen; json()/text() leveren de gecachte waarde.
//
// Optioneel (standaard uit, zodat bestaand gedrag gelijk blijft):
//  * timeoutMs: breek een hangende aanroep af en geef status 504 terug
//    (`timedOut: true`) i.p.v. minutenlang te wachten tot Azure zelf opgeeft;
//  * transientRetries: probeer bij een tijdelijke storing (429/500/502/503/504
//    van het model) nog zo vaak opnieuw, na een korte pauze. Een eigen
//    time-out wordt NIET herhaald: dan zou de gebruiker twee keer zo lang wachten.
export const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

export async function postChatCompletionWithRetry({
  url, headers, body, fetchImpl = fetch, timeoutMs = null, transientRetries = 0, retryDelayMs = 1500,
}) {
  const doFetch = async (b) => {
    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let r;
    try {
      r = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(headers || {}) },
        body: JSON.stringify(b),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (err) {
      if (controller && controller.signal.aborted) {
        const rawText = JSON.stringify({ error: { code: 'timeout', message: `Geen antwoord van het taalmodel binnen ${Math.round(timeoutMs / 1000)} s` } });
        return { r: { ok: false, status: 504 }, rawText, parsed: JSON.parse(rawText), timedOut: true };
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const rawText = await r.text();
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }
    return { r, rawText, parsed };
  };

  let sendBody = body;
  let { r, rawText, parsed, timedOut } = await doFetch(sendBody);

  if (!r.ok && r.status === 400 && isUnsupportedSamplingParamError(parsed)) {
    const { temperature: _t, top_p: _tp, ...retryBody } = body;
    console.warn(
      `[openai] Model ${body && body.model} accepteert geen aangepaste temperature/top_p — opnieuw zonder die parameters.`,
    );
    sendBody = retryBody;
    ({ r, rawText, parsed, timedOut } = await doFetch(sendBody));
  }

  for (let attempt = 0; attempt < transientRetries && !r.ok && !timedOut && TRANSIENT_STATUSES.has(r.status); attempt++) {
    console.warn(`[openai] Tijdelijke fout van het taalmodel (HTTP ${r.status}) — opnieuw over ${retryDelayMs} ms (poging ${attempt + 2}).`);
    if (retryDelayMs > 0) await new Promise((res) => setTimeout(res, retryDelayMs));
    ({ r, rawText, parsed, timedOut } = await doFetch(sendBody));
  }

  return {
    ok: r.ok,
    status: r.status,
    timedOut: !!timedOut,
    json: async () => parsed,
    text: async () => rawText,
  };
}
