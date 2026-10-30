// Baseline HTTP hardening for the Express app: proxy trust, CORS and a few
// safe response headers. Deliberately no Content-Security-Policy or
// X-Frame-Options yet: LEAP is opened from Canvas (possibly in an iframe) and
// the frontend loads KaTeX, pdf.js and MathLive; a CSP needs a browser test
// first (see docs/security/README.md, "Follow-up").
import cors from 'cors';

// Origins that may call the API from another origin. The app itself is served
// from the same origin as the API (and via the Vite proxy in development), so
// it never needs CORS; this list only matters for tools on another origin.
export function allowedOrigins(env = process.env) {
  const list = [env.APP_PUBLIC_URL, env.APP_BASE_URL, env.LTI_APP_URL]
    .filter(Boolean)
    .map((u) => String(u).replace(/\/+$/, ''));
  if (env.NODE_ENV !== 'production') list.push('http://localhost:5000', 'http://127.0.0.1:5000');
  return [...new Set(list)];
}

export function applyHttpSecurity(app, env = process.env) {
  app.disable('x-powered-by');
  // Azure Container Apps puts exactly one proxy (its ingress) in front of the
  // app. Trusting that one hop makes req.ip the real client address (used by
  // the rate limits) and req.protocol 'https'. Never trust more hops: then a
  // client could choose its own IP with an X-Forwarded-For header.
  app.set('trust proxy', 1);
  const origins = allowedOrigins(env);
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || origins.includes(origin)) }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });
}
