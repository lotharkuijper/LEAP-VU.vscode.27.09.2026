import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { routeSource, serverFiles, fileSource } from './helpers/serverSource.js';
import {
  authorizeMemberRoleChange,
  checkLastTeacherProtection,
  parseForceFlag,
  profileRoleForCourseTeacher,
} from '../courses/memberRoleAuth.js';

describe('authorizeMemberRoleChange', () => {
  it('staat admin altijd toe', () => {
    expect(authorizeMemberRoleChange({ isAdmin: true, isCourseTeacher: false })).toEqual({ allowed: true });
  });
  it('staat per-cursus docent van déze cursus toe', () => {
    expect(authorizeMemberRoleChange({ isAdmin: false, isCourseTeacher: true })).toEqual({ allowed: true });
  });
  it('weigert non-admin die geen docent van deze cursus is met 403', () => {
    const r = authorizeMemberRoleChange({ isAdmin: false, isCourseTeacher: false });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/admin of docent/i);
  });
});

describe('checkLastTeacherProtection', () => {
  it('laat student→teacher promotie altijd toe', () => {
    expect(checkLastTeacherProtection({
      existingMemberRole: 'student', newMemberRole: 'teacher',
      teacherCount: 1, isAdmin: false, force: false,
    })).toEqual({ ok: true });
  });
  it('laat teacher→student toe wanneer er nog meerdere docenten zijn', () => {
    expect(checkLastTeacherProtection({
      existingMemberRole: 'teacher', newMemberRole: 'student',
      teacherCount: 3, isAdmin: false, force: false,
    })).toEqual({ ok: true });
  });
  it('weigert demotie van laatste docent met 409 last_teacher voor niet-admin', () => {
    const r = checkLastTeacherProtection({
      existingMemberRole: 'teacher', newMemberRole: 'student',
      teacherCount: 1, isAdmin: false, force: false,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('last_teacher');
  });
  it('weigert ook voor admin zonder force', () => {
    const r = checkLastTeacherProtection({
      existingMemberRole: 'teacher', newMemberRole: 'student',
      teacherCount: 1, isAdmin: true, force: false,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });
  it('weigert non-admin zelfs met force=true', () => {
    const r = checkLastTeacherProtection({
      existingMemberRole: 'teacher', newMemberRole: 'student',
      teacherCount: 1, isAdmin: false, force: true,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });
  it('staat admin+force toe op laatste docent (cursus mag docentloos)', () => {
    expect(checkLastTeacherProtection({
      existingMemberRole: 'teacher', newMemberRole: 'student',
      teacherCount: 1, isAdmin: true, force: true,
    })).toEqual({ ok: true });
  });
  it('behandelt teacherCount=0 als "laatste" en weigert zonder admin+force', () => {
    const r = checkLastTeacherProtection({
      existingMemberRole: 'teacher', newMemberRole: 'student',
      teacherCount: 0, isAdmin: false, force: false,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });
});

describe('parseForceFlag', () => {
  it('herkent "1" en "true" (case-insensitive)', () => {
    expect(parseForceFlag('1')).toBe(true);
    expect(parseForceFlag('true')).toBe(true);
    expect(parseForceFlag('TRUE')).toBe(true);
  });
  it('weigert al het andere', () => {
    expect(parseForceFlag(undefined)).toBe(false);
    expect(parseForceFlag(null)).toBe(false);
    expect(parseForceFlag('')).toBe(false);
    expect(parseForceFlag('0')).toBe(false);
    expect(parseForceFlag('false')).toBe(false);
    expect(parseForceFlag('yes')).toBe(false);
  });
});


// Regressie 2026-10-16: een docent in een cursus met een studentprofiel kon geen
// project aanmaken ("new row violates row-level security policy for table projects"),
// omdat pr_is_course_teacher profiles.role = 'docent' eist.
describe('profielrol bij docent worden in een cursus', () => {
  it('student wordt docent; andere rollen blijven', () => {
    expect(profileRoleForCourseTeacher('student')).toBe('docent');
    expect(profileRoleForCourseTeacher(null)).toBe('docent');
    expect(profileRoleForCourseTeacher('docent')).toBe(null);
    expect(profileRoleForCourseTeacher('admin')).toBe(null);
  });
  it('beide routes die iemand docent maken, zetten het profiel mee', () => {
    for (const route of ["app.put('/api/admin/courses/:id/members/:userId'", "app.post('/api/admin/courses/:id/members/:userId'"]) {
      const body = routeSource(route);
      expect(body).toMatch(/member_role === 'teacher' \? await promoteCourseTeacherProfile\(/);
    }
  });
  it('promoveren in Beheer leden zet het profiel ook op het pad met directe databaseverbinding (live, regressie 2026-10-27)', () => {
    const body = routeSource("app.put('/api/admin/courses/:id/members/:userId'");
    const pgPath = body.slice(body.indexOf('if (pgPool)'), body.indexOf('// Fallback zonder directe DB-verbinding'));
    expect(pgPath).toMatch(/COMMIT[\s\S]*member_role === 'teacher' \? await promoteCourseTeacherProfile\(/);
  });
  it('"Docent toevoegen" (uitnodigen met role teacher) zet het docentprofiel', () => {
    // De registratie-aanroep zelf (precies één), gevonden door de code te ontleden.
    const calls = [];
    for (const rel of serverFiles()) {
      const src = fileSource(rel);
      if (!src.includes('registerCourseInvitationRoutes(')) continue;
      const visit = (n) => {
        if (!n || typeof n.type !== 'string') return;
        if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'registerCourseInvitationRoutes') calls.push(src.slice(n.start, n.end));
        for (const v of Object.values(n)) (Array.isArray(v) ? v : [v]).forEach((c) => c && typeof c.type === 'string' && visit(c));
      };
      visit(acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' }));
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/registerCourseInvitationRoutes\(app, \{[\s\S]*promoteTeacherProfile: promoteCourseTeacherProfile/);
  });
  it('de databaseregel voor projecten kijkt naar het docentprofiel', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', 'supabase/migrations/20260605120000_projects_strict_course_scope.sql'), 'utf8');
    expect(sql).toMatch(/projects_course_teacher_manage[\s\S]*pr_is_course_teacher\(course_id\)/);
  });
});
