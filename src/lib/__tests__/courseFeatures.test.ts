import { describe, it, expect } from 'vitest';
import { normalizeCourseFeatures, featureForPath, featureView, COURSE_FEATURES } from '../courseFeatures';
import * as server from '../../../server/courseFeatures.js';

describe('onderdelen per cursus (browser)', () => {
  it('zelfde lijst en regels als de server', () => {
    expect([...COURSE_FEATURES]).toEqual([...server.COURSE_FEATURES]);
    for (const raw of [null, {}, { quiz: false }, { chat: false, journal: false }, ['x'], { quiz: 'false' }]) {
      expect(normalizeCourseFeatures(raw)).toEqual(server.normalizeCourseFeatures(raw));
    }
  });

  it('elke studentpagina hoort bij zijn onderdeel', () => {
    expect(featureForPath('/chat')).toBe('chat');
    expect(featureForPath('/explain')).toBe('explain');
    expect(featureForPath('/quiz')).toBe('quiz');
    expect(featureForPath('/projects/abc/group/def')).toBe('projects');
    expect(featureForPath('/feedback')).toBe('journal');
    expect(featureForPath('/studiecafe')).toBe('studiecafe');
    expect(featureForPath('/dashboard')).toBe(null);
    expect(featureForPath('/my-data')).toBe(null);
  });

  it('student ziet een uitgezet onderdeel niet; docent wel, met label', () => {
    const f = normalizeCourseFeatures({ quiz: false });
    expect(featureView(f, 'quiz', false)).toEqual({ visible: false, offForStudents: true });
    expect(featureView(f, 'quiz', true)).toEqual({ visible: true, offForStudents: true });
    expect(featureView(f, 'chat', false)).toEqual({ visible: true, offForStudents: false });
  });
});
