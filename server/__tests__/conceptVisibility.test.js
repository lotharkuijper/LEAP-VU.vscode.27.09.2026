// Keuzelijst "Begrippen kiezen" (2026-10-16): POST /api/admin/concepts/visibility
// zet ALLEEN de genoemde begrippen van deze cursus op zichtbaar of verborgen.
// Anders dan set-approval mag het nooit begrippen raken die niet in beeld waren.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
const route = src.slice(src.indexOf("app.post('/api/admin/concepts/visibility'"));
const body = route.slice(0, route.indexOf('\n});\n'));

describe('POST /api/admin/concepts/visibility', () => {
  it('bestaat en is alleen voor beheerder of docent van de cursus', () => {
    expect(body.length).toBeGreaterThan(100);
    expect(body).toMatch(/isCourseTeacher\(auth\.user\.id, courseId\)/);
  });
  it('raakt alleen de genoemde begrippen die bij deze cursus horen', () => {
    expect(body).toMatch(/\.in\('id', ids\.slice\(0, 1000\)\)/);
    expect(body).toMatch(/eq\('course_id', courseId\)/);
    expect(body).toMatch(/update\(\{ review_status: visible \? 'approved' : 'rejected' \}\)\.in\('id', inCourse\)/);
    expect(body).not.toMatch(/!approvedSet|toReject/);
  });
});
