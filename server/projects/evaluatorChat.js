// Chatten met een beoordelaar (2026-11-11). In de chat is een beoordelaar
// alleen een wegwijzer bij het inleveren, in zijn eigen rol: wat lever je in,
// waar en hoe, hoeveel feedbackrondes zijn er nog, wat gebeurt er daarna.
// Hij geeft hier geen inhoudelijke feedback en geen oordeel; dat gebeurt alleen
// in de feedbackrondes (evaluatorReview.js), die meetellen voor het maximum.
// De feiten komen van de server (de echte stand van deze groep); alles wat daar
// niet in staat, weet hij niet en dan verwijst hij naar de docent.
//
// De nakijkhulp van het eindproduct is geen gesprekspartner (personaRoutes.js).
//
// Bewust NIET in deze chat: de beoordelingsinstructies van de persona
// (system_prompt), zijn kennisdocumenten (rubric-inhoud) en cursusmateriaal.

import { countFeedbackRounds } from './evaluatorReview.js';
import { feedbackRoundsState } from './documentReview.js';

// Moet gelijk blijven aan wat de inleverroute toestaat (documentRoutes.js).
export const SUBMISSION_FILE_TYPES = 'pdf, docx, pptx, xlsx, odt, ods, odp, zip, txt, md, csv, tsv, json, rtf, jpg, png, html';
export const SUBMISSION_MAX_MB = 15;

/** De stand van deze groep bij deze beoordelaar. Ontbrekende gegevens = onbekend, niet verzonnen. */
export async function loadEvaluatorChatFacts(db, { projectId, groupId, persona }) {
  const [{ data: project, error: projectError }, used, { count: submitted }, { data: rubrics }] = await Promise.all([
    db.from('projects').select('submissions_enabled, status, preassessment_persona_id').eq('id', projectId).maybeSingle(),
    countFeedbackRounds(groupId, persona.id).catch(() => null),
    db.from('project_submissions').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('group_id', groupId),
    (persona.project_knowledge_doc_ids || []).length
      ? db.from('project_documents').select('filename').eq('project_id', projectId)
        .in('id', persona.project_knowledge_doc_ids).eq('material_kind', 'rubric').eq('is_visible_to_students', true)
      : Promise.resolve({ data: [] }),
  ]);
  // Zonder project weten we niet of dit de nakijkhulp is: dan niet doorgaan.
  if (projectError || !project) throw new Error('Project kon niet worden geladen');
  const rounds = used == null ? null : feedbackRoundsState(persona.max_reviews, used);
  return {
    deliverableLabel: persona.deliverable_label || null,
    rounds,
    submissionsEnabled: project?.submissions_enabled === true,
    finalSubmitted: (submitted || 0) > 0,
    draft: project?.status === 'draft',
    preassessment: !!project?.preassessment_persona_id,
    isPreassessor: !!project?.preassessment_persona_id && project.preassessment_persona_id === persona.id,
    visibleRubrics: (rubrics || []).map((r) => r.filename).filter(Boolean),
  };
}

/** Systeemtekst voor de beoordelaar als wegwijzer bij het inleveren. Puur. */
export function buildEvaluatorChatPrompt(persona, facts) {
  const name = String(persona?.name || 'de beoordelaar');
  const lines = [];
  if (facts.deliverableLabel) lines.push(`- Het product waarover jij feedback geeft: ${facts.deliverableLabel}.`);
  if (facts.rounds) {
    lines.push(facts.rounds.maxReviews == null
      ? `- Feedbackrondes bij jou: onbeperkt; deze groep heeft er ${facts.rounds.used} gebruikt.`
      : `- Feedbackrondes bij jou: ${facts.rounds.used} van ${facts.rounds.maxReviews} gebruikt, nog ${facts.rounds.remaining} over.`);
  } else {
    lines.push('- Hoeveel feedbackrondes deze groep nog heeft, weet je nu niet; dat staat in de projectruimte.');
  }
  lines.push('- Feedback vragen op tussentijds werk: rechts in de projectruimte, op het tabblad "Briefing", in het blok "Feedback op jullie werk". Kies daar jouw naam en gebruik "Lever in voor feedback" (één bestand). Elke keer telt als een feedbackronde. Je feedback is formatief: wat al werkt, waar het meeste te winnen is en een volgende stap; geen cijfer.');
  lines.push('- De knop "Feedback op jullie aanpak" bovenaan geeft formatieve feedback op de gesprekken van de groep; die telt ook als feedbackronde.');
  if (facts.submissionsEnabled) {
    lines.push(facts.finalSubmitted
      ? '- Het eindproduct van deze groep is al ingeleverd. Moet er toch iets veranderen, dan vraagt de groep de docent de inlevering te verwijderen.'
      : `- Het eindproduct lever je in met de knop "Inleveren projectproduct" bovenaan in de projectruimte: één bestand namens de hele groep, na een bevestiging, en daarna niet meer te wijzigen${facts.draft ? ' (behalve nu de docent het project uitprobeert)' : ''}. Toegestaan: ${SUBMISSION_FILE_TYPES}; hoogstens ${SUBMISSION_MAX_MB} MB.`);
    if (facts.preassessment) lines.push('- Bij een ingeleverd eindproduct laat de docent eerst door AI nakijkcommentaar schrijven aan de hand van de rubric. Dat commentaar ziet alleen de docent; de docent beoordeelt.');
  } else {
    lines.push('- In dit project is er geen knop om een eindproduct in te leveren. Hoe het eindproduct bij de docent komt, weet je niet: verwijs daarvoor naar de docent.');
  }
  lines.push(facts.visibleRubrics.length
    ? `- De groep kan deze rubric openen in de projectruimte (tabblad "Briefing"): ${facts.visibleRubrics.join(', ')}.`
    : '- Er is geen rubric die de groep kan openen.');
  lines.push('- In dit gesprek kan de groep geen bestanden delen; inleveren gaat alleen via de knoppen hierboven.');

  return `Je bent ${name}. In dit gesprek ben je alleen het aanspreekpunt voor het inleveren van werk in dit project. Praat in je eigen rol en toon, kort en vriendelijk, en spreek de studenten aan met "je"/"jullie".

Wat je in dit gesprek doet:
- Uitleggen wat de groep inlevert, waar en hoe, hoeveel feedbackrondes er nog zijn, en wat er na het inleveren gebeurt. Gebruik daarvoor uitsluitend de feiten hieronder.
- Is iets niet duidelijk, stel dan één korte vraag terug.

Wat je in dit gesprek NIET doet:
- Geen inhoudelijke feedback, geen oordeel, geen cijfer of inschatting van kwaliteit, en geen tips hoe het werk beter scoort. Ook niet als de groep tekst of een samenvatting in de chat plakt. Zeg dan dat je inhoudelijke feedback alleen geeft in een feedbackronde, en hoe die werkt.
- Geen inhoud van een rubric of van andere documenten noemen of samenvatten; je mag alleen zeggen welke rubric de groep zelf kan openen.
- Niets verzinnen over deadlines, cijfers, beoordelingsregels of procedures die hieronder niet staan. Weet je iets niet, zeg dat dan eerlijk en verwijs naar de docent.

Feiten over deze groep en dit project:
${lines.join('\n')}`;
}
