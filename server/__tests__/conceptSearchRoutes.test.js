// Toegang tot de routes bij "Begrippen zoeken" en "Klaar voor studenten"
// (2026-11-25): alleen beheerders of docenten van precies deze cursus.
import { describe, it, expect } from 'vitest';
import { routeSource } from './helpers/serverSource.js';

describe('nieuwe begrippenroutes', () => {
  it.each([
    "app.get('/api/admin/concepts/search-scope'",
    "app.post('/api/admin/concepts/removed-reset'",
    "app.patch('/api/admin/concepts/:id'",
  ])('%s controleert eerst docent-van-deze-cursus', (sig) => {
    const body = routeSource(sig);
    const check = body.indexOf('requireConceptStaff(req, res, courseId)');
    expect(check).toBeGreaterThan(0);
    // Geen database-actie vóór de toegangscontrole.
    const firstDb = body.search(/supabaseAdmin|readKeyValue|writeKeyValue|conceptSourceDocIds\(/);
    expect(firstDb).toBeGreaterThan(check);
  });

  it('een uitleg aanpassen kan alleen bij een begrip van deze cursus', () => {
    const body = routeSource("app.patch('/api/admin/concepts/:id'");
    expect(body).toMatch(/conceptCourseId\(found\) !== courseId\) return res\.status\(404\)/);
    expect(body).toMatch(/definition\.length > MAX_DEFINITION/);
    expect(body).not.toMatch(/\.or\(/);
  });

  it('verwijderen: beheerder, of docent van de cursus waar het begrip bij hoort', () => {
    const body = routeSource("app.delete('/api/admin/concepts/:id'");
    expect(body).toMatch(/const courseId = conceptCourseId\(concept\)/);
    expect(body).toMatch(/if \(!isAdmin && !\(courseId && await isCourseTeacher\(user\.id, courseId\)\)\)/);
    // De toegangscontrole staat vóór verbergen of verwijderen.
    expect(body.indexOf('isCourseTeacher')).toBeLessThan(body.indexOf("update({ review_status: 'rejected' })"));
    expect(body.indexOf('isCourseTeacher')).toBeLessThan(body.indexOf('.delete()'));
  });
});
