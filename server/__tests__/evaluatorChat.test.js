// Chatten met een beoordelaar (2026-11-11): alleen wegwijzer bij inleveren, in
// zijn eigen rol, op basis van de echte stand van de groep. Geen inhoudelijke
// feedback in de chat, geen beoordelingsinstructies of rubric-inhoud, en de
// nakijkhulp van het eindproduct is geen gesprekspartner, ook niet voor de docent.
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
    expect(chat).toMatch(/if \(!persona\.project_id \|\| isEvaluator\) return \{ docs: \[\]/);
    expect(chat).toMatch(/if \(isEvaluator\) return \[\];\s*const \{ data: docs \} = await supabaseAdmin\s*\.from\('project_persona_documents'\)/);
  });
  it('met de nakijkhulp chat niemand, ook de docent niet', () => {
    expect(chat).toMatch(/if \(evaluatorFacts\.isPreassessor\) \{\s*return res\.status\(404\)/);
  });
  it('beoordelaars staan in de keuzelijst, de nakijkhulp voor niemand, en niet hoe hij beoordeelt', () => {
    const room = routeSource("app.get('/api/projects/:projectId/room'");
    expect(room).toMatch(/const filtered = pp\.filter\(p => p\.id !== project\.preassessment_persona_id\);/);
    // Zijn rubric kan de groep wel openen (als die zichtbaar is), zonder naam of avatar.
    expect(room).toMatch(/\? \{ id: p\.id, name: null, avatar_emoji: null, avatar: null, marker: true,/);
    expect(room).toMatch(/if \(p\.persona_type === 'evaluator'\) delete rest\.system_prompt;/);
  });
});

describe('vangnetten', () => {
  it('zonder project gaat de chat met een beoordelaar niet door (nakijkhulp niet te raden)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'projects', 'evaluatorChat.js'), 'utf8');
    expect(src).toMatch(/if \(projectError \|\| !project\) throw new Error/);
  });
  it('de projectruimte toont bij een beoordelaar geen raadpleeglimiet, net als de chat', () => {
    const room = routeSource("app.get('/api/projects/:projectId/room'");
    expect(room).toMatch(/const limit = p\.persona_type === 'evaluator' \? null : conComputeEffectiveLimit/);
    expect(routeSource("app.post('/api/projects/persona-chat'")).toMatch(/const effLimit = isEvaluator \? null : conComputeEffectiveLimit/);
  });
  it('databaseregel: groepsleden lezen geen beoordelaars rechtstreeks; met terugdraaiscript en databasetest', () => {
    const root = path.resolve(__dirname, '..', '..');
    const up = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20261111200000_project_personas_select_talkers.sql'), 'utf8');
    expect(up).toMatch(/COALESCE\(project_personas\.persona_type, 'conversational'\) <> 'evaluator'\s*AND EXISTS/);
    expect(fs.existsSync(path.join(root, 'supabase', 'rollback', '20261111200000_project_personas_select_talkers_down.sql'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'scripts', 'local-db', 'tests', 'project-personas-evaluators.sql'))).toBe(true);
  });
});
