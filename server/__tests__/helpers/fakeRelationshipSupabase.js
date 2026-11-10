// In-memory Supabase voor de verstandhoudings-tests: ondersteunt precies de
// chains die server/projects/relationshipAdjust.js, server/projects/threadClose.js en
// server/projects/reputationBadge.js gebruiken.
// `state` bevat de rijen; tests passen die per geval aan.
export function makeFakeRelationshipSupabase(state) {
  let nextId = 1;
  const single = (key) => ({
    select() {
      const chain = { eq() { return chain; }, async maybeSingle() { return { data: state[key] ?? null, error: null }; } };
      return chain;
    },
  });
  const matches = (r, filters) => Object.entries(filters).every(([k, v]) => r[k] === v);
  const relationships = () => ({
    select() {
      const filters = {};
      const chain = {
        eq(col, val) { filters[col] = val; return chain; },
        async maybeSingle() {
          const found = state.relationships.find(r => matches(r, filters));
          return { data: found ? structuredClone(found) : null, error: null };
        },
      };
      return chain;
    },
    update(patch) {
      const filters = {};
      const chain = {
        eq(col, val) { filters[col] = val; return chain; },
        select() {
          return {
            async single() {
              const idx = state.relationships.findIndex(r => matches(r, filters));
              if (idx === -1) return { data: null, error: { message: 'not found' } };
              state.relationships[idx] = { ...state.relationships[idx], ...patch };
              return { data: structuredClone(state.relationships[idx]), error: null };
            },
          };
        },
      };
      return chain;
    },
    insert(row) {
      return {
        select() {
          return {
            async single() {
              const newRow = { id: `rel-${nextId++}`, score: 0, history: [], updated_at: new Date().toISOString(), ...row };
              state.relationships.push(newRow);
              return { data: structuredClone(newRow), error: null };
            },
          };
        },
      };
    },
  });
  // Groepsleden (state.members: [{ group_id, user_id }]) en prestaties (state.achievements).
  const members = () => ({
    select() {
      return { async eq(col, val) { return { data: (state.members || []).filter(m => m[col] === val), error: null }; } };
    },
  });
  const achievements = () => ({
    select() {
      const filters = {};
      const chain = {
        eq(col, val) { filters[col] = val; return chain; },
        async in(col, vals) {
          const rows = (state.achievements || []).filter(r => matches(r, filters) && vals.includes(r[col]));
          return { data: structuredClone(rows), error: null };
        },
      };
      return chain;
    },
    // Eén rij per aanroep; dubbel (zelfde student, soort en onderwerp) = 23505, zoals de unieke index.
    async insert(row) {
      const list = state.achievements || (state.achievements = []);
      if (list.some(r => r.user_id === row.user_id && r.kind === row.kind && r.topic_key === row.topic_key && r.level == null && row.level == null)) {
        return { error: { code: '23505', message: 'duplicate' } };
      }
      list.push(structuredClone(row));
      return { error: null };
    },
  });
  return {
    from(table) {
      switch (table) {
        case 'projects': return single('project');
        case 'profiles': return single('profile');
        case 'project_groups': return single('group');
        case 'project_personas': return single('persona');
        case 'project_persona_relationships': return relationships();
        case 'project_group_members': return members();
        case 'student_achievements': return achievements();
        default: throw new Error(`fake supabase: unsupported table ${table}`);
      }
    },
  };
}
