// Groepsindeling door de docent (2026-11-11): een docent komt nooit via indelen in
// een groep met studenten (dan zou hij hun groepsinhoud zien), en een student niet
// in de testgroep van een docent. Gedragstest met een nep-database.
import { describe, it, expect } from 'vitest';
import { studentsOfCourse, groupHasTeacher } from '../projects/projectGroups.js';

const tables = {
  course_members: [
    { course_id: 'c', user_id: 's1', member_role: 'student' },
    { course_id: 'c', user_id: 's2', member_role: null },
    { course_id: 'c', user_id: 't1', member_role: 'teacher' },
    { course_id: 'other', user_id: 'x', member_role: 'student' },
  ],
  project_group_members: [
    { group_id: 'test', user_id: 't1' },
    { group_id: 'students', user_id: 's1' },
  ],
};
const db = {
  from(table) {
    const fs = [];
    const chain = {
      select() { return chain; },
      eq(col, val) { fs.push(r => r[col] === val); return chain; },
      in(col, vals) { fs.push(r => vals.includes(r[col])); return chain; },
      then(resolve) { return resolve({ data: tables[table].filter(r => fs.every(f => f(r))), error: null }); },
    };
    return chain;
  },
};

describe('indelen door de docent', () => {
  it('automatisch verdelen houdt alleen studenten van de cursus over', async () => {
    expect(await studentsOfCourse(db, 'c', ['s1', 's2', 't1', 'x', 'onbekend'])).toEqual(['s1', 's2']);
    expect(await studentsOfCourse(db, 'c', [])).toEqual([]);
  });

  it('de testgroep van een docent herkent LEAP', async () => {
    expect(await groupHasTeacher(db, 'c', 'test')).toBe(true);
    expect(await groupHasTeacher(db, 'c', 'students')).toBe(false);
    expect(await groupHasTeacher(db, 'c', 'leeg')).toBe(false);
  });
});
