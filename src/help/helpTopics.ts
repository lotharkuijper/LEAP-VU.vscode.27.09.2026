// Centrale lijst van hulpteksten in het beheer (vraagteken-uitleg).
//
// Afspraak (zie CLAUDE.md → "Hulpteksten"):
//  * Een hulptekst hoort bij een FUNCTIE, niet bij een plek op de pagina. De
//    id beschrijft wat de knop/instelling doet (`material.addWebsite`), niet
//    waar hij staat. Verhuist een knop naar een ander tabblad, dan gaat zijn
//    HelpTip-component gewoon mee en blijft de uitleg kloppen.
//  * De tekst zelf staat in de vertaalbestanden onder `help.<id>.title` en
//    `help.<id>.body` (bron: src/i18n/locales/nl.json), dus in alle talen.
//  * Verandert wat een functie doet bij een herinrichting, pas dan de tekst aan.
//    Verdwijnt een functie, haal de id hier weg: de test in
//    src/help/__tests__/helpTopics.test.ts faalt zolang er een id is die
//    nergens meer wordt gebruikt, of een <HelpTip> naar een onbekende id wijst.
//
// Schrijfwijzer: gewone taal, geen vaktermen (geen "RAG", "chunks",
// "embeddings"), hooguit ~40 woorden, altijd: wat doet het + wat merken
// studenten ervan.

export const HELP_TOPICS = [
  // Cursusmateriaal
  'material.overview',
  'material.step.files',
  'material.step.processing',
  'material.step.concepts',
  'material.step.ready',
  'material.purposes',
  'material.addWebsite',
  'material.web.resync',
  'material.findNewConcepts',
  'material.review',
  // Projecten en persona's
  'projects.overview',
  'projects.templates',
  'personas.inProject',
  'personas.fromTemplate',
  'personas.saveAsTemplate',
  'personas.evaluator',
  // Quizbronnen, zoekgevoeligheid, leerniveaus, chat-instructies
  'quizSources.overview',
  'quizSources.mix',
  'quizSources.itembank',
  'searchSensitivity.overview',
  'searchSensitivity.tryTerm',
  'learningLevels.overview',
  'chatInstructions.overview',
  // Verdieping (fase 2/3)
  'quizSources.coverage',
  'quizSources.csvImport',
  'quizSources.ragFolders',
  'searchSensitivity.courseOverride',
  'searchSensitivity.extraction',
  'chatInstructions.perCourse',
  'projects.submissions',
  'projects.docs',
  'personas.consultationLimits',
  'personas.hiddenRubric',
  'courses.cueRange',
] as const;

export type HelpId = (typeof HELP_TOPICS)[number];

export const helpTitleKey = (id: HelpId) => `help.${id}.title`;
export const helpBodyKey = (id: HelpId) => `help.${id}.body`;
