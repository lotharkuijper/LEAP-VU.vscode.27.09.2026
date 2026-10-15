// Pure helpers voor Task #296 (adaptief leerniveau per student). Geen DB-calls
// zodat vitest ze direct kan testen. De student stelt zelf een niveau in (1..5,
// beginner→expert) PER cursus; dat niveau wordt via ÉÉN parametrisch blok in de
// systeemprompt geïnjecteerd (geen aparte prompt per niveau). De bot past zijn
// uitleg erop aan en geeft ALLEEN op aanvraag een eerlijk "klaar voor een hoger
// niveau?"-meta-oordeel. De student blijft de baas: de bot adviseert, de student
// bepaalt het niveau.

export const LEVEL_MIN = 1;
export const LEVEL_MAX = 5;
// Standaardniveau wanneer een student nog niets heeft ingesteld. Bewust laag-
// gemiddeld (een lichte beginner): liever te veel uitleg dan te weinig. Dit is
// een bewuste, instelbare keuze — pas LEVEL_DEFAULT aan om hem te verschuiven.
export const LEVEL_DEFAULT = 2;

// Korte, voor de student zichtbare labels per niveau (de UI gebruikt eigen
// i18n-keys; deze labels worden in de systeemprompt gebruikt zodat het model
// weet welk niveau de student koos).
export const LEVEL_LABELS = {
  nl: {
    1: 'Absolute beginner',
    2: 'Beginner',
    3: 'Gemiddeld',
    4: 'Gevorderd',
    5: 'Expert',
  },
  en: {
    1: 'Absolute beginner',
    2: 'Beginner',
    3: 'Intermediate',
    4: 'Advanced',
    5: 'Expert',
  },
};

// Niveautabel (2026-10-15). Taakverdeling: de chat-instructie van de docent
// bepaalt het soort reactie (rol, aanpak, opbouw, toon, maximale lengte); het
// niveau bepaalt binnen dat kader hoe technisch en complex. Meting met het echte model liet zien dat één zin
// per niveau weinig deed: de (lange) chat-instructie van de cursus overstemde
// het niveau, niveau 1 hield vakjargon en niveau 5 begon even elementair. Nu
// beschrijft één tabel per niveau zes concrete dimensies, zodat de vijf niveaus
// een glijdende schaal vormen. Het blok blijft één sjabloon; dit is DATA.
const LEVEL_PROFILES = {
  nl: {
    1: {
      taal: 'begrijpelijke taal op B1-niveau, alsof je het uitlegt aan iemand die het vak nog nooit heeft gehad',
      vaktermen: 'hoogstens één vakterm per antwoord, en die leg je direct uit in gewone woorden; woorden als "determinant", "uitkomst", "variabele" of "associatie" zijn óók vaktermen',
      zinnen: 'korte zinnen (rond de 10 woorden), één gedachte per zin',
      abstractie: 'begin met een alledaags, concreet voorbeeld en kom pas daarna bij het idee; geen formules of symbolen',
      voorkennis: 'ga uit van geen enkele voorkennis van het vak',
      stap: 'heel kleine stap: één eenvoudige vraag die aansluit bij het dagelijks leven',
      lengte: 'aan de korte kant van wat de docent toestaat; zonder grens van de docent 2 tot 4 korte zinnen',
    },
    2: {
      taal: 'eenvoudige taal op B2-niveau',
      vaktermen: 'een paar vaktermen, elk met een korte uitleg erbij',
      zinnen: 'vrij korte zinnen',
      abstractie: 'eerst een concreet voorbeeld, dan het begrip; een eenvoudige formule alleen als het moet, met uitleg in woorden',
      voorkennis: 'ga uit van weinig voorkennis',
      stap: 'kleine stap: één gerichte vraag',
      lengte: 'kort binnen het kader van de docent; zonder grens 3 of 4 zinnen',
    },
    3: {
      taal: 'gewone vaktaal op C1-niveau',
      vaktermen: 'gangbare vaktermen van de cursus mag je gebruiken; licht alleen een minder bekende term kort toe',
      zinnen: 'gemiddelde zinslengte',
      abstractie: 'het begrip met een voorbeeld uit het vak; formules mag je gebruiken',
      voorkennis: 'ga uit van basiskennis van de kernbegrippen van de cursus',
      stap: 'middelgrote stap: een vraag die vraagt om toepassen',
      lengte: 'gemiddeld binnen het kader van de docent; zonder grens 3 tot 5 zinnen',
    },
    4: {
      taal: 'academische vaktaal op C1/C2-niveau',
      vaktermen: 'vaktermen vrij, zonder uitleg',
      zinnen: 'langere, samengestelde zinnen zijn prima',
      abstractie: 'onderliggende mechanismen, nuances en verbanden met andere begrippen',
      voorkennis: 'ga uit van een stevige basis; de kernbegrippen van de cursus zijn bekend',
      stap: 'grotere stap: een vraag over interpretatie, vergelijking of een lastige situatie',
      lengte: 'wat uitgebreider binnen het kader van de docent; zonder grens 4 tot 6 zinnen',
    },
    5: {
      taal: 'precieze academische taal op C2-niveau, zoals tussen vakgenoten',
      vaktermen: 'vaktermen vrij, zonder uitleg; elementaire uitleg sla je over',
      zinnen: 'complexe, informatiedichte zinnen zoals in een vakartikel; precies, niet breedsprakig',
      abstractie: 'hoog abstractieniveau: principes, aannames, randgevallen, beperkingen en verbanden met gevorderde stof',
      voorkennis: 'ga ervan uit dat de student verwante onderwerpen en de grotere samenhang van het vak al kent',
      stap: 'grote sprong: een uitdagende vraag over randgevallen, kritiek of toepassing in een nieuwe situatie; begin niet bij de basis',
      lengte: 'aan de lange kant van wat de docent toestaat als het redeneren dat vraagt; zonder grens tot ongeveer 8 zinnen',
    },
  },
  en: {
    1: {
      taal: 'plain language at CEFR B1, as if explaining to someone who has never taken the subject',
      vaktermen: 'at most one technical term per answer, explained right away in everyday words; words like "determinant", "outcome", "variable" or "association" count as technical terms too',
      zinnen: 'short sentences (around 10 words), one idea per sentence',
      abstractie: 'start with an everyday, concrete example and only then the idea; no formulas or symbols',
      voorkennis: 'assume no prior knowledge of the subject at all',
      stap: 'a very small step: one simple question linked to everyday life',
      lengte: 'at the short end of what the teacher allows; without a teacher limit 2 to 4 short sentences',
    },
    2: {
      taal: 'simple language at CEFR B2',
      vaktermen: 'a few technical terms, each with a short explanation',
      zinnen: 'fairly short sentences',
      abstractie: 'a concrete example first, then the concept; a simple formula only if needed, explained in words',
      voorkennis: 'assume little prior knowledge',
      stap: 'a small step: one focused question',
      lengte: 'short within the teacher\'s frame; without a limit 3 or 4 sentences',
    },
    3: {
      taal: 'standard subject language at CEFR C1',
      vaktermen: 'common course terminology is fine; briefly clarify only a less familiar term',
      zinnen: 'average sentence length',
      abstractie: 'the concept with an example from the field; formulas are fine',
      voorkennis: 'assume basic familiarity with the core concepts of the course',
      stap: 'a medium step: a question that asks for application',
      lengte: 'medium within the teacher\'s frame; without a limit 3 to 5 sentences',
    },
    4: {
      taal: 'academic language at CEFR C1/C2',
      vaktermen: 'technical terms freely, without explanation',
      zinnen: 'longer, compound sentences are fine',
      abstractie: 'underlying mechanisms, nuances and links to other concepts',
      voorkennis: 'assume a solid foundation; the core concepts of the course are known',
      stap: 'a larger step: a question about interpretation, comparison or a tricky situation',
      lengte: 'somewhat longer within the teacher\'s frame; without a limit 4 to 6 sentences',
    },
    5: {
      taal: 'precise academic language at CEFR C2, as between peers in the field',
      vaktermen: 'technical terms freely, without explanation; skip elementary explanation',
      zinnen: 'complex, information-dense sentences as in a journal article; precise, not wordy',
      abstractie: 'a high level of abstraction: principles, assumptions, edge cases, limitations and links to advanced material',
      voorkennis: 'assume the student already knows related topics and the wider coherence of the subject',
      stap: 'a big leap: a challenging question about edge cases, critique or application in a new situation; do not start from the basics',
      lengte: 'at the long end of what the teacher allows if the reasoning needs it; without a limit up to about 8 sentences',
    },
  },
};

// Normaliseert een binnenkomende waarde naar een geheel niveau 1..5. Ongeldige
// of ontbrekende waarden → null (de aanroeper injecteert dan géén blok en houdt
// het neutrale, bestaande gedrag).
export function clampLevel(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  if (n < LEVEL_MIN) return LEVEL_MIN;
  if (n > LEVEL_MAX) return LEVEL_MAX;
  return n;
}

function pickLangKey(lang) {
  // nl = bron van waarheid, en = universele terugval voor alle overige talen.
  // Het meta-blok zelf staat in NL of EN; de aparte taal-instructie elders in
  // de prompt dwingt nog steeds de uitvoertaal af.
  return String(lang || '').toLowerCase() === 'nl' ? 'nl' : 'en';
}

// Bouwt het parametrische leerniveau-blok dat aan de systeemprompt wordt
// toegevoegd. Retourneert '' bij een ontbrekend/ongeldig niveau, zodat het
// bestaande gedrag onveranderd blijft wanneer er geen niveau is meegegeven.
export function buildLevelInstructionBlock(level, lang) {
  const lvl = clampLevel(level);
  if (lvl == null) return '';
  const key = pickLangKey(lang);
  const label = LEVEL_LABELS[key][lvl];
  const pr = LEVEL_PROFILES[key][lvl];

  if (key === 'nl') {
    return `\n\nLEERNIVEAU VAN DE STUDENT (volg dit strikt):
De student heeft zélf zijn/haar kennisniveau voor deze cursus ingesteld op: "${label}" (niveau ${lvl} van ${LEVEL_MAX}). De schaal loopt van niveau 1 (begrijpelijke taal, geen voorkennis) tot niveau ${LEVEL_MAX} (taal tussen vakgenoten, verwante onderwerpen bekend).
Schrijf ELK antwoord op dit niveau:
- Taal: ${pr.taal}.
- Vaktermen: ${pr.vaktermen}.
- Zinnen: ${pr.zinnen}.
- Abstractie: ${pr.abstractie}.
- Voorkennis: ${pr.voorkennis}.
- Moeilijkheid van je vraag of volgende stap (als je werkwijze daarom vraagt): ${pr.stap}.
- Lengte: ${pr.lengte}.
Taakverdeling met de instructie van de docent hierboven (die vullen elkaar aan, geen van beide overrulet de ander):
- De docent bepaalt het SOORT reactie: je rol, de didactische aanpak (bijvoorbeeld Socratisch), de opbouw, de toon en grenzen zoals een maximale lengte. Volg die altijd.
- Dit niveau bepaalt HOE technisch en complex je binnen dat kader bent: taal, vaktermen, zinsbouw, abstractie en aangenomen voorkennis, en hoe moeilijk een vraag is.
- Zegt de docent iets over taalniveau of vakjargon (bijvoorbeeld "gebruik academische taal"), dan geldt dat als uitgangspunt voor het middelste niveau; dit niveau schuift het eenvoudiger of technischer.
- Voer de aanpak van de docent uit OP dit niveau. Bijvoorbeeld "begin bij wat de student al weet": op een laag niveau begin je bij alledaagse ervaring, op een hoog niveau neem je de basis als bekend aan en begin je bij een verdiepend aspect.
Cursusmateriaal is je bron, geen voorbeeldtaal: vertaal wat erin staat naar dit niveau en neem definities niet letterlijk over als die moeilijker zijn dan dit niveau.
Is het niveau tijdens het gesprek veranderd, volg dan vanaf nu dit niveau, niet de toon van je eerdere berichten.
Aanvullende regels:
- Verlaag of verhoog het niveau NIET op eigen initiatief; de student bepaalt het niveau zelf via de niveaukiezer.
- Begin niet uit jezelf over het niveau of over "klaar zijn voor een hoger niveau".
- ALLEEN wanneer de student er expliciet naar vraagt (bijvoorbeeld of hij/zij klaar is voor een hoger niveau, of hoe het met de voortgang staat), geef dan een eerlijke, onderbouwde meta-inschatting op basis van wat je in dit gesprek hebt gezien: benoem concreet wat al sterk is en wat nog nodig is voor een hoger niveau. Blijf adviserend en respecteer dat de student zelf beslist of en wanneer het niveau omhoog gaat.`;
  }

  return `\n\nSTUDENT'S LEARNING LEVEL (follow this strictly):
The student has set their own knowledge level for this course to: "${label}" (level ${lvl} of ${LEVEL_MAX}). The scale runs from level 1 (plain language, no prior knowledge) to level ${LEVEL_MAX} (language between peers, related topics known).
Write EVERY answer at this level:
- Language: ${pr.taal}.
- Technical terms: ${pr.vaktermen}.
- Sentences: ${pr.zinnen}.
- Abstraction: ${pr.abstractie}.
- Prior knowledge: ${pr.voorkennis}.
- Difficulty of your question or next step (if your way of working calls for one): ${pr.stap}.
- Length: ${pr.lengte}.
Division of roles with the teacher's instruction above (they complement each other; neither overrules the other):
- The teacher decides the KIND of response: your role, the teaching approach (for example Socratic), the structure, the tone and limits such as a maximum length. Always follow those.
- This level decides HOW technical and complex you are within that frame: language, terminology, sentence structure, abstraction and assumed prior knowledge, and how hard a question is.
- If the teacher says something about language level or jargon (for example "use academic language"), treat it as the starting point for the middle level; this level shifts it simpler or more technical.
- Carry out the teacher's approach AT this level. For example "start from what the student already knows": at a low level you start from everyday experience, at a high level you take the basics as known and start from a deeper aspect.
Course material is your source, not your model for wording: translate it to this level and do not copy definitions literally when they are harder than this level.
If the level changed during the conversation, follow this level from now on, not the tone of your earlier messages.
Additional rules:
- Do NOT lower or raise the level on your own initiative; the student sets the level themselves via the level selector.
- Do not bring up the level or "being ready for a higher level" unprompted.
- ONLY when the student explicitly asks (for example whether they are ready for a higher level, or how their progress is going) give an honest, well-founded meta-assessment based on what you have seen in this conversation: name concretely what is already strong and what is still needed for a higher level. Stay advisory and respect that the student decides if and when the level goes up.`;
}
