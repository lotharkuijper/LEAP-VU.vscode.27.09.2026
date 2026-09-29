// Niveaus van de verstandhouding met een rolspeler (zie server/personaRelationship.js).
// -3 = contact verbroken, -2 koud … +2 warm. Klassen staan hier letterlijk
// zodat Tailwind ze vindt.
export type RelationshipKey = 'broken' | 'cold' | 'strained' | 'neutral' | 'positive' | 'warm';

export const RELATIONSHIP_LEVELS: Array<{ level: number; key: RelationshipKey }> = [
  { level: 2, key: 'warm' },
  { level: 1, key: 'positive' },
  { level: 0, key: 'neutral' },
  { level: -1, key: 'strained' },
  { level: -2, key: 'cold' },
  { level: -3, key: 'broken' },
];

export const RELATIONSHIP_BADGE: Record<RelationshipKey, { chip: string; dot: string; text: string }> = {
  warm:     { chip: 'bg-rose-50 text-rose-700 border-rose-200',       dot: 'bg-rose-500',    text: 'text-rose-700' },
  positive: { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500', text: 'text-emerald-700' },
  neutral:  { chip: 'bg-gray-50 text-gray-600 border-gray-200',       dot: 'bg-gray-400',    text: 'text-gray-600' },
  strained: { chip: 'bg-amber-50 text-amber-700 border-amber-200',    dot: 'bg-amber-500',   text: 'text-amber-700' },
  cold:     { chip: 'bg-sky-50 text-sky-800 border-sky-200',          dot: 'bg-sky-600',     text: 'text-sky-800' },
  broken:   { chip: 'bg-red-50 text-red-700 border-red-200',          dot: 'bg-red-600',     text: 'text-red-700' },
};
