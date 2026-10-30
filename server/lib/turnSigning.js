import { createHmac } from 'node:crypto';

// Ondertekening van echte tutorbeurten (zie server/chat/readiness.js). Eigen geheim
// via LEAP_TURN_SECRET, anders afgeleid van de service-role-sleutel.
export const TURN_SECRET = process.env.LEAP_TURN_SECRET
  || createHmac('sha256', String(process.env.SUPABASE_SERVICE_ROLE_KEY || 'leap-dev')).update('leap-turn-v1').digest('hex');

export const turnHmac = (text) => createHmac('sha256', TURN_SECRET).update(text).digest('base64url');
