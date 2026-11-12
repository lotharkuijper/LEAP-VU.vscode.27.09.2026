// Quizvragen maken en lezen (2026-11-12, verhuisd uit de browser naar de server).
//
// De server maakt de vragen, zodat de antwoordsleutel bij de server blijft: de
// browser krijgt een vraag zonder juist antwoord, uitleg, modelantwoord of
// rubric (publicQuestion), en ziet die pas nadat de student heeft geantwoord.
// Puur: geen I/O. Het taalmodel wordt aangeroepen in quizSession.js.

import { languageEnglishName, normalizeLang } from '../i18n/languages.js';

export const QUESTION_TYPES = ['mcq', 'open', 'casus'];
export const DIFFICULTIES = ['easy', 'medium', 'hard'];
export const QUIZ_GENERATION_TEMPERATURE = 0.2;

const RAG_STRICT_INSTRUCTION = `\n\nSTRIKTE BRONBEPERKING: Gebruik UITSLUITEND de context die hierboven is meegegeven. Ga NIET buiten deze bronnen. Als iets niet in de meegeleverde context staat, zeg dan eerlijk: "Dit onderwerp staat niet in het beschikbare cursusmateriaal."`;
const SECOND_PERSON_RULE_NL = `Aanspraakvorm (volg STRIKT): spreek de student direct aan met "je" / "jij" / "jouw". Gebruik NOOIT "de student", "deze student" of "de student heeft" — schrijf alsof je het één-op-één tegen de student zegt.`;
const SECOND_PERSON_RULE_EN = `Addressing rule (follow STRICTLY): address the student directly using "you" / "your". NEVER use "the student", "this student" or "the student has" — write as if giving feedback one-on-one.`;
export const secondPersonRule = (lang) => (normalizeLang(lang) !== 'nl' ? SECOND_PERSON_RULE_EN : SECOND_PERSON_RULE_NL);

const difficultyWord = (d, lang) => (normalizeLang(lang) !== 'nl'
  ? d
  : (d === 'easy' ? 'makkelijke' : d === 'medium' ? 'gemiddelde' : 'moeilijke'));

/**
 * Voor talen anders dan NL/EN: in welke taal de vragen moeten staan. NL en EN
 * hebben een eigen volledige prompt.
 */
function outputLanguageDirective(lang) {
  const code = normalizeLang(lang);
  if (code === 'nl' || code === 'en') return '';
  const name = languageEnglishName(code);
  if (!name) return '';
  return `\n\nLANGUAGE REQUIREMENT (follow strictly): Write all human-readable text — every question, every answer option, every explanation, model answer and rubric — in ${name}. Do not write in English or Dutch. Keep the JSON structure intact: do NOT translate or rename any JSON property names/keys (they must stay exactly as specified, in English), and keep fixed/structural values exactly as generated — in particular the \`type\` field (e.g. "mcq", "open", "casus"), the \`topic\` field and any numeric fields or indices. Translate ONLY the human-readable text values.`;
}

function contextSection(ragContext, strict) {
  if (!ragContext) return '';
  return `\n\nGebruik de volgende informatie uit het cursusmateriaal als basis voor de vragen:\n${ragContext}${strict ? RAG_STRICT_INSTRUCTION : ''}\n`;
}

// Bij meer dan één onderwerp noemt elke vraag zijn onderwerp: zo telt een
// antwoord mee voor het juiste begrip (quizbadges per begrip).
function topicFieldRule(topics, en) {
  if (topics.length < 2) return '';
  const list = topics.map(t => `"${t}"`).join(', ');
  return en
    ? `\n- Give each question a "topic": exactly one of ${list}, copied literally — the topic the question is mainly about.`
    : `\n- Geef elke vraag een "topic": precies één van ${list}, letterlijk overgenomen — het onderwerp waar de vraag vooral over gaat.`;
}

/** De opdracht aan het taalmodel om quizvragen te schrijven. */
export function buildGenerationPrompt({ topics, difficulty, questionType, count, ragContext, strict, lang = 'nl' }) {
  const en = normalizeLang(lang) !== 'nl';
  const ctx = contextSection(ragContext, strict);
  const topicsLabel = en
    ? (topics.length === 1 ? `the topic "${topics[0]}"` : `the topics ${topics.map(t => `"${t}"`).join(', ')}`)
    : (topics.length === 1 ? `het onderwerp "${topics[0]}"` : `de onderwerpen ${topics.map(t => `"${t}"`).join(', ')}`);
  const diff = difficultyWord(difficulty, lang);
  const topicRule = topicFieldRule(topics, en);
  const topicJson = topics.length > 1 ? `,\n    "topic": "${topics[0]}"` : '';

  let core;
  let example;
  if (questionType === 'mcq') {
    core = en
      ? `Generate ${count} ${diff} multiple-choice questions about ${topicsLabel}.${ctx}

For each question:
- Write a clear, specific question.
- Provide exactly 4 answer options (A, B, C, D).
- Indicate which answer is correct (0, 1, 2 or 3).
- Provide a brief explanation of why this answer is correct. Write the explanation in second person ("you"/"your") addressing the student.${topicRule}`
      : `Genereer ${count} ${diff} meerkeuzevragen over ${topicsLabel}.${ctx}

Voor elke vraag:
- Maak een duidelijke, specifieke vraag.
- Geef exact 4 antwoordopties (A, B, C, D).
- Geef aan welk antwoord correct is (0, 1, 2 of 3).
- Geef een korte uitleg waarom dit antwoord correct is. Schrijf de uitleg in tweede persoon ("je"/"jij") gericht aan de student.${topicRule}`;
    example = en
      ? `[\n  {\n    "type": "mcq",\n    "question": "The question here",\n    "options": ["Option A", "Option B", "Option C", "Option D"],\n    "correctAnswer": 0,\n    "explanation": "Explanation of why this is correct, directed at you"${topicJson}\n  }\n]`
      : `[\n  {\n    "type": "mcq",\n    "question": "De vraag hier",\n    "options": ["Optie A", "Optie B", "Optie C", "Optie D"],\n    "correctAnswer": 0,\n    "explanation": "Uitleg waarom dit correct is, gericht aan jou"${topicJson}\n  }\n]`;
  } else if (questionType === 'open') {
    core = en
      ? `Generate ${count} ${diff} open questions about ${topicsLabel}.${ctx}

For each question:
- Ask an open question (not multiple choice) that the student can answer in 3–8 sentences.
- Provide a "modelAnswer": an ideal answer of approximately 4–8 sentences containing the key points.
- Provide a "rubric": brief assessment criteria (3–5 bullets, in one string with newlines) with which an evaluator can later score the student answer.${topicRule}`
      : `Genereer ${count} ${diff} open vragen over ${topicsLabel}.${ctx}

Voor elke vraag:
- Stel een open vraag (geen meerkeuze) waarop de student in 3–8 zinnen een inhoudelijk antwoord kan geven.
- Geef een "modelAnswer": een ideaal antwoord van ongeveer 4–8 zinnen dat de kernpunten bevat.
- Geef een "rubric": korte beoordelingscriteria (3–5 bullets, in één string met newlines) waarmee een beoordelaar later het studentantwoord kan scoren.${topicRule}`;
    example = en
      ? `[\n  {\n    "type": "open",\n    "question": "The open question here",\n    "modelAnswer": "A worked-out example answer of a few sentences.",\n    "rubric": "- Mentions definition X\\n- References mechanism Y\\n- Provides an example"${topicJson}\n  }\n]`
      : `[\n  {\n    "type": "open",\n    "question": "De open vraag hier",\n    "modelAnswer": "Een uitgewerkt voorbeeldantwoord van enkele zinnen.",\n    "rubric": "- Noemt definitie X\\n- Verwijst naar mechanisme Y\\n- Geeft een voorbeeld"${topicJson}\n  }\n]`;
  } else {
    core = en
      ? `Generate ${count} ${diff} case study questions about ${topicsLabel}.${ctx}

For each case:
- Write a short, realistic problem sketch ("context") of 3–6 sentences describing a research or practical situation relevant to ${topicsLabel}.
- Then ask one clear question ("question") that forces the student to approach the problem analytically.
- Provide a "modelAnswer": an ideal answer of approximately 5–8 sentences.
- Provide a "rubric": brief assessment criteria (3–5 bullets, in one string with newlines).${topicRule}`
      : `Genereer ${count} ${diff} casusvragen over ${topicsLabel}.${ctx}

Voor elke casus:
- Schrijf eerst een korte, realistische probleemschets ("context") van 3–6 zinnen waarin een onderzoeks- of praktijksituatie wordt geschetst die past bij ${topicsLabel}.
- Stel daarna één duidelijke vraag ("question") die de student dwingt het probleem analytisch te benaderen.
- Geef een "modelAnswer": een ideaal antwoord van ongeveer 5–8 zinnen.
- Geef een "rubric": korte beoordelingscriteria (3–5 bullets, in één string met newlines).${topicRule}`;
    example = en
      ? `[\n  {\n    "type": "casus",\n    "context": "Short case description of a few sentences.",\n    "question": "The question for this case",\n    "modelAnswer": "A worked-out example answer of a few sentences.",\n    "rubric": "- Names the core of the case\\n- Applies the right course concept\\n- Gives a well-founded conclusion"${topicJson}\n  }\n]`
      : `[\n  {\n    "type": "casus",\n    "context": "Korte casusbeschrijving van enkele zinnen.",\n    "question": "De vraag bij deze casus",\n    "modelAnswer": "Een uitgewerkt voorbeeldantwoord van enkele zinnen.",\n    "rubric": "- Benoemt de kern van de casus\\n- Past het juiste begrip uit de cursus toe\\n- Geeft een onderbouwde conclusie"${topicJson}\n  }\n]`;
  }

  const format = en
    ? `Format your answer as a JSON array with this structure:\n${example}\n\nIMPORTANT: Return ONLY the JSON array, no extra text, no markdown code block.`
    : `Formatteer je antwoord als een JSON array met deze structuur:\n${example}\n\nBELANGRIJK: Geef ALLEEN de JSON array terug, geen extra tekst, geen markdown-codeblok.`;
  return `${core}\n\n${secondPersonRule(lang)}\n\n${format}${outputLanguageDirective(lang)}`;
}

/** Maximaal aantal teken-budget per generatie (casus is langer). */
export const generationMaxTokens = (questionType) => (questionType === 'casus' ? 3000 : 2048);

/** Leest het eerste JSON-array of -object uit een antwoord van het taalmodel. */
export function extractJSON(content, kind) {
  const re = kind === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const match = String(content || '').match(re);
  const fail = (detail) => Object.assign(new Error('Het taalmodel gaf geen leesbaar antwoord.'), { code: 'invalid_response_format', status: 502, detail });
  if (!match) throw fail(String(content || '').slice(0, 400));
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    throw fail(err?.message || 'JSON parse error');
  }
}

/** Een weigering van het taalmodel die als vraag is opgemaakt. */
export function isRefusalQuestion(q) {
  const lower = String(q?.question || '').toLowerCase();
  return (
    lower.includes('staat niet in het beschikbare')
    || lower.includes('kan ik geen vraag')
    || lower.includes('niet in het cursusmateriaal')
    || lower.includes('geen relevante')
    || lower.includes('not in the available')
    || lower.includes('cannot generate')
    || lower.includes('unable to generate')
    || lower.includes('i cannot create')
  );
}

/**
 * Vragen uit een antwoord van het taalmodel. Een ontbrekend of vertaald type
 * wordt het gevraagde type; weigeringen vallen weg.
 */
export function parseGeneratedQuestions(content, questionType) {
  const parsed = extractJSON(content, 'array');
  return parsed
    .filter(q => q && typeof q === 'object')
    .map(q => ({ ...q, type: QUESTION_TYPES.includes(q.type) ? q.type : questionType }))
    .filter(q => !isRefusalQuestion(q));
}

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/** Een reden als de vraag structureel ongeldig is, anders null. */
export function checkQuestionStructure(q) {
  if (!q || typeof q !== 'object') return 'geen vraag-object';
  if (!nonEmpty(q.question)) return 'lege vraagtekst';
  if (q.type === 'mcq') {
    if (!Array.isArray(q.options) || q.options.length !== 4) return 'MCQ heeft niet precies 4 opties';
    if (!q.options.every(nonEmpty)) return 'MCQ heeft een lege optie';
    const norm = q.options.map(o => o.trim().toLowerCase());
    if (new Set(norm).size !== norm.length) return 'MCQ heeft dubbele opties';
    if (!Number.isInteger(q.correctAnswer) || q.correctAnswer < 0 || q.correctAnswer > 3) {
      return 'MCQ heeft geen geldige antwoordindex (0–3)';
    }
    if (!nonEmpty(q.explanation)) return 'MCQ mist een uitleg';
    return null;
  }
  if (q.type === 'open' || q.type === 'casus') {
    if (!nonEmpty(q.modelAnswer)) return 'modelantwoord ontbreekt';
    if (!nonEmpty(q.rubric)) return 'rubric ontbreekt';
    if (q.type === 'casus' && !nonEmpty(q.context)) return 'casusbeschrijving ontbreekt';
    return null;
  }
  return `onbekend vraagtype: ${String(q.type)}`;
}

/** Wat de browser van een vraag ziet vóór het antwoord: geen sleutel, uitleg of rubric. */
export function publicQuestion(q, index) {
  const base = { index, type: q.type, question: q.question, source: q.source || null };
  if (q.type === 'mcq') return { ...base, options: q.options };
  if (q.type === 'casus') return { ...base, context: q.context };
  return q.extype ? { ...base, extype: q.extype } : base;
}

/** Wat de browser na het antwoord van een vraag te zien krijgt. */
export function revealQuestion(q) {
  if (q.type === 'mcq') return { correctAnswer: q.correctAnswer, explanation: q.explanation };
  return { modelAnswer: q.modelAnswer, rubric: q.rubric };
}

/** Het begrip waar een vraag over gaat: het enige onderwerp, of het genoemde "topic". */
export function conceptForQuestion(q, concepts) {
  if (concepts.length === 1) return concepts[0].id;
  if (q.conceptId && concepts.some(c => c.id === q.conceptId)) return q.conceptId;
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const t = norm(q.topic);
  return (t && concepts.find(c => norm(c.name) === t)?.id) || null;
}

// ── ItemBank ────────────────────────────────────────────────────────────────

/** ItemBank-meerkeuzevraag (letter-sleutels) naar het interne formaat. */
export function convertItembankMcqQuestion(q) {
  const keys = Object.keys(q.options || {}).sort();
  return {
    type: 'mcq',
    question: q.question,
    options: keys.map(k => q.options[k]),
    correctAnswer: Math.max(0, keys.indexOf(q.correctAnswer)),
    explanation: q.explanation || '',
    source: 'itembank',
    conceptId: q.conceptId || null,
  };
}

/** Open ItemBank-vraag met een rubric die past bij het soort antwoord (Task #67). */
export function convertItembankOpenQuestion(q) {
  const extype = (q.extype || '').toLowerCase();
  let rubric;
  if (extype === 'num' && typeof q.numericExpected === 'number') {
    const tol = q.numericTolerance && q.numericTolerance > 0
      ? `binnen een tolerantie van ±${q.numericTolerance} (R/exams extol)`
      : 'strikt (geen extol-tolerantie opgegeven)';
    rubric = `- Numeriek antwoord: het verwachte getal is ${q.numericExpected}.\n`
      + `- Beoordeel ${tol}.\n`
      + `- Negeer eenheden, korte toelichting of komma vs. punt; vergelijk alleen het getal.`;
  } else if (extype === 'cloze') {
    rubric = `- Cloze-vraag uit de ItemBank: vergelijk elk deelantwoord met het ShareStats-modelantwoord hieronder.\n`
      + `- Geef alleen volle punten als alle deelantwoorden inhoudelijk kloppen; bij gedeeltelijk juiste invulling proportioneel scoren.\n`
      + `- Wees mild met spelling/notatie zolang de bedoelde term ondubbelzinnig is.`;
  } else if (extype === 'string') {
    rubric = `- Open ItemBank-tekstvraag: het ShareStats-modelantwoord (Solution) is leidend.\n`
      + `- Beoordeel of de kerntermen en kernredeneringen uit het modelantwoord aanwezig zijn.\n`
      + `- Accepteer synoniemen of een eigen verwoording, mits de vakinhoud klopt.`;
  } else if (q.explanation && q.explanation.trim().length > 0) {
    rubric = `Vergelijk het studentantwoord met het ShareStats-modelantwoord uit de ItemBank:\n${q.explanation.trim()}`;
  } else {
    rubric = 'Beoordeel of het antwoord van de student inhoudelijk overeenkomt met het modelantwoord uit de ItemBank.';
  }
  return {
    type: 'open',
    question: q.question,
    modelAnswer: q.modelAnswer || '',
    rubric,
    source: 'itembank',
    extype: q.extype,
    numericExpected: q.numericExpected,
    numericTolerance: q.numericTolerance,
    conceptId: q.conceptId || null,
  };
}
