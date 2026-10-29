// Bepaalt welke databasemigraties nog moeten draaien. Pure logica voor
// scripts/migrate.mjs, los getest in server/__tests__/migrationPlan.test.js.

// Migratiebestanden heten <datum[tijd]>_<naam>.sql. De meeste hebben 14 cijfers
// (datum + tijd), een paar oudere alleen de datum (8 cijfers). Gesorteerd op
// naam staan ze op datum; een bestand zonder tijd komt na die van dezelfde dag.
export function isMigrationFile(name) {
  return /^\d{8,14}_.+\.sql$/.test(name);
}

// files: bestandsnamen in supabase/migrations; applied: namen die al in de
// database als uitgevoerd staan. Geeft de nog uit te voeren bestanden in
// volgorde, plus namen die wel als uitgevoerd staan maar niet meer bestaan.
export function planMigrations(files, applied) {
  const done = new Set(applied);
  const all = files.filter(isMigrationFile).sort();
  const known = new Set(all);
  return {
    pending: all.filter((f) => !done.has(f)),
    missing: [...done].filter((f) => !known.has(f)).sort(),
  };
}

// Een database die al tabellen heeft maar nog geen administratie van
// migraties (bv. net overgezet uit Supabase) mag niet alles opnieuw uitvoeren:
// eerst vastleggen wat er al is (--baseline).
export function needsBaseline({ appliedCount, hasExistingSchema }) {
  return appliedCount === 0 && hasExistingSchema;
}
