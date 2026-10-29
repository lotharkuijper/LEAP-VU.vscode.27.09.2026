import { createClient } from '@supabase/supabase-js';
import express from 'express';
import { isLeapAdmin, isStaffForCourse, requireAuthUser } from '../lib/auth.js';
import { promoteCourseTeacherProfile } from '../courses/teacherProfile.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabaseAdmin } from '../lib/supabase.js';
import {
  createPlatformRegistry,
  createRateLimiter as createLtiRateLimiter,
  loadPlatforms,
  loadToolKey,
  registerLtiRoutes,
} from './lti.js';

// Canvas-koppeling via LTI 1.3 (server/lti.js): Canvas-link per cursus, inloggen
// zonder wachtwoord, en daarna inloggen met een code per e-mail.
const ltiRegistry = createPlatformRegistry({ envPlatforms: loadPlatforms(process.env), getDb: () => supabaseAdmin });

let ltiToolKey = null;

loadToolKey(process.env).then((k) => { ltiToolKey = k; }).catch(() => {});

ltiRegistry.refresh().then(() => {
  const list = ltiRegistry.list();
  console.log(`[lti] Canvas-koppeling ${list.length ? `actief (${list.map(p => p.issuer).join(', ')})` : 'niet ingesteld (LTI_PLATFORMS of Beheer → Instellingen)'}`);
});

const ltiAppUrl = (req) => String(process.env.LTI_APP_URL || process.env.APP_PUBLIC_URL || process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

const ltiRateLimit = createLtiRateLimiter({ max: 3 });

export function registerCanvasRoutes(app) {
  registerLtiRoutes(app, express, {
    supabaseAdmin,
    registry: ltiRegistry,
    appUrl: ltiAppUrl,
    get toolKey() { return ltiToolKey; },
    requireAuthUser,
    requireAdmin: async (req, res) => {
      const a = await requireAuthUser(req, res);
      if (!a) return null;
      if (!isLeapAdmin(a.profile)) { res.status(403).json({ error: 'Alleen voor de beheerder' }); return null; }
      return a.user;
    },
    isStaffForCourse,
    promoteTeacherProfile: promoteCourseTeacherProfile,
    createAnonClient: () => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } }),
    rateLimit: (key, limit) => ltiRateLimit(key, limit),
  });
}
