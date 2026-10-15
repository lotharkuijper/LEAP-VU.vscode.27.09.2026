import { describe, it, expect } from 'vitest';
import { pickReusableRagFolder, ensureCourseRagFolderWith } from '../ragFolder.js';

describe('pickReusableRagFolder', () => {
  const courseA = 'course-a';
  const courseB = 'course-b';

  it('hergebruikt een niet-gekoppelde naam-match', () => {
    const id = pickReusableRagFolder({
      folders: [{ id: 'f1' }],
      assignmentsByFolderId: { f1: [] },
      courseId: courseA,
    });
    expect(id).toBe('f1');
  });

  it('hergebruikt een map die alleen aan déze cursus hangt', () => {
    const id = pickReusableRagFolder({
      folders: [{ id: 'f1' }],
      assignmentsByFolderId: { f1: [courseA] },
      courseId: courseA,
    });
    expect(id).toBe('f1');
  });

  it('weigert (security) een naam-match die aan een ándere cursus hangt', () => {
    // Kern van Task #334: docent van cursus A mag een map van cursus B niet
    // laten hergebruiken/koppelen via een botsende of gemanipuleerde naam.
    const id = pickReusableRagFolder({
      folders: [{ id: 'fB' }],
      assignmentsByFolderId: { fB: [courseB] },
      courseId: courseA,
    });
    expect(id).toBeNull();
  });

  it('slaat een map over die (ook) aan een andere cursus hangt en pakt een veilige', () => {
    const id = pickReusableRagFolder({
      folders: [{ id: 'fShared' }, { id: 'fFree' }],
      assignmentsByFolderId: { fShared: [courseB, courseA], fFree: [] },
      courseId: courseA,
    });
    // fShared hangt óók aan B → niet veilig; fFree is vrij → die wint.
    expect(id).toBe('fFree');
  });

  it('geeft null bij geen kandidaten of ontbrekende courseId', () => {
    expect(pickReusableRagFolder({ folders: [], assignmentsByFolderId: {}, courseId: courseA })).toBeNull();
    expect(pickReusableRagFolder({ folders: [{ id: 'f1' }], assignmentsByFolderId: { f1: [] }, courseId: '' })).toBeNull();
  });
});

// ── ensureCourseRagFolderWith: een haperende database mag nooit een dubbele ──
// RAG-map of koppeling opleveren (Task #399; voorheen getest via de route
// create-rag-folder, die met de klassieke weergave is verdwenen).

/** Minimale nep-database: tabellen in het geheugen, en fouten op aanvraag. */
function fakeDb(tables, failOn = () => false) {
  const db = { tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map(r => ({ ...r }))])) };
  let n = 1;
  db.from = (table) => {
    const filters = [];
    let op = 'select';
    let payload = null;
    const rows = () => (db.tables[table] ||= []);
    const matches = (r) => filters.every(f => (f.kind === 'in' ? f.val.includes(r[f.col]) : r[f.col] === f.val));
    const run = () => {
      if (failOn({ table, op, filters })) return { data: null, error: { message: 'transient timeout' } };
      if (op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map(r => ({ id: `id-${n++}`, ...r }));
        rows().push(...list);
        return { data: Array.isArray(payload) ? list : list[0], error: null };
      }
      return { data: rows().filter(matches), error: null };
    };
    const q = {
      select() { return q; },
      eq(col, val) { filters.push({ col, val }); return q; },
      in(col, val) { filters.push({ col, val, kind: 'in' }); return q; },
      limit() { return q; },
      insert(p) { op = 'insert'; payload = p; return q; },
      maybeSingle: async () => { const r = run(); return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }; },
      single: async () => { const r = run(); return { ...r, data: Array.isArray(r.data) ? r.data[0] : r.data }; },
      then: (ok, bad) => Promise.resolve(run()).then(ok, bad),
    };
    return q;
  };
  return db;
}

describe('ensureCourseRagFolderWith', () => {
  const empty = () => ({ course_folder_assignments: [], document_folders: [], folder_permissions: [] });

  it('maakt één map met koppeling, en hergebruikt die daarna', async () => {
    const db = fakeDb(empty());
    const first = await ensureCourseRagFolderWith(db, 'c1', 'Statistiek', 'u1');
    expect(first.created).toBe(true);
    const again = await ensureCourseRagFolderWith(db, 'c1', 'Statistiek', 'u1');
    expect(again).toEqual({ folderId: first.folderId, created: false });
    expect(db.tables.document_folders).toHaveLength(1);
    expect(db.tables.course_folder_assignments).toHaveLength(1);
  });

  it('eerste cursuskoppeling-lookup faalt → fout, geen map/koppeling', async () => {
    const db = fakeDb(empty(), ({ table, op }) => table === 'course_folder_assignments' && op === 'select');
    await expect(ensureCourseRagFolderWith(db, 'c1', 'Statistiek', 'u1')).rejects.toThrow(/cursuskoppelingen niet opzoeken/i);
    expect(db.tables.document_folders).toHaveLength(0);
    expect(db.tables.course_folder_assignments).toHaveLength(0);
  });

  it('gekoppelde-RAG-map-lookup faalt → fout, geen nieuwe map/koppeling', async () => {
    const db = fakeDb(
      { ...empty(), course_folder_assignments: [{ id: 'a1', course_id: 'c1', folder_id: 'f-old' }] },
      ({ table, op }) => table === 'document_folders' && op === 'select',
    );
    await expect(ensureCourseRagFolderWith(db, 'c1', 'Statistiek', 'u1')).rejects.toThrow(/gekoppelde RAG-map niet opzoeken/i);
    expect(db.tables.document_folders).toHaveLength(0);
    expect(db.tables.course_folder_assignments).toHaveLength(1);
  });

  it('bestaande-koppeling-lookup faalt → fout, geen koppeling aangemaakt', async () => {
    const db = fakeDb(empty(), ({ table, op, filters }) =>
      table === 'course_folder_assignments' && op === 'select' && filters.some(f => f.col === 'folder_id'));
    await expect(ensureCourseRagFolderWith(db, 'c1', 'Statistiek', 'u1')).rejects.toThrow(/bestaande koppeling niet opzoeken/i);
    expect(db.tables.course_folder_assignments).toHaveLength(0);
  });
});