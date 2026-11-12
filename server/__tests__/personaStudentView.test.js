// Wat studenten van een persona krijgen (besluit 2026-11-12): hoe een persona is
// ingericht (kennis, gedragsregels van een rolspeler, instructies van een
// beoordelaar) is voor de docent. Studenten krijgen persona's alleen via de
// server, en lezen ze niet rechtstreeks uit de database.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { routeSource } from './helpers/serverSource.js';
import { studentPersonaView } from '../projects/studentPersonaView.js';

const root = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('projectruimte', () => {
  const room = routeSource("app.get('/api/projects/:projectId/room'");
  it('studenten krijgen alleen wat de projectruimte toont, bij project- en cursuspersona\'s', () => {
    expect(room.match(/isStaff \? \{ \.\.\.p, _source: '(project|course)' \} : \{ \.\.\.studentPersonaView\(p\), _source: '\1' \}/g)).toHaveLength(2);
  });
  it('geen instructies, kennis of gedragsregels; een nieuwe kolom gaat niet vanzelf mee', () => {
    const row = {
      id: 'p1', name: 'Wethouder', avatar_emoji: '🙂', avatar: null, persona_type: 'roleplayer', sort_order: 0,
      reputation_enabled: true, max_consultations: 3, rag_enabled: true,
      system_prompt: 'GEHEIM', conduct_rules: { positive: 'beleefd' }, start_level: -1,
      course_knowledge: 'all', course_knowledge_doc_ids: ['c'], project_knowledge_doc_ids: ['d'], rag_folder_ids: ['f'],
      nieuwe_kolom: 'x',
    };
    expect(studentPersonaView(row)).toEqual({
      id: 'p1', name: 'Wethouder', avatar_emoji: '🙂', avatar: null, persona_type: 'roleplayer', sort_order: 0,
      reputation_enabled: true, max_consultations: 3, rag_enabled: true,
    });
  });
});

describe('database', () => {
  const sql = read('supabase/migrations/20261112100000_project_personas_staff_read.sql');
  it('alleen staf en beheerders lezen persona\'s rechtstreeks', () => {
    const policy = sql.slice(sql.indexOf('CREATE POLICY project_personas_select'), sql.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(policy).toContain('pr_is_course_staff(p.course_id)');
    expect(policy).toContain('pr_is_admin()');
    expect(policy).not.toContain('project_group_members');
  });
  it('het label geeft alleen naam en project, aan leden van een open project', () => {
    expect(sql).toMatch(/RETURNS TABLE \(persona_name text, project_title text, course_id uuid\)/);
    expect(sql).toMatch(/p\.status IS DISTINCT FROM 'draft'/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.pr_persona_label\(uuid\) FROM PUBLIC, anon;/);
    expect(fs.existsSync(path.join(root, 'supabase/rollback/20261112100000_project_personas_staff_read_down.sql'))).toBe(true);
  });
  it('het dashboard leest geen persona-rijen meer', () => {
    const dash = read('src/pages/DashboardPage.tsx');
    expect(dash).not.toMatch(/project_personas!inner/);
    expect(dash).toContain(".call(supabase, 'pr_persona_label', { p_persona_id: personaId })");
  });
});
