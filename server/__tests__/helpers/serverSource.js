// Helpers for "source guard" tests: tests that check the server code itself
// (e.g. "this route checks the course switch before it writes").
//
// They look a route or helper up by parsing the code, wherever it lives, so a
// guard keeps working when code moves to another file. Never slice between two
// hand-picked markers: that silently checks the wrong code after a move.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = path.resolve(SERVER_DIR, '..');

const read = (abs) => fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');

/** All server modules (repo-relative paths), tests excluded. */
export function serverFiles() {
  return fs.readdirSync(SERVER_DIR, { recursive: true })
    .filter((f) => f.endsWith('.js') && !f.split(path.sep).includes('__tests__'))
    .map((f) => path.join('server', f).split(path.sep).join('/'))
    .sort();
}

/** One file, by repo-relative path (e.g. 'server/chat/routes.js'). */
export function fileSource(rel) {
  return read(path.join(ROOT, rel));
}

let allCache = null;
/** The whole server code base as one string, for "does X occur anywhere" checks. */
export function allServerSource() {
  if (!allCache) allCache = serverFiles().map((f) => `// ==== ${f}\n${fileSource(f)}`).join('\n');
  return allCache;
}

const astCache = new Map();
function parse(rel) {
  if (!astCache.has(rel)) {
    const src = fileSource(rel);
    astCache.set(rel, { src, ast: acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' }) });
  }
  return astCache.get(rel);
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit));
    else if (v && typeof v.type === 'string') walk(v, visit);
  }
}

function findAll(predicate) {
  const hits = [];
  for (const rel of serverFiles()) {
    const { src, ast } = parse(rel);
    walk(ast, (n) => { if (predicate(n, src)) hits.push({ file: rel, text: src.slice(n.start, n.end) }); });
  }
  return hits;
}

/**
 * Full source of a route registration, found by how it starts, e.g.
 * routeSource("app.post('/api/chat',") or routeSource("app.get('/api/journal'").
 * Throws when it is not found exactly once, so a guard can never pass vacuously.
 */
export function routeSource(signature) {
  const hits = findAll((n, src) => n.type === 'CallExpression'
    && n.callee.type === 'MemberExpression'
    && src.startsWith(signature, n.start));
  if (hits.length !== 1) throw new Error(`routeSource: expected 1 match for ${signature}, found ${hits.length}`);
  return hits[0].text;
}

/** Full source of a named function (declaration or `const name = (…) =>`). */
export function functionSource(name) {
  const hits = findAll((n) => (n.type === 'FunctionDeclaration' && n.id?.name === name)
    || (n.type === 'VariableDeclarator' && n.id?.name === name
      && /Function/.test(n.init?.type || '')));
  if (hits.length !== 1) throw new Error(`functionSource: expected 1 match for ${name}, found ${hits.length}`);
  return hits[0].text;
}

/** Repo-relative path of the file that registers a route (see routeSource). */
export function routeFile(signature) {
  const hits = findAll((n, src) => n.type === 'CallExpression'
    && n.callee.type === 'MemberExpression'
    && src.startsWith(signature, n.start));
  if (hits.length !== 1) throw new Error(`routeFile: expected 1 match for ${signature}, found ${hits.length}`);
  return hits[0].file;
}
