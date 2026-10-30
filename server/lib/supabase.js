import { createClient } from '@supabase/supabase-js';
import pkg from 'pg';

const { Pool } = pkg;

export let pgPool = null;

if (process.env.SUPABASE_DB_URL) {
  pgPool = new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  pgPool.on('error', (err) => console.error('[pgPool] client error', err.message));
}

export const SUPABASE_URL = process.env.VITE_PUBLIC_SUPABASE_URL;

export const SUPABASE_ANON_KEY = process.env.VITE_PUBLIC_SUPABASE_ANON_KEY;

const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const SUPERUSER_EMAIL = 'l.d.j.kuijper@vu.nl';

export let supabaseAdmin = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  console.log('[API Server] Supabase admin client initialized (service role)');
} else {
  console.warn('[API Server] SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL missing — admin routes disabled');
}
