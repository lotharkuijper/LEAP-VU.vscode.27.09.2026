import { userHasCourseAccess } from '../lib/auth.js';
import { pgPool, supabaseAdmin } from '../lib/supabase.js';

export const FALLBACK_SYSTEM_PROMPT = `Je bent een Socratische tutor aan de VU Amsterdam. Je begeleidt studenten door een balans van korte uitleg en uitdagende vragen.

Regels:
1. Geef ALTIJD eerst 2-3 zinnen heldere uitleg over het concept
2. Volg op met één uitdagende vervolgvraag die aanzet tot kritisch denken
3. Houd antwoorden beknopt — vermijd lange theoretische uiteenzettingen
4. Geef studenten genoeg context om zelfstandig na te denken
5. Prijs deelantwoorden en moedig studenten aan dieper na te denken`;

// Per-cursus uitleg-prompt wordt — net als de RAG-instellingen — opgeslagen als
// een speciaal-genoemde chatbot_prompts-rij `__explain_prompt_<courseId>__`
// (section='internal', is_active=false) zodat de globale resolver en de
// admin-sectieweergave er niet door vervuild raken. Geen schemawijziging nodig.
export const EXPLAIN_PROMPT_KEY_PREFIX = '__explain_prompt_';

export function explainPromptKey(courseId) {
  return `${EXPLAIN_PROMPT_KEY_PREFIX}${courseId}__`;
}

// Per-cursus tutor-chat-prompt-override (Task #334). Zelfde patroon als de
// uitleg-prompt: een speciaal-genoemde chatbot_prompts-rij
// `__chat_prompt_<courseId>__` (section='internal', is_active=false) zodat de
// globale chat-resolver (`section='chat'`, is_active=true) en de admin-
// sectieweergave er niet door vervuild raken. Geen schemawijziging nodig.
export const CHAT_PROMPT_KEY_PREFIX = '__chat_prompt_';

export function chatPromptKey(courseId) {
  return `${CHAT_PROMPT_KEY_PREFIX}${courseId}__`;
}

export async function loadGlobalChatPrompt() {
  try {
    const quizNamesExclude = Object.keys(QUIZ_PROMPT_DEFAULTS);
    let q = supabaseAdmin
      .from('chatbot_prompts')
      .select('id, content')
      .eq('is_active', true)
      .not('name', 'like', '__rag_settings%')
      .not('name', 'like', '__doc_mutation_%')
      .not('name', 'like', '__concepts_regen_%')
      .not('name', 'like', '__chat_prompt_%')
      .not('name', 'like', '__quiz_itembank_config%')
      .not('name', 'in', `(${quizNamesExclude.map(n => `"${n}"`).join(',')})`)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (promptsHasSection) q = q.eq('section', 'chat');
    const { data, error } = await q.maybeSingle();
    if (error) {
      console.warn('[chat-prompt] Fout bij ophalen globale prompt:', error.message);
      return { id: null, content: FALLBACK_SYSTEM_PROMPT };
    }
    return { id: data?.id ?? null, content: data?.content ?? FALLBACK_SYSTEM_PROMPT };
  } catch (err) {
    console.warn('[chat-prompt] Exception bij ophalen globale prompt:', err.message);
    return { id: null, content: FALLBACK_SYSTEM_PROMPT };
  }
}

export async function loadGlobalExplainPrompt() {
  const { data, error } = await supabaseAdmin
    .from('chatbot_prompts')
    .select('id, content')
    .eq('section', 'explain')
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('[explain-prompt] Fout bij ophalen globale prompt:', error.message);
    return { id: null, content: DEFAULT_EXPLAIN_PROMPT };
  }
  return { id: data?.id ?? null, content: data?.content ?? DEFAULT_EXPLAIN_PROMPT };
}

// Task #412: vertaalt een client-`promptMode` naar de vertrouwde system-prompt
// die de server zelf beheert. De client mag geen vrije prompt-tekst meer sturen.
// - 'explain' → cursus-override (bij toegang) anders de globale uitleg-prompt.
// - quiz-modi → de globale beheerde quiz-prompt (default + actieve DB-override).
// Retourneert null bij een onbekende modus zodat de caller 400 kan geven.
export async function resolveChatPromptMode(mode, { user, profile, courseId } = {}) {
  if (typeof mode !== 'string' || !mode) return null;

  if (mode === 'explain') {
    try {
      if (courseId && supabaseAdmin && (await userHasCourseAccess(user, profile, courseId))) {
        const { data: override } = await supabaseAdmin
          .from('chatbot_prompts')
          .select('content')
          .eq('name', explainPromptKey(courseId))
          .maybeSingle();
        if (override?.content && override.content.trim()) return override.content;
      }
    } catch (err) {
      console.warn('[promptMode] explain cursus-override mislukt:', err.message);
    }
    try {
      const global = await loadGlobalExplainPrompt();
      return global?.content || DEFAULT_EXPLAIN_PROMPT;
    } catch {
      return DEFAULT_EXPLAIN_PROMPT;
    }
  }

  if (Object.prototype.hasOwnProperty.call(QUIZ_PROMPT_DEFAULTS, mode)) {
    let content = QUIZ_PROMPT_DEFAULTS[mode];
    if (supabaseAdmin && promptsHasSection) {
      try {
        const { data: row } = await supabaseAdmin
          .from('chatbot_prompts')
          .select('content, is_active')
          .eq('name', mode)
          .maybeSingle();
        if (row && row.is_active !== false && typeof row.content === 'string' && row.content.trim().length > 0) {
          content = row.content;
        }
      } catch (err) {
        console.warn(`[promptMode] quiz-prompt "${mode}" override mislukt:`, err.message);
      }
    }
    return content;
  }

  return null;
}

// Oude default — bewaard voor automatische DB-sync naar de nieuwe stijl in
// initChatbotPromptSection. Records die LETTERLIJK gelijk zijn aan deze
// tekst worden zonder vragen bijgewerkt; aangepaste records worden niet
// aangeraakt en getriggeren een waarschuwing in de console.
const OLD_DEFAULT_EXPLAIN_PROMPT_V1 = `Je bent een kritische en constructieve tutor voor epidemiologie en biostatistiek aan de VU Amsterdam. Je evalueert uitleg van studenten over begrippen en geeft gestructureerde, constructieve feedback.

Geef je feedback in vier onderdelen:
1. Wat de student goed heeft gedaan (noem specifieke sterke punten)
2. Wat ontbreekt of onduidelijk is (wees concreet)
3. Eventuele misconcepties die gecorrigeerd moeten worden
4. Concrete suggesties voor verbetering

Wees constructief en moedigend, maar ook specifiek en nuttig. Pas je toon aan op het niveau van een universitaire student in de gezondheidswetenschappen.`;

// Oude (vakspecifieke) default — bewaard zodat records die LETTERLIJK gelijk
// zijn aan deze tekst automatisch worden bijgewerkt naar de cursus-agnostische
// DEFAULT_EXPLAIN_PROMPT in initChatbotPromptSection (zelfde mechanisme als V1).
const OLD_DEFAULT_EXPLAIN_PROMPT_V2 = `Je bent een kritische en constructieve tutor voor epidemiologie en biostatistiek aan de VU Amsterdam. Je evalueert uitleg van studenten over begrippen en geeft gestructureerde, constructieve feedback rechtstreeks aan de student.

Aanspraakvorm (volg STRIKT):
- Spreek de student direct aan met "je" / "jij" / "jouw" / "je hebt".
- Gebruik NOOIT formuleringen als "de student", "deze student", "de student heeft" of andere derde-persoonsverwijzingen naar de student. Schrijf alsof je de feedback één-op-één tegen de student geeft.

Geef je feedback in vier onderdelen:
1. Wat je goed hebt gedaan (noem specifieke sterke punten in jouw uitleg)
2. Wat ontbreekt of onduidelijk is in jouw uitleg (wees concreet)
3. Eventuele misconcepties bij jou die gecorrigeerd moeten worden
4. Concrete suggesties voor verbetering

Notatie van formules (volg STRIKT):
- Schrijf elke wiskundige formule of elk symbool in LaTeX: $...$ voor een formule midden in een zin, $$...$$ voor een formule op een eigen regel.
- Plaats dollartekens ALTIJD in paren: voor elk openend $ of $$ exact één afsluitend $ of $$. Laat nooit een los dollarteken staan.
- Meng inline en display niet binnen één formule: kies $...$ óf $$...$$, niet allebei voor dezelfde formule.
- Gebruik LaTeX-commando's zoals \\cap, \\cdot, \\mid, \\Rightarrow, \\frac UITSLUITEND binnen $...$ of $$...$$, nooit in gewone tekst.

Wees constructief en moedigend, maar ook specifiek en nuttig. Pas je toon aan op het niveau van een universitaire student in de gezondheidswetenschappen.`;

export const DEFAULT_EXPLAIN_PROMPT = `Je bent een kritische en constructieve tutor aan de VU Amsterdam. Je evalueert uitleg van studenten over begrippen en geeft gestructureerde, constructieve feedback rechtstreeks aan de student.

Aanspraakvorm (volg STRIKT):
- Spreek de student direct aan met "je" / "jij" / "jouw" / "je hebt".
- Gebruik NOOIT formuleringen als "de student", "deze student", "de student heeft" of andere derde-persoonsverwijzingen naar de student. Schrijf alsof je de feedback één-op-één tegen de student geeft.

Geef je feedback in vier onderdelen:
1. Wat je goed hebt gedaan (noem specifieke sterke punten in jouw uitleg)
2. Wat ontbreekt of onduidelijk is in jouw uitleg (wees concreet)
3. Eventuele misconcepties bij jou die gecorrigeerd moeten worden
4. Concrete suggesties voor verbetering

Notatie van formules (volg STRIKT):
- Schrijf elke wiskundige formule of elk symbool in LaTeX: $...$ voor een formule midden in een zin, $$...$$ voor een formule op een eigen regel.
- Plaats dollartekens ALTIJD in paren: voor elk openend $ of $$ exact één afsluitend $ of $$. Laat nooit een los dollarteken staan.
- Meng inline en display niet binnen één formule: kies $...$ óf $$...$$, niet allebei voor dezelfde formule.
- Gebruik LaTeX-commando's zoals \\cap, \\cdot, \\mid, \\Rightarrow, \\frac UITSLUITEND binnen $...$ of $$...$$, nooit in gewone tekst.

Wees constructief en moedigend, maar ook specifiek en nuttig. Pas je toon aan op het niveau van een universitaire student.`;

// Task #166: standaard prompt-template voor document-reviews. De docent kan
// dit in de admin-UI overschrijven (Prompts → sectie 'project'). De template
// gebruikt geen placeholder-syntax — de server vouwt de runtime-velden
// (persona-prompt, rubric, document-tekst, etc.) als losse blokken eronder
// in zodat de prompt zelf-redactiebaar blijft zonder vaste sleutels.
export const DEFAULT_DOCUMENT_REVIEW_PROMPT = `Je bent een formatieve beoordelaar voor een groep VU-studenten. Geef een gestructureerd oordeel over het hieronder bijgevoegde studentdocument.

Aanspraakvorm: spreek de groep aan met "jullie". Wees concreet, vermijd derde-persoonsformuleringen ("de groep heeft …").

Antwoord ALTIJD met geldig JSON, zonder extra tekst eromheen, volgens dit schema:
{
  "verdict": "accepted" | "conditional" | "rejected",
  "grade": getal tussen 0 en 10 (één decimaal toegestaan, bijv. 7.5),
  "reasoning": "2-4 zinnen feedback in het Nederlands, in tweede persoon: wat is er goed en wat schiet tekort",
  "feed_forward": "1-3 concrete vervolgstappen in het Nederlands, in tweede persoon: wat moeten jullie hierna doen om beter te scoren"
}

Betekenis verdict:
- "accepted" = je vindt het document inhoudelijk voldoende.
- "conditional" = bruikbaar mits jullie de genoemde punten aanpakken.
- "rejected" = nog niet op niveau; geef duidelijk aan wat eerst anders moet.

Betekenis grade: een cijfer van 0 t/m 10 voor de kwaliteit van het document, gebaseerd op de (verborgen) rubric(s) hierboven. Wees streng maar eerlijk; een 6 is voldoende, een 8+ is uitstekend.

Betekenis reasoning (feedback): waar staan jullie nu — benoem zowel sterke punten als tekortkomingen.
Betekenis feed_forward (feed-forward): wat is de volgende stap — concrete, uitvoerbare verbeteracties.

Geef GEEN markdown, GEEN code fences, alléén het JSON-object.`;

export let promptsHasSection = false;

export async function initChatbotPromptSection() {
  if (!supabaseAdmin) return;
  try {
    const { error: detectError } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('section')
      .limit(1);

    if (detectError && detectError.message?.includes('section')) {
      console.warn(
        '[init] chatbot_prompts.section kolom ontbreekt.\n' +
        '       Voer dit SQL uit in het Supabase dashboard om de kolom toe te voegen:\n\n' +
        "       ALTER TABLE chatbot_prompts ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT 'chat';\n" +
        "       UPDATE chatbot_prompts SET section = 'chat' WHERE name NOT LIKE '__rag_settings%';\n" +
        '       Herstart daarna de server om de uitleg-prompt automatisch aan te maken.\n'
      );
      promptsHasSection = false;
      return;
    }

    promptsHasSection = true;

    // Sectie-opschoning via directe SQL (pgPool). PostgREST-filters voor
    // LIKE-patronen op `__...%` en `.not('section','in', ...)` werken in
    // supabase-js onbetrouwbaar door underscore-wildcard escaping en
    // string-literaalafhandeling. Met directe SQL is dit eenduidig en
    // idempotent.
    if (pgPool) {
      try {
        const quizNames = Object.keys(QUIZ_PROMPT_DEFAULTS);
        // 1) Interne config-rijen → section='internal'.
        await pgPool.query(
          `UPDATE chatbot_prompts SET section = 'internal'
           WHERE (name = '__quiz_itembank_config__'
              OR name LIKE E'\\\\_\\\\_doc\\\\_mutation\\\\_%' ESCAPE E'\\\\'
              OR name LIKE E'\\\\_\\\\_concepts\\\\_regen\\\\_%' ESCAPE E'\\\\'
              OR name LIKE E'\\\\_\\\\_rag\\\\_settings%' ESCAPE E'\\\\')
             AND (section IS DISTINCT FROM 'internal')`
        );
        // 2) Quiz-prompts → section='quiz' (onvoorwaardelijk overschrijven).
        await pgPool.query(
          `UPDATE chatbot_prompts SET section = 'quiz'
           WHERE name = ANY($1::text[])
             AND (section IS DISTINCT FROM 'quiz')`,
          [quizNames]
        );
        // 3) Rijen met section IS NULL: standaard 'chat'.
        await pgPool.query(
          `UPDATE chatbot_prompts SET section = 'chat' WHERE section IS NULL`
        );
      } catch (sqlErr) {
        console.warn('[init] Sectie-opschoning via SQL mislukt:', sqlErr.message);
      }
    } else {
      // Fallback zonder pgPool: gebruik losse supabase-js calls. Vermijd
      // .or() met underscore-LIKE en .not('section','in',...) want die zijn
      // onbetrouwbaar in PostgREST.
      console.warn('[init] pgPool niet beschikbaar — sectie-opschoning via supabase-js fallback.');
      try {
        const quizNames = Object.keys(QUIZ_PROMPT_DEFAULTS);
        // 1) Interne config-rijen (vier patronen, los uitgevoerd).
        await supabaseAdmin
          .from('chatbot_prompts')
          .update({ section: 'internal' })
          .eq('name', '__quiz_itembank_config__')
          .neq('section', 'internal');
        for (const prefix of ['__doc_mutation_', '__concepts_regen_', '__rag_settings']) {
          await supabaseAdmin
            .from('chatbot_prompts')
            .update({ section: 'internal' })
            .like('name', `${prefix}%`)
            .neq('section', 'internal');
        }
        // 2) Quiz-prompts → 'quiz'.
        await supabaseAdmin
          .from('chatbot_prompts')
          .update({ section: 'quiz' })
          .in('name', quizNames)
          .neq('section', 'quiz');
        // 3) NULL → 'chat'.
        await supabaseAdmin
          .from('chatbot_prompts')
          .update({ section: 'chat' })
          .is('section', null);
      } catch (fallbackErr) {
        console.warn('[init] Sectie-opschoning fallback mislukt:', fallbackErr.message);
      }
    }

    // Zorg dat er minstens één echte chat-prompt bestaat zodat /api/chat
    // niet meer naar de hard-coded FALLBACK_SYSTEM_PROMPT valt. Gebruik
    // pgPool zodat we niet weer tegen PostgREST-filterquirks aanlopen.
    let existingChatRow = null;
    if (pgPool) {
      try {
        const quizNames = Object.keys(QUIZ_PROMPT_DEFAULTS);
        const r = await pgPool.query(
          `SELECT id FROM chatbot_prompts
           WHERE section = 'chat'
             AND is_active = true
             AND name NOT LIKE '\\_\\_%' ESCAPE '\\'
             AND NOT (name = ANY($1::text[]))
           LIMIT 1`,
          [quizNames]
        );
        existingChatRow = r.rows[0] || null;
      } catch (pgErr) {
        console.warn('[init] Chat-prompt bestaanscheck via pgPool mislukt:', pgErr.message);
      }
    }
    if (!existingChatRow) {
      const { error: chatInsertErr } = await supabaseAdmin
        .from('chatbot_prompts')
        .insert({
          name: 'Sjabloon chat-instructie',
          content: FALLBACK_SYSTEM_PROMPT,
          is_active: true,
          section: 'chat',
        });
      if (chatInsertErr) {
        console.warn('[init] Standaard chat-prompt aanmaken mislukt:', chatInsertErr.message);
      } else {
        console.log('[init] Sjabloon chat-instructie aangemaakt');
      }
    }

    const { data: existingExplain } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('id')
      .eq('section', 'explain')
      .maybeSingle();

    if (!existingExplain) {
      const { error: insertError } = await supabaseAdmin
        .from('chatbot_prompts')
        .insert({
          name: 'Sjabloon Ik leg uit',
          content: DEFAULT_EXPLAIN_PROMPT,
          is_active: true,
          section: 'explain',
        });
      if (insertError) {
        console.warn('[init] Explain prompt aanmaken mislukt:', insertError.message);
      } else {
        console.log('[init] Standaard uitleg-prompt aangemaakt');
      }
    }

    // Eenmalige sync naar de tweede-persoon stijl: records die nog letterlijk
    // de oude default bevatten worden stil bijgewerkt; aangepaste records
    // worden NIET overschreven maar krijgen een waarschuwing.
    try {
      const { data: explainRecords, error: listErr } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('id, name, content')
        .eq('section', 'explain');
      if (listErr) {
        console.warn('[init] Uitleg-prompt sync overgeslagen:', listErr.message);
      } else if (Array.isArray(explainRecords)) {
        for (const rec of explainRecords) {
          if (rec.content === OLD_DEFAULT_EXPLAIN_PROMPT_V1 || rec.content === OLD_DEFAULT_EXPLAIN_PROMPT_V2) {
            const { error: updErr } = await supabaseAdmin
              .from('chatbot_prompts')
              .update({ content: DEFAULT_EXPLAIN_PROMPT })
              .eq('id', rec.id);
            if (updErr) {
              console.warn(`[init] Sync uitleg-prompt "${rec.name}" mislukt:`, updErr.message);
            } else {
              console.log(`[init] Uitleg-prompt "${rec.name}" automatisch bijgewerkt naar tweede-persoon stijl`);
            }
          } else if (/\b(de|deze) student\b/i.test(rec.content)) {
            console.warn(
              `[init] LET OP: aangepaste uitleg-prompt "${rec.name}" (id ${rec.id}) bevat nog "de student" / "deze student".\n` +
              '       Open de admin-UI (Prompts → sectie "explain") en pas de tekst aan zodat de student direct met "je"/"jij" wordt aangesproken.'
            );
          }
        }
      }
    } catch (syncErr) {
      console.warn('[init] Uitleg-prompt sync exception:', syncErr.message);
    }

    // Idem voor de chat system prompt(s). De huidige FALLBACK_SYSTEM_PROMPT
    // bevat geen derde-persoonsverwijzingen naar "de student", dus er valt
    // niets te auto-syncen. Wat wél nuttig is: een rapportage zodat de
    // superuser weet of zijn admin-aangepaste chat-prompts nog
    // "de student" / "deze student" bevatten — anders blijft de chat-tutor
    // dat overnemen in zijn antwoorden.
    try {
      const { data: chatRecords, error: chatListErr } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('id, name, content')
        .eq('section', 'chat');
      if (chatListErr) {
        console.warn('[init] Chat-prompt rapportage overgeslagen:', chatListErr.message);
      } else if (Array.isArray(chatRecords)) {
        let chatThirdPerson = 0;
        for (const rec of chatRecords) {
          if (/\b(de|deze) student\b/i.test(rec.content)) {
            chatThirdPerson++;
            console.warn(
              `[init] LET OP: chat-prompt "${rec.name}" (id ${rec.id}) bevat nog "de student" / "deze student".\n` +
              '       Open de admin-UI (Prompts → sectie "chat") en pas de tekst aan zodat de chat-tutor de student direct met "je"/"jij" aanspreekt.'
            );
          }
        }
        console.log(
          `[init] Chat-prompts gecontroleerd: ${chatRecords.length} record(s), ` +
          `${chatThirdPerson} met derde-persoonsverwijzingen naar de student.`
        );
      }
    } catch (chatSyncErr) {
      console.warn('[init] Chat-prompt rapportage exception:', chatSyncErr.message);
    }

    // Task #166: zorg dat er een 'document_review'-prompt in sectie 'project'
    // bestaat. Idempotent op (section='project', name='document_review').
    try {
      const { data: existingDR } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('id')
        .eq('section', 'project')
        .eq('name', 'document_review')
        .maybeSingle();
      if (!existingDR) {
        const { error: drErr } = await supabaseAdmin
          .from('chatbot_prompts')
          .insert({
            name: 'document_review',
            content: DEFAULT_DOCUMENT_REVIEW_PROMPT,
            is_active: false,
            section: 'project',
          });
        if (drErr) {
          console.warn('[init] document_review-prompt aanmaken mislukt:', drErr.message);
        } else {
          console.log('[init] Standaard document_review-prompt aangemaakt (sectie "project")');
        }
      }
    } catch (drSeedErr) {
      console.warn('[init] document_review-prompt seed exception:', drSeedErr.message);
    }

    console.log('[init] chatbot_prompts sectie-migratie voltooid (section kolom beschikbaar)');
  } catch (err) {
    console.warn('[init] initChatbotPromptSection exception:', err.message);
  }
}

// ---- Quiz-prompt templates --------------------------------------------------
// Vier prompts die expliciet beheerd worden in chatbot_prompts onder section
// 'quiz'. De keys (name) zijn stabiel; de inhoud kan vrij worden aangepast.
export const QUIZ_PROMPT_DEFAULTS = {
  quiz_generate_strict: `Je bent een tentamenmaker aan de VU Amsterdam. Je formuleert vragen UITSLUITEND op basis van het meegeleverde cursusmateriaal. Verzin geen feiten die niet in de context staan. Spreek de student aan met "je"/"jij"/"jouw".`,
  quiz_generate_blended: `Je bent een tentamenmaker aan de VU Amsterdam. Je gebruikt het meegeleverde cursusmateriaal als hoofdbron, maar mag dit aanvullen met algemeen geaccepteerde kennis uit het vakgebied. Maak helder onderscheid tussen wat in de context staat en wat algemene vakkennis is. Spreek de student aan met "je"/"jij"/"jouw".`,
  quiz_generate_creative: `Je bent een creatieve tentamenmaker aan de VU Amsterdam. Je formuleert toepassingsvragen, casusvragen en transferopdrachten die studenten uitdagen om de leerstof in nieuwe contexten toe te passen. Gebruik realistische, relevante scenario's. Spreek de student aan met "je"/"jij"/"jouw".`,
  quiz_verify: `Je bent een zeer kritische toetsdeskundige én expert in het vakgebied van de cursus, zoals dat vakgebied in het meegeleverde cursusmateriaal is vastgelegd. Je controleert quizvragen voordat studenten ze te zien krijgen: je lost ze eerst zelf onafhankelijk op en vergelijkt je uitkomst daarna met het officiële antwoord en de feedback. Je laat geen vage, dubbelzinnige, onjuiste of niet-toetsbare vraag door. Je antwoordt uitsluitend in het gevraagde JSON-formaat.`,
  quiz_evaluate_open: `Je bent een kritische maar constructieve beoordelaar van open antwoorden. Je geeft feedback in vier punten: (1) wat goed is, (2) wat ontbreekt, (3) misconcepties, (4) concrete verbeterpunten. Spreek de student direct aan met "je"/"jij"/"jouw" — gebruik NOOIT "de student" of "deze student".`,
};

export async function initQuizPromptDefaults() {
  if (!supabaseAdmin || !promptsHasSection) return;
  for (const [name, content] of Object.entries(QUIZ_PROMPT_DEFAULTS)) {
    try {
      const { data: existing } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('id')
        .eq('name', name)
        .maybeSingle();
      if (!existing) {
        const { error } = await supabaseAdmin.from('chatbot_prompts').insert({
          name,
          content,
          is_active: true,
          section: 'quiz',
        });
        if (error) {
          console.warn(`[init] Quiz-prompt "${name}" aanmaken mislukt:`, error.message);
        } else {
          console.log(`[init] Quiz-prompt "${name}" aangemaakt`);
        }
      }
    } catch (err) {
      console.warn(`[init] Quiz-prompt "${name}" init exception:`, err.message);
    }
  }
}
