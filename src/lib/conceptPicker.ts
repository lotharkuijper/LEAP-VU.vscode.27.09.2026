// Keuzelijst "Begrippen kiezen" in Beheer → Cursusmateriaal → 3. Begrippen (2026-10-16).
//
// Eén regel per begrip met een schakelaar zichtbaar/verborgen die meteen wordt
// opgeslagen (POST /api/admin/concepts/visibility). Wat de docent ziet, is wat
// studenten krijgen. Filters op soort (cursus/module/voorbeeld), moeilijkheid
// en status; bulkacties gelden alleen voor wat in beeld is.
//
// Studenten zien alleen begrippen met review_status 'approved' (of nog leeg,
// van vóór de kolom). 'needs_review' (bv. aangevuld om een minimum te halen)
// en 'rejected' zien ze niet.
import { classifyConceptForTeacher, getDifficultyTier, type ConceptClass, type DifficultyTier } from './conceptClassification';

export type Visibility = 'visible' | 'review' | 'hidden';

export interface PickerConcept {
  id: string;
  name: string;
  definition?: string | null;
  review_status?: string | null;
  concept_role?: string | null;
  difficulty?: string | null;
  aliases?: string[] | null;
}

export interface PickerRow {
  concept: PickerConcept;
  kind: ConceptClass;
  tier: DifficultyTier;
  visibility: Visibility;
  docs: number;
}

export interface PickerFilters {
  kind: ConceptClass | 'all';
  tier: DifficultyTier | 'all';
  status: Visibility | 'all';
  q: string;
}

export const NO_FILTERS: PickerFilters = { kind: 'all', tier: 'all', status: 'all', q: '' };
export const KIND_ORDER: ConceptClass[] = ['course', 'module', 'example'];
export const TIER_ORDER: DifficultyTier[] = ['hard', 'medium', 'easy'];
export const STATUS_ORDER: Visibility[] = ['visible', 'review', 'hidden'];

export function visibilityOf(reviewStatus: string | null | undefined): Visibility {
  if (reviewStatus == null || reviewStatus === 'approved') return 'visible';
  if (reviewStatus === 'needs_review') return 'review';
  return 'hidden';
}

/** Regels in vaste volgorde: cursus, module, voorbeeld; moeilijk → makkelijk; dan op naam. */
export function buildPickerRows(concepts: PickerConcept[], moduleCounts: Record<string, number>): PickerRow[] {
  const rows = concepts.map((c) => ({
    concept: c,
    kind: classifyConceptForTeacher(c, moduleCounts),
    tier: getDifficultyTier(c),
    visibility: visibilityOf(c.review_status),
    docs: moduleCounts[c.id] ?? 0,
  }));
  return rows.sort((a, b) =>
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
    || a.concept.name.localeCompare(b.concept.name));
}

function matchesQuery(row: PickerRow, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return row.concept.name.toLowerCase().includes(s)
    || (row.concept.aliases || []).some((a) => a.toLowerCase().includes(s));
}

export function filterRows(rows: PickerRow[], f: PickerFilters, ignore?: keyof PickerFilters): PickerRow[] {
  return rows.filter((r) =>
    (ignore === 'kind' || f.kind === 'all' || r.kind === f.kind)
    && (ignore === 'tier' || f.tier === 'all' || r.tier === f.tier)
    && (ignore === 'status' || f.status === 'all' || r.visibility === f.status)
    && (ignore === 'q' || matchesQuery(r, f.q)));
}

/** Aantallen per waarde van één filter, binnen de andere filters (voor de knoppen). */
export function countsFor<K extends 'kind' | 'tier' | 'status'>(rows: PickerRow[], f: PickerFilters, dim: K): Record<string, number> {
  const out: Record<string, number> = { all: 0 };
  const field = dim === 'status' ? 'visibility' : dim;
  for (const r of filterRows(rows, f, dim)) {
    out.all += 1;
    const v = r[field as 'kind' | 'tier' | 'visibility'];
    out[v] = (out[v] || 0) + 1;
  }
  return out;
}

export function summarize(rows: PickerRow[]): { total: number; visible: number; review: number; hidden: number } {
  const s = { total: rows.length, visible: 0, review: 0, hidden: 0 };
  for (const r of rows) s[r.visibility] += 1;
  return s;
}
