// Beoordelaars (herzien 2026-09-29): een beoordelaar geeft feedback op werk dat
// de groep inlevert, met een vast aantal rondes, en heeft GEEN verstandhouding.
// Hier de regels die de server daarvoor gebruikt:
//   - feedback is zuiver formatief: geen cijfer, oordeel of badge (2026-11-10);
//   - feedback moet geldig zijn (anders geen ronde verbruikt);
//   - het aantal rondes is begrensd door max_reviews (null = onbeperkt);
//   - het oordeel wijzigt geen verstandhouding (relationship_delta telt niet mee).

import { describe, it, expect } from 'vitest';
import { validateReviewResponse, feedbackRoundsState } from '../projects/documentReview.js';
import { reputationActive, roleFieldsFrom } from '../projects/personaRoles.js';
import { functionSource, routeSource } from './helpers/serverSource.js';

describe('feedback vragen bij een beoordelaar', () => {
  it('feedback zonder inhoud wordt afgewezen; een cijfer of oordeel komt er nooit door', () => {
    expect(validateReviewResponse('{"grade": 7, "verdict": "accepted"}').ok).toBe(false);
    const ok = validateReviewResponse('{"verdict": "conditional", "grade": 6.4, "feedback": "Redelijk.", "feed_forward": "Onderbouw je keuze."}');
    expect(ok.ok).toBe(true);
    expect(ok.value).toEqual({ feedback: 'Redelijk.', feed_forward: 'Onderbouw je keuze.' });
  });

  it('de server slaat geen cijfer, oordeel of badge meer op en geeft ze niet terug', () => {
    const review = functionSource('runEvaluatorReview');
    expect(review).toMatch(/verdict: null,/);
    expect(review).toMatch(/grade: null,/);
    expect(review).not.toMatch(/project_review_badges|badge/);
    expect(routeSource("app.get('/api/projects/:projectId/groups/:groupId/feedback'")).not.toMatch(/verdict|grade|badge/);
  });

  it('"Feedback op jullie aanpak" telt als feedbackronde en respecteert het maximum', () => {
    expect(functionSource('countFeedbackRounds')).toMatch(/project_group_assessments/);
    const evaluate = routeSource("app.post('/api/projects/groups/:groupId/evaluate'");
    expect(evaluate).toContain('feedbackRoundsState(ev.max_reviews, await countFeedbackRounds(groupId, ev.id)).canSubmit');
    expect(evaluate).toContain('for (const evalPersona of withRounds)');
  });

  it('rondes: onbeperkt, of tot het maximum', () => {
    expect(feedbackRoundsState(null, 12)).toEqual({ maxReviews: null, used: 12, remaining: null, canSubmit: true });
    expect(feedbackRoundsState(3, 0)).toMatchObject({ remaining: 3, canSubmit: true });
    expect(feedbackRoundsState(3, 2)).toMatchObject({ remaining: 1, canSubmit: true });
    expect(feedbackRoundsState(3, 3)).toMatchObject({ remaining: 0, canSubmit: false });
    expect(feedbackRoundsState(3, 5)).toMatchObject({ remaining: 0, canSubmit: false });
    expect(feedbackRoundsState(0, 1).canSubmit).toBe(true); // 0/leeg = onbeperkt
  });

  it('een beoordelaar houdt nooit een verstandhouding bij, ook niet als het veld aan staat', () => {
    const fields = roleFieldsFrom({ persona_type: 'evaluator', reputation_enabled: true, max_reviews: 2, deliverable_label: 'Eindproduct' });
    expect(fields).toMatchObject({ reputation_enabled: false, max_reviews: 2, deliverable_label: 'Eindproduct' });
    expect(reputationActive({ persona_type: 'evaluator', reputation_enabled: true })).toBe(false);
  });
});
