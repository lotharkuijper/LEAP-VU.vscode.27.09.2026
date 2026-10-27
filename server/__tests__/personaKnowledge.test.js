import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  isDataDocument, canBeKnowledge, knowledgeFieldsFrom, copyKnowledgeFields, filterKnowledgeIds,
  buildEvaluatorMaterial, buildProjectKnowledgeContext, knownByMap, EVALUATOR_TOTAL_MAX_CHARS,
} from '../personaKnowledge.js';

// "Wat kent deze persona?" (2026-10-27). Per persona kiest de docent welke
// cursusbestanden en projectdocumenten de persona kent; nieuwe persona's kennen
// niets; databestanden zijn nooit kennis; studenten zien de keuze niet.

const root = path.resolve(__dirname, '..', '..');
const idx = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('databestanden zijn nooit kennis van een persona', () => {
  it('soort data, of een data-extensie zonder andere soort', () => {
    expect(isDataDocument({ filename: 'monitor.omv' })).toBe(true);
    expect(isDataDocument({ filename: 'monitor.xlsx' })).toBe(true);
    expect(isDataDocument({ filename: 'verslag.docx', material_kind: 'data' })).toBe(true);
    expect(isDataDocument({ filename: 'verslag.docx' })).toBe(false);
    // Een uitdrukkelijk gekozen andere soort gaat voor de extensie (bijv. een woordenlijst als csv).
    expect(isDataDocument({ filename: 'begrippen.csv', material_kind: 'literature' })).toBe(false);
  });
  it('kennis vraagt tekst en geen data', () => {
    expect(canBeKnowledge({ filename: 'briefing.docx', content_text: 'De opdracht…' })).toBe(true);
    expect(canBeKnowledge({ filename: 'briefing.docx', content_text: '   ' })).toBe(false);
    expect(canBeKnowledge({ filename: 'monitor.csv', content_text: 'a;b;c' })).toBe(false);
  });
});

describe('velden', () => {
  it('nieuw = kent niets; onbekende waarden worden niets', () => {
    expect(knowledgeFieldsFrom({})).toEqual({ course_knowledge: 'none', course_knowledge_doc_ids: [], project_knowledge_doc_ids: [] });
    expect(knowledgeFieldsFrom({ course_knowledge: 'alles' }).course_knowledge).toBe('none');
  });
  it('alleen geldige, unieke ids', () => {
    expect(knowledgeFieldsFrom({ project_knowledge_doc_ids: [A, A, 'x', 5, B] }).project_knowledge_doc_ids).toEqual([A, B]);
  });
  it('PATCH: alleen meegestuurde velden; een sjabloon heeft geen projectdocumenten', () => {
    expect(knowledgeFieldsFrom({ name: 'x' }, { partial: true })).toEqual({});
    expect(knowledgeFieldsFrom({ project_knowledge_doc_ids: [A] }, { project: false })).not.toHaveProperty('project_knowledge_doc_ids');
  });
  it('kopiëren: cursuskennis mee, projectdocumenten niet', () => {
    const src = { course_knowledge: 'selected', course_knowledge_doc_ids: [A], project_knowledge_doc_ids: [B] };
    expect(copyKnowledgeFields(src)).toEqual({ course_knowledge: 'selected', course_knowledge_doc_ids: [A], project_knowledge_doc_ids: [] });
    expect(copyKnowledgeFields(src, { project: false })).toEqual({ course_knowledge: 'selected', course_knowledge_doc_ids: [A] });
  });
  it('filter: alleen documenten van deze cursus/dit project, nooit data; gekozen bestanden alleen bij "selected"', () => {
    const { fields, dropped } = filterKnowledgeIds(
      { course_knowledge: 'selected', course_knowledge_doc_ids: [A, B], project_knowledge_doc_ids: [A, B, C] },
      { courseDocIds: [A], projectDocs: [
        { id: A, filename: 'briefing.docx', content_text: 'x' },
        { id: B, filename: 'monitor.xlsx', content_text: 'x' },
      ] },
    );
    expect(fields.course_knowledge_doc_ids).toEqual([A]);
    expect(fields.project_knowledge_doc_ids).toEqual([A]);
    expect(dropped.project).toEqual([B, C]);
    expect(filterKnowledgeIds({ course_knowledge: 'all', course_knowledge_doc_ids: [A] }).fields.course_knowledge_doc_ids).toEqual([]);
  });
});

describe('beoordelaar en chat-persona', () => {
  it('een beoordelaar leest zijn documenten in hun geheel, met een plafond, zonder data', () => {
    const text = buildEvaluatorMaterial([
      { filename: 'rubric.docx', material_kind: 'rubric', content_text: 'Criterium 1 … Criterium 9' },
      { filename: 'monitor.xlsx', content_text: 'cijfers' },
    ]);
    expect(text).toContain('[Rubric: rubric.docx]');
    expect(text).toContain('Criterium 9');
    expect(text).not.toContain('cijfers');
    const big = buildEvaluatorMaterial([1, 2, 3].map((i) => ({ filename: `d${i}.txt`, content_text: 'x'.repeat(30000) })));
    expect(big.length).toBeLessThanOrEqual(EVALUATOR_TOTAL_MAX_CHARS);
  });
  it('zichtbaar document → bronnummer; verborgen → achtergrond zonder bron; niet doorzoekbaar → begin gaat mee', () => {
    const docs = [
      { id: A, filename: 'casus.pdf', is_visible_to_students: true, document_ref_id: 'r1' },
      { id: B, filename: 'notitie-corporatie.docx', is_visible_to_students: false, document_ref_id: 'r2' },
      { id: C, filename: 'nieuw.docx', is_visible_to_students: true, document_ref_id: null, content_text: 'Begin van het document' },
    ];
    const out = buildProjectKnowledgeContext({
      matched: [{ document_id: 'r1', content: 'Het winkelcentrum…', similarity: 0.7 }, { document_id: 'r2', content: 'Interne cijfers…' }],
      docs, unindexed: [docs[2]], startIndex: 3,
    });
    expect(out.sources.map((s) => [s.index, s.documentRef, s.kind])).toEqual([[3, A, 'project_document'], [4, C, 'project_document']]);
    expect(out.citedContext).toContain('[3] casus.pdf');
    expect(out.citedContext).toContain('Begin van het document');
    expect(out.backgroundContext).toContain('Interne cijfers');
    expect(out.citedContext).not.toContain('Interne cijfers');
  });
  it('overzicht wie welk document kent', () => {
    expect(knownByMap([{ id: 'p1', name: 'Ambtenaar', project_knowledge_doc_ids: [A] }, { id: 'p2', name: 'Bewoner', project_knowledge_doc_ids: [] }]))
      .toEqual({ [A]: [{ id: 'p1', name: 'Ambtenaar' }] });
  });
});

describe('koppeling in de server', () => {
  it('elke plek die een rol kopieert, kopieert ook de kennis', () => {
    const roleCopies = (idx.match(/\.\.\.copyRoleFields\(\w+\),/g) || []).length;
    const knowledgeCopies = (idx.match(/\.\.\.copyKnowledgeFields\(\w+(, \{ project: false \})?\),/g) || []).length;
    expect(roleCopies).toBeGreaterThan(0);
    expect(knowledgeCopies).toBe(roleCopies);
  });
  it('aanmaken en bewerken schonen de kennis op (sjablonen en projectkopieën)', () => {
    expect((idx.match(/sanitizePersonaKnowledge\(knowledgeFieldsFrom\(req\.body/g) || []).length).toBe(4);
  });
  it('het persona-gesprek leest niet meer álle projectdocumenten, en niet rag_enabled', () => {
    const start = idx.indexOf("app.post('/api/projects/persona-chat'");
    const route = idx.slice(start, idx.indexOf('\napp.', start + 10));
    expect(route).not.toMatch(/from\('project_documents'\)/);
    expect(route).not.toMatch(/persona\.rag_enabled/);
    expect(route).toMatch(/loadPersonaProjectDocs\(supabaseAdmin, persona\)/);
    expect(route).toMatch(/persona\.course_knowledge/);
  });
  it('beoordelaars lezen hun kennis, niet meer de oude rubric-uploads of alle projectdocumenten', () => {
    expect(idx).not.toMatch(/\.eq\('is_hidden_rubric', true\);\n\s*const rubricBlock/);
    expect((idx.match(/await loadEvaluatorMaterial\(supabaseAdmin, \w+\)/g) || []).length).toBe(2);
    const pre = fs.readFileSync(path.join(root, 'server', 'preassessment.js'), 'utf8');
    expect(pre).not.toMatch(/is_hidden_rubric/);
    expect(pre).toMatch(/buildEvaluatorMaterial\(rubricDocs\)/);
  });
  it('studenten krijgen de kennisinstellingen niet mee in de projectkamer', () => {
    expect(idx).toMatch(/const \{ course_knowledge: _ck, course_knowledge_doc_ids: _cd, project_knowledge_doc_ids: _pd, rag_folder_ids: _rf, \.\.\.rest \} = p;/);
  });
  it('verwijderen of omzetten naar data haalt het document weg uit wat persona\'s kennen', () => {
    expect(idx).toMatch(/update\.material_kind === 'data' \? await forgetProjectDocKnowledge\(projectId, docId\)/);
    const del = idx.slice(idx.indexOf("app.delete('/api/projects/:projectId/documents/:docId'"));
    expect(del.slice(0, 1500)).toMatch(/await forgetProjectDocKnowledge\(projectId, docId\)/);
  });
  it('migratie met terugdraaiscript', () => {
    expect(fs.existsSync(path.join(root, 'supabase', 'migrations', '20261027120000_persona_knowledge.sql'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'supabase', 'rollback', '20261027120000_persona_knowledge_down.sql'))).toBe(true);
  });
});
