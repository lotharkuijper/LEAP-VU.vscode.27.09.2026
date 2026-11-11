// Beoordeling vóór personages (besluit 2026-11-11): de docent kiest hoe hij
// feedback en beoordeling wil (projects.feedback_mode), en een project zonder
// personages heeft geen gesprekspartner, ook geen standaard-"Consultant".
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { routeSource } from './helpers/serverSource.js';

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

describe('feedback_mode', () => {
  const patch = routeSource("app.patch('/api/projects/:projectId'");
  it('de docent kan de keuze bewaren, alleen een van de drie of leeg', () => {
    expect(patch).toMatch(/'group_mode', 'feedback_mode'\]/);
    expect(patch).toMatch(/patch\.feedback_mode !== null && !FEEDBACK_MODES\.includes\(patch\.feedback_mode\)/);
    expect(read('projects/groupRoutes.js')).toContain("const FEEDBACK_MODES = ['marking', 'both', 'feedback'];");
  });
  it('dezelfde waarden als de databaseregel', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', 'supabase', 'migrations', '20261111300000_project_feedback_mode.sql'), 'utf8');
    expect(sql).toContain("feedback_mode IN ('marking', 'both', 'feedback')");
  });
});

describe('geen personages, geen gesprekspartner', () => {
  it('de projectruimte en de personagechat kennen geen standaardpersonage', () => {
    for (const f of ['projects/roomRoutes.js', 'projects/personaRoutes.js']) {
      expect(read(f), f).not.toContain('__default__');
      expect(read(f), f).not.toContain("name: 'Consultant'");
    }
  });
});
