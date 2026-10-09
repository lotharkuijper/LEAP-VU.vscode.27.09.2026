// Projectregels in het leerdagboek in dezelfde drie blokken als chat, Ik leg
// uit en quiz (zie server/journalSections.js): samenvatting, feedback (wat ging
// goed / wat kan beter) en vervolgstappen (2026-10-09).
//
// Bij een tussenstand of eindreflectie (POST /api/projects/groups/:id/checkpoint)
// ontstaan vier soorten regels. Waar de structuur al bekend is (rubriek-JSON,
// synthese, door de student bewerkte samenvattingen) zetten we die zonder extra
// taalmodel-aanroep om; vrije tekst laten we het model direct in blokken schrijven.

import { normalizeSections, sectionsToText } from './journalSections.js';

const ATTENTION_RE = /aandacht|attention|onvoldoende|insufficient|zwak|weak/i;

/** Losse vervolgstappen uit een tekst (regels of opsommingstekens). */
export function splitSteps(text) {
  return String(text || '')
    .split(/\n+/)
    .map(l => l.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

function fields(sections, lang, extraText = '') {
  const s = normalizeSections(sections);
  if (!s) return { content: extraText.trim(), sections: null };
  const text = sectionsToText(s, lang);
  return { content: extraText ? `${text}\n\n${extraText}` : text, sections: s };
}

/** Eindreflectie met rubriek-oordeel van het model (samenvatting, per_criterium, vervolgstappen). */
export function journalFromRubricFeedback(rf, { lang = 'nl', groupReflection = '' } = {}) {
  const per = Array.isArray(rf?.per_criterium) ? rf.per_criterium : [];
  const item = (c) => [c.criterium, c.feedback].filter(Boolean).join(': ');
  const reflectionNote = groupReflection
    ? `---\n*${lang === 'nl' ? 'Gezamenlijke reflectie van de groep' : 'Joint reflection of the group'}:*\n${groupReflection}`
    : '';
  return fields({
    summary: rf?.samenvatting || '',
    went_well: per.filter(c => !ATTENTION_RE.test(String(c.oordeel || ''))).map(item),
    to_improve: per.filter(c => ATTENTION_RE.test(String(c.oordeel || ''))).map(item),
    next_steps: splitSteps(rf?.vervolgstappen),
  }, lang, reflectionNote);
}

/** Overzicht over alle gesprekken: overeenstemming, spanningspunten, suggesties. */
export function journalFromSynthesis(synth, { lang = 'nl' } = {}) {
  const agree = Array.isArray(synth?.overeenstemming) ? synth.overeenstemming : [];
  return fields({
    summary: agree.join(' '),
    went_well: [],
    to_improve: Array.isArray(synth?.spanningspunten) ? synth.spanningspunten : [],
    next_steps: Array.isArray(synth?.suggesties) ? synth.suggesties : [],
  }, lang);
}

/** Door de student bewerkte samenvatting van één gesprek met een persona. */
export function journalFromPersonaSummary({ studentSummary, personaSummary, personaName }, { lang = 'nl' } = {}) {
  const label = lang === 'nl' ? `Reactie van ${personaName || 'de persona'}` : `Response from ${personaName || 'the persona'}`;
  return fields({
    summary: String(studentSummary || '').trim(),
    went_well: [],
    to_improve: [],
    feedback: personaSummary ? `${label}: ${String(personaSummary).trim()}` : '',
    next_steps: [],
  }, lang);
}
