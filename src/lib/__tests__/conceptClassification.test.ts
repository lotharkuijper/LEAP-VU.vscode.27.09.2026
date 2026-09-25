import { describe, it, expect } from 'vitest';
import { classifyConceptForTeacher, getDifficultyTier } from '../conceptClassification';

describe('classifyConceptForTeacher', () => {
  it('classificeert concept_role=example_instance altijd als voorbeeld, ongeacht bewijsaantal', () => {
    const concept = { id: 'c1', concept_role: 'example_instance' };
    expect(classifyConceptForTeacher(concept, { c1: 5 })).toBe('example');
    expect(classifyConceptForTeacher(concept, {})).toBe('example');
  });

  it('classificeert een begrip met bewijs in meerdere modules als cursusconcept', () => {
    const concept = { id: 'c2', concept_role: 'main_course_concept' };
    expect(classifyConceptForTeacher(concept, { c2: 3 })).toBe('course');
  });

  it('classificeert een begrip met bewijs uit precies één module als moduleconcept', () => {
    const concept = { id: 'c3', concept_role: 'method_term' };
    expect(classifyConceptForTeacher(concept, { c3: 1 })).toBe('module');
  });

  it('valt terug op moduleconcept wanneer er nog geen gekoppeld bewijs is', () => {
    const concept = { id: 'c4', concept_role: 'definition_term' };
    expect(classifyConceptForTeacher(concept, {})).toBe('module');
  });

  it('behandelt een ontbrekende concept_role (legacy rij) niet als voorbeeld', () => {
    const concept = { id: 'c5', concept_role: null };
    expect(classifyConceptForTeacher(concept, { c5: 2 })).toBe('course');
  });
});

describe('getDifficultyTier', () => {
  it('geeft de opgeslagen moeilijkheidsgraad terug', () => {
    expect(getDifficultyTier({ id: 'c1', difficulty: 'hard' })).toBe('hard');
    expect(getDifficultyTier({ id: 'c1', difficulty: 'easy' })).toBe('easy');
    expect(getDifficultyTier({ id: 'c1', difficulty: 'medium' })).toBe('medium');
  });

  it('valt terug op medium voor een nog niet beoordeeld begrip (geen aanname van makkelijk/moeilijk)', () => {
    expect(getDifficultyTier({ id: 'c1', difficulty: null })).toBe('medium');
    expect(getDifficultyTier({ id: 'c1' })).toBe('medium');
  });

  it('negeert een ongeldige/onverwachte waarde en valt terug op medium', () => {
    expect(getDifficultyTier({ id: 'c1', difficulty: 'onbekend' })).toBe('medium');
  });
});
