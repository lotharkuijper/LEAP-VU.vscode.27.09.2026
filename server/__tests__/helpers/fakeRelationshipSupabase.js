// In-memory Supabase voor de verstandhoudings-tests: ondersteunt precies de
// chains die server/relationshipAdjust.js en server/threadClose.js gebruiken.
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
  return {
    from(table) {
      switch (table) {
        case 'projects': return single('project');
        case 'profiles': return single('profile');
        case 'project_groups': return single('group');
        case 'project_personas': return single('persona');
        case 'project_persona_relationships': return relationships();
        default: throw new Error(`fake supabase: unsupported table ${table}`);
      }
    },
  };
}
