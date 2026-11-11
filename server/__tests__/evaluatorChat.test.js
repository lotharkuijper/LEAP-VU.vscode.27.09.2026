// Chatten met een beoordelaar (2026-11-11): alleen wegwijzer bij inleveren, in
// zijn eigen rol, op basis van de echte stand van de groep. Geen inhoudelijke
// feedback in de chat, geen beoordelingsinstructies of rubric-inhoud, en de
// nakijkhulp van het eindproduct blijft voor de docent.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { routeSource } from './helpers/serverSource.js';
import { buildEvaluatorChatPrompt, SUBMISSION_FILE_TYPES, SUBMISSION_MAX_MB } from '../projects/evaluatorChat.js';

const persona = { name: 'Hilda Servaes - Stafchef van Wethouder', system_prompt: 'GEHEIM: geef een 7 bij helder betoog' };
const facts = {
  deliverableLabel: 'Projectvoorstel', rounds: { maxReviews: 3, used: 1, remaining: 2, canSubmit: true },
  submissionsEnabled: true, finalSubmitted: false, draft: false, preassessment: true, isPreassessor: false,
  visibleRubrics: ['rubric-voorstel.pdf'],
};

describe('systeemtekst van de beoordelaar in de chat', () => {
  const p = buildEvaluatorChatPrompt(persona, facts);
  it('spreekt in eigen rol, maar zonder zijn beoordelingsinstructies', () => {
    expect(p).toContain('Je bent Hilda Servaes - Stafchef van Wethouder.');
    expect(p).not.toContain('GEHEIM');
  });
  it('alleen hulp bij inleveren: geen feedback, geen oordeel, niets verzinnen', () => {
    expect(p).toMatch(/Geen inhoudelijke feedback, geen oordeel/);
    expect(p).toMatch(/Niets verzinnen/);
    expect(p).toMatch(/verwijs naar de docent/);
    expect(p).toMatch(/Geen inhoud van een rubric/);
  });
  it('noemt de echte stand: product, rondes, inleveren, rubric die de groep kan openen', () => {
    expect(p).toContain('Projectvoorstel');
    expect(p).toContain('1 van 3 gebruikt, nog 2 over');
    expect(p).toContain('"Inleveren projectproduct"');
    expect(p).toContain(`hoogstens ${SUBMISSION_MAX_MB} MB`);
    expect(p).toContain('rubric-voorstel.pdf');
    expect(p).toContain('nakijkcommentaar');
  });
  it('al ingeleverd, geen inleverknop of onbekende rondes: zegt dat eerlijk', () => {
    expect(buildEvaluatorChatPrompt(persona, { ...facts, finalSubmitted: true })).toContain('is al ingeleverd');
    expect(buildEvaluatorChatPrompt(persona, { ...facts, submissionsEnabled: false })).toContain('geen knop om een eindproduct in te leveren');
    expect(buildEvaluatorChatPrompt(persona, { ...facts, rounds: null })).toContain('weet je nu niet');
    expect(buildEvaluatorChatPrompt(persona, { ...facts, visibleRubrics: [] })).toContain('geen rubric die de groep kan openen');
  });
  it('de toegestane bestanden kloppen met de inleverroute', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'projects', 'documentRoutes.js'), 'utf8');
    for (const ext of SUBMISSION_FILE_TYPES.split(', ')) expect(src).toMatch(new RegExp(`SUBMISSION_ACCEPT_RE = /[^\\n]*\\b${ext}\\b`));
    expect(src).toContain(`SUBMISSION_MAX_BYTES = ${SUBMISSION_MAX_MB} * 1024 * 1024`);
  });
});

describe('koppeling', () => {
  const chat = routeSource("app.post('/api/projects/persona-chat'");
  it('een beoordelaar krijgt de wegwijzertekst, niet zijn eigen instructies of kennis', () => {
    expect(chat).toMatch(/isEvaluator\s*\?\s*`\$\{buildEvaluatorChatPrompt\(persona, evaluatorFacts\)\}/);
    expect(chat).toMatch(/const mode = isEvaluator \? 'none'/);
    expect(chat).toMatch(/persona\.id === '__default__' \|\| !persona\.project_id \|\| isEvaluator/);
    expect(chat).toMatch(/persona\.id === '__default__' \|\| isEvaluator\) return \[\]/);
  });
  it('de nakijkhulp is in de chat alleen voor de docent', () => {
    expect(chat).toMatch(/if \(evaluatorFacts\.isPreassessor\) \{[\s\S]*?isStaffForCourse\(auth\.user, chatProfile, project\.course_id\)/);
  });
  it('studenten zien beoordelaars in de keuzelijst, maar niet de nakijkhulp en niet hoe hij beoordeelt', () => {
    const room = routeSource("app.get('/api/projects/:projectId/room'");
    expect(room).toMatch(/pp\.filter\(p => p\.persona_type !== 'evaluator' \|\| p\.id !== project\.preassessment_persona_id\)/);
    expect(room).toMatch(/if \(p\.persona_type === 'evaluator'\) delete rest\.system_prompt;/);
  });
});
