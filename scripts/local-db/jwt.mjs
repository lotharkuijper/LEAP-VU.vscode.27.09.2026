// Signs an HS256 JWT with the LOCAL-ONLY throwaway secret from lib.sh (setup.sh
// passes it as JWT_SECRET). Only used to give the one-shot storage-api container
// its anon/service keys. Usage: JWT_SECRET=... node jwt.mjs <role> [sub]
import crypto from 'node:crypto';
const secret = process.env.JWT_SECRET;
if (!secret) { console.error('jwt.mjs: JWT_SECRET ontbreekt'); process.exit(1); }
const [role = 'anon', sub] = process.argv.slice(2);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const payload = { role, iss: 'leap-localdb', iat: 1700000000, exp: 4100000000, ...(sub ? { sub, aud: 'authenticated' } : {}) };
const head = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(payload);
console.log(head + '.' + crypto.createHmac('sha256', secret).update(head).digest('base64url'));
