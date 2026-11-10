// Pure helpers voor Task #166 (document-reviews). Geen DB-calls hier zodat
// vitest ze direct kan testen zonder Supabase-mock.

// Feedback van een beoordelaar is zuiver formatief (besluit 2026-11-10): geen
// cijfer, geen oordeel en geen badge. Alleen waar de groep staat en wat de
// volgende stap is, zodat er niets 'groen te krijgen' valt.
//
// Normaliseer/valideer wat de LLM teruggeeft. Verwacht {feedback, feed_forward?};
// 'reasoning' wordt ook geaccepteerd (zo heet het veld in de database). Een
// cijfer of oordeel in het antwoord wordt genegeerd. Geeft `{ ok, value, error }`.
export function validateReviewResponse(raw) {
  let obj = raw;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); }
    catch (e) { return { ok: false, error: `Ongeldige JSON: ${e.message}` }; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'Antwoord is geen object' };
  }
  const pick = (v) => (typeof v === 'string' ? v.trim() : '');
  const feedback = pick(obj.feedback) || pick(obj.reasoning);
  if (feedback.length === 0) {
    return { ok: false, error: 'feedback mag niet leeg zijn' };
  }
  return { ok: true, value: { feedback, feed_forward: pick(obj.feed_forward) } };
}

// Feedbackrondes van een groep bij een beoordelaar. maxReviews null = onbeperkt.
// Een ronde telt pas als er echt een oordeel is (mislukt = niet verbruikt).
export function feedbackRoundsState(maxReviews, used) {
  const max = Number.isFinite(Number(maxReviews)) && Number(maxReviews) > 0 ? Math.floor(Number(maxReviews)) : null;
  const u = Math.max(0, Math.floor(Number(used) || 0));
  return {
    maxReviews: max,
    used: u,
    remaining: max === null ? null : Math.max(0, max - u),
    canSubmit: max === null || u < max,
  };
}
