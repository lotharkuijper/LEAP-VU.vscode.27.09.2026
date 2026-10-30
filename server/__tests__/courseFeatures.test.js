// Onderdelen per cursus aan/uit (2026-10-15): pure regels + bewaking dat de
// schakelaar overal meedoet waar studenten iets gebruiken of iets in hun
// leerdagboek terechtkomt (server/courses/courseFeatures.js, migratie
// 20261015100000_course_features).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  COURSE_FEATURES, normalizeCourseFeatures, isFeatureOn, parseCourseFeaturesPatch, mergeCourseFeatures,
  featureForChatRequest, featureAllowed,
} from '../courses/courseFeatures.js';
import { summarizeCourse } from '../system/designAssistant.js';
import { serverFiles, fileSource, allServerSource, routeSource, functionSource } from './helpers/serverSource.js';

const root = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('regels', () => {
  it('niets opgeslagen = alles aan; alleen false zet uit', () => {
    // Opt-in-onderdelen (bijlagen in de chat) staan juist standaard uit.
    expect(normalizeCourseFeatures(null)).toEqual({ ...Object.fromEntries(COURSE_FEATURES.map(k => [k, true])), explainSelf: true, explainImprove: true, attachments: false, formulaEditor: false });
    expect(normalizeCourseFeatures({ quiz: false, chat: 'nee', onbekend: false })).toMatchObject({ quiz: false, chat: true });
    expect(normalizeCourseFeatures(['quiz'])).toMatchObject({ quiz: true });
    expect(isFeatureOn({ journal: false }, 'journal')).toBe(false);
    expect(isFeatureOn({}, 'iets-anders')).toBe(true);
  });

  it('wijziging: alleen bekende onderdelen met een echte ja/nee', () => {
    expect(parseCourseFeaturesPatch({ features: { quiz: false } })).toEqual({ ok: true, value: { quiz: false } });
    expect(parseCourseFeaturesPatch({}).ok).toBe(false);
    expect(parseCourseFeaturesPatch({ features: {} }).ok).toBe(false);
    expect(parseCourseFeaturesPatch({ features: { quiz: 'false' } }).ok).toBe(false);
    expect(parseCourseFeaturesPatch({ features: { admin: false } }).ok).toBe(false);
  });

  it('opslaan bewaart alleen wat uit staat', () => {
    expect(mergeCourseFeatures({ quiz: false }, { chat: false })).toEqual({ quiz: false, chat: false });
    expect(mergeCourseFeatures({ quiz: false }, { quiz: true })).toEqual({});
  });

  it('/api/chat: alleen herkenbare aanroepen horen bij een onderdeel', () => {
    expect(featureForChatRequest({ purpose: 'tutor_chat' })).toBe('chat');
    expect(featureForChatRequest({ readinessCheck: true })).toBe('chat');
    expect(featureForChatRequest({ promptMode: 'explain' })).toBe('explain');
    expect(featureForChatRequest({ promptMode: 'quiz_generate_strict' })).toBe('quiz');
    expect(featureForChatRequest({ promptMode: 'quiz_evaluate_open' })).toBe('quiz');
    // Beheer (begrippenextractie) en onbekende aanroepen worden niet tegengehouden.
    expect(featureForChatRequest({ skipSystemPrompt: true })).toBe(null);
    expect(featureForChatRequest(undefined)).toBe(null);
  });

  it('docent en beheerder mogen een uitgezet onderdeel gebruiken, studenten niet', () => {
    expect(featureAllowed({ features: { quiz: false }, feature: 'quiz', isStaff: false })).toBe(false);
    expect(featureAllowed({ features: { quiz: false }, feature: 'quiz', isStaff: true })).toBe(true);
    expect(featureAllowed({ features: {}, feature: 'quiz', isStaff: false })).toBe(true);
  });
});

describe('database', () => {
  const up = read('supabase/migrations/20261015100000_course_features.sql');
  it('wat de browser zelf schrijft, controleert de database', () => {
    expect(up).toMatch(/ON public\.conversations[\s\S]*?leap_course_feature_on\(course_id, 'chat'\)/);
    expect(up).toMatch(/ON public\.quiz_attempts[\s\S]*?leap_course_feature_on\(course_id, 'quiz'\)/);
    expect(up).toMatch(/ON public\.learning_journal_entries[\s\S]*?leap_course_feature_on\(course_id, 'journal'\)/);
    expect(up).toContain("NOTIFY pgrst, 'reload schema'");
  });
  it('beoordelingen bij de groep: alleen groepsleden en beheerders lezen (privacyregel)', () => {
    expect(up).toMatch(/project_group_assessments FOR SELECT TO authenticated\s+USING \(pr_is_group_member\(group_id\) OR pr_is_admin\(\)\)/);
  });
  it('heeft een terugdraaiscript', () => {
    const down = read('supabase/rollback/20261015100000_course_features_down.sql');
    expect(down).toContain('DROP FUNCTION IF EXISTS public.leap_course_feature_on');
    expect(down).toContain('WITH CHECK (user_id = auth.uid());');
  });
});

describe('server (routes)', () => {

  it('/api/chat houdt een uitgezet onderdeel tegen', () => {
    const route = routeSource("app.post('/api/chat',");
    const feature = route.indexOf('featureForChatRequest(req.body)');
    expect(feature).toBeGreaterThan(0);
    // Zelfde deel van de route als vroeger: vóór de readiness-vraag.
    expect(feature).toBeLessThan(route.indexOf('// Readiness-vraag'));
    expect(route.indexOf('rejectIfFeatureOff(')).toBeGreaterThan(0);
    expect(route.indexOf('rejectIfFeatureOff(')).toBeLessThan(route.indexOf('// Readiness-vraag'));
  });

  it('elke dagboekregel die de server schrijft, kijkt eerst of het leerdagboek aan staat', () => {
    // Faalt deze test? Dan schrijft een nieuwe plek in het leerdagboek zonder
    // de schakelaar: zet er courseFeatureOnFor(…, 'journal') of
    // loadCourseFeatures(…).journal vóór.
    const guard = /courseFeatureOnFor\(|loadCourseFeatures\(|journalOn|rejectIfFeatureOff\(.*'journal'/;
    // Over alle servermodules (sinds de opsplitsing van server/index.js staan
    // de schrijvende routes in domeinmodules).
    const unguarded = [];
    let inserts = 0;
    for (const file of serverFiles()) {
      const lines = fileSource(file).split('\n');
      lines.forEach((line, i) => {
        if (!line.includes("from('learning_journal_entries')")) return;
        if (!/\.insert\(/.test(line + (lines[i + 1] || ''))) return;
        inserts += 1;
        const window = lines.slice(Math.max(0, i - 150), i).join('\n');
        if (!guard.test(window)) unguarded.push(`${file}:${i + 1}`);
      });
    }
    expect(inserts).toBeGreaterThanOrEqual(6); // anders zoekt de test op de verkeerde plek
    expect(unguarded).toEqual([]);
  });

  it('projecten en studiecafé volgen de schakelaar', () => {
    const access = functionSource('userHasProjectAccess');
    expect(access).toContain('.projects === false');
    expect(allServerSource()).toMatch(/registerStudiecafeRoutes\(app, \{[\s\S]*?courseFeatureOnFor\(user, profile, courseId, 'studiecafe'\)/);
  });
});

describe('Ontwerphulp', () => {
  it('noemt welke onderdelen uit staan', () => {
    const text = summarizeCourse({ course: { name: 'E&B1', features: { quiz: false, journal: false } } });
    expect(text).toMatch(/Onderdelen voor studenten: uit: Quiz, Leerdagboek/);
    expect(summarizeCourse({ course: { name: 'E&B1' } })).toContain('Onderdelen voor studenten: alles aan');
  });
});
