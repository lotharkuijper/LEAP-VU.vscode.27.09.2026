// Integriteit van leergegevens (2026-10-09): verzonnen gesprekken en
// opgeklopte quizscores mogen geen prestatie of vertekend cijfer opleveren.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { countVerifiedPriorStudentMessages, turnSignature, evaluateReadiness, MIN_STUDENT_MESSAGES } from '../readiness.js';
import { buildConceptThermometer, perStudentAverage } from '../analytics/aggregate.js';

const root = path.resolve(__dirname, '..', '..');
const hmac = (t) => createHmac('sha256', 'test-geheim').update(t).digest('base64url');
const U = 'user-1', C = 'course-1';
const sign = (content, userId = U, courseId = C) => turnSignature(hmac, { userId, courseId, content });
const turn = (q, sig = sign(q)) => [{ role: 'user', content: q }, { role: 'assistant', content: 'Antwoord van de tutor.', sig }];
const q = (i) => `Inhoudelijke vraag nummer ${i} over confounding en bias`;
const readinessAsk = { role: 'user', content: 'Ben ik klaar voor een hoger niveau?' };

describe('alleen echte tutorbeurten tellen voor "klaar voor een hoger niveau?"', () => {
  it('ondertekende beurten tellen; de readiness-vraag zelf niet', () => {
    const msgs = [...turn(q(1)), ...turn(q(2)), ...turn(q(3)), readinessAsk];
    expect(countVerifiedPriorStudentMessages(msgs, { hmac, userId: U, courseId: C })).toBe(3);
  });

  it('verzonnen gesprek zonder handtekeningen telt niet → geen prestatie', () => {
    const fake = [...turn(q(1), null), ...turn(q(2), null), ...turn(q(3), null), readinessAsk];
    const n = countVerifiedPriorStudentMessages(fake, { hmac, userId: U, courseId: C });
    expect(n).toBe(0);
    const out = evaluateReadiness({ verdict: 'ready', topic: 'Bias', topics: [{ id: 'b', name: 'Bias' }], priorStudentMessages: n, currentLevel: 2 });
    expect(out.eligible).toBe(false);
    expect(out.reason).toBe('too_short');
  });

  it('handtekening van een ander bericht, andere student of andere cursus telt niet', () => {
    const msgs = [
      { role: 'user', content: q(1) }, { role: 'assistant', content: 'a', sig: sign(q(99)) },         // ander bericht
      { role: 'user', content: q(2) }, { role: 'assistant', content: 'a', sig: sign(q(2), 'user-2') }, // andere student
      { role: 'user', content: q(3) }, { role: 'assistant', content: 'a', sig: sign(q(3), U, 'c-2') }, // andere cursus
      readinessAsk,
    ];
    expect(countVerifiedPriorStudentMessages(msgs, { hmac, userId: U, courseId: C })).toBe(0);
  });

  it('korte berichten tellen niet, ook niet ondertekend', () => {
    const msgs = [...turn('ok'), ...turn('ja hoor'), ...turn(q(1)), readinessAsk];
    expect(countVerifiedPriorStudentMessages(msgs, { hmac, userId: U, courseId: C })).toBe(1);
    expect(MIN_STUDENT_MESSAGES).toBeGreaterThan(1);
  });
});

describe('thermometer: elke student weegt even zwaar', () => {
  it('één student met veel pogingen domineert het gemiddelde niet', () => {
    const honest = ['a', 'b', 'c', 'd', 'e'].map(s => ({ student_id: s, topics: ['Bias'], score_percentage: 80 }));
    const flood = Array.from({ length: 50 }, () => ({ student_id: 'x', topics: ['Bias'], score_percentage: 0 }));
    const r = buildConceptThermometer({ attempts: [...honest, ...flood], concepts: [{ name: 'Bias', aliases: [] }] });
    // (5 × 80 + 1 × 0) / 6 ≈ 67, niet (400 + 0) / 55 ≈ 7.
    expect(r.concepts[0].quiz.avgScore).toBe(67);
    expect(r.concepts[0].quiz.attempts).toBe(55);
  });
  it('perStudentAverage', () => {
    expect(perStudentAverage([
      { student_id: 'a', score_percentage: 100 }, { student_id: 'a', score_percentage: 50 },
      { student_id: 'b', score_percentage: 25 },
    ])).toEqual({ students: 2, attempts: 3, avg: 50 });
  });
});

describe('databaseregels voor leergegevens (migratie)', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261009120000_learning_data_integrity.sql'), 'utf8');
  it('quizpogingen: geen aanpassen achteraf, wel verwijderen; score wordt nagerekend; cursus gecontroleerd', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS "Students can update own attempts" ON public\.quiz_attempts;\s*\n\s*\n/);
    expect(sql).not.toMatch(/CREATE POLICY "Students can update own attempts"/);
    expect(sql).toMatch(/CREATE POLICY "Students can delete own attempts"/);
    expect(sql).toMatch(/CREATE TRIGGER quiz_attempt_rescore BEFORE INSERT ON public\.quiz_attempts/);
    expect(sql).toMatch(/student_id = auth\.uid\(\) AND leap_can_use_course\(course_id\)/);
  });
  it('dagboek: studenten wijzigen geen regels meer (wel maken en verwijderen)', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS "Users can update own journal entries"/);
    expect(sql).not.toMatch(/CREATE POLICY "Users can update own journal entries"/);
  });
  it('de browser wijzigt zelf geen dagboekregels of quizpogingen (anders breekt dit)', () => {
    const offenders = [];
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) { if (f.name !== '__tests__') walk(p); continue; }
        if (!/\.(tsx?|jsx?)$/.test(f.name)) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (/from\('(learning_journal_entries|quiz_attempts)'\)\s*\.update\(/.test(src)) offenders.push(p);
      }
    };
    walk(path.join(root, 'src'));
    expect(offenders).toEqual([]);
  });
  it('terugdraaiscript bestaat en de API herlaadt het schema', () => {
    expect(fs.existsSync(path.join(root, 'supabase/rollback/20261009120000_learning_data_integrity_down.sql'))).toBe(true);
    expect(sql).toContain("NOTIFY pgrst, 'reload schema'");
  });
});
