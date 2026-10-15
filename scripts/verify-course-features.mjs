// Controle in de echte database (alles in één transactie die wordt
// teruggedraaid): onderdelen per cursus (migratie 20261015100000_course_features).
// Zet in een cursus quiz, chat en dagboek uit en kijkt of een student dan geen
// quizpoging, gesprek of dagboekregel kan aanmaken, en een docent wel.
// Gebruik: node scripts/verify-course-features.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'OK  ' : 'FOUT'} ${name}${extra ? ` (${extra})` : ''}`);

async function asUser(userId, fn) {
  await client.query('SAVEPOINT s');
  await client.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`,
    [JSON.stringify({ sub: userId, role: 'authenticated' })]);
  try {
    await fn();
    await client.query('RESET ROLE');
    await client.query('RELEASE SAVEPOINT s');
    return null;
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT s');
    await client.query('RESET ROLE');
    return e;
  }
}

try {
  await client.query('BEGIN');
  const { rows: [course] } = await client.query(
    `SELECT id, name FROM courses WHERE is_active AND student_visible ORDER BY created_at LIMIT 1`);
  const { rows: [student] } = await client.query(
    `SELECT p.id FROM profiles p WHERE p.role = 'student'
       AND NOT EXISTS (SELECT 1 FROM course_members cm WHERE cm.user_id = p.id AND cm.course_id = $1 AND cm.member_role = 'teacher') LIMIT 1`, [course.id]);
  const { rows: [teacher] } = await client.query(
    `SELECT cm.user_id AS id FROM course_members cm JOIN profiles p ON p.id = cm.user_id
      WHERE cm.course_id = $1 AND cm.member_role = 'teacher' AND p.role <> 'admin' LIMIT 1`, [course.id]);
  console.log(`cursus: ${course.name}; student: ${!!student}; docent: ${!!teacher}`);

  // Alles aan: student mag een gesprek en dagboekregel maken.
  let err = await asUser(student.id, () => client.query(
    `INSERT INTO conversations (user_id, title, course_id) VALUES ($1, 'test', $2)`, [student.id, course.id]));
  check('alles aan: student maakt gesprek', !err, err?.message);

  await client.query(`UPDATE courses SET features = '{"chat": false, "quiz": false, "journal": false}' WHERE id = $1`, [course.id]);

  err = await asUser(student.id, () => client.query(
    `INSERT INTO conversations (user_id, title, course_id) VALUES ($1, 'test', $2)`, [student.id, course.id]));
  check('chat uit: student geweigerd', !!err && /row-level security/i.test(err.message), err?.message);

  err = await asUser(student.id, () => client.query(
    `INSERT INTO learning_journal_entries (user_id, title, content, course_id) VALUES ($1, 't', 'x', $2)`, [student.id, course.id]));
  check('dagboek uit: student geweigerd', !!err && /row-level security/i.test(err.message), err?.message);

  err = await asUser(student.id, () => client.query(
    `INSERT INTO quiz_attempts (student_id, course_id, score, total_questions) VALUES ($1, $2, 0, 1)`, [student.id, course.id]));
  check('quiz uit: student geweigerd', !!err && /row-level security|violates|null value/i.test(err.message), err?.message);

  err = await asUser(student.id, () => client.query(
    `INSERT INTO conversations (user_id, title, course_id) VALUES ($1, 'test', NULL)`, [student.id]));
  check('zonder cursus: gesprek blijft mogelijk', !err, err?.message);

  if (teacher) {
    err = await asUser(teacher.id, () => client.query(
      `INSERT INTO conversations (user_id, title, course_id) VALUES ($1, 'test', $2)`, [teacher.id, course.id]));
    check('chat uit: docent van de cursus mag wel', !err, err?.message);
  }

  const { rows: [fn] } = await client.query(`SELECT to_regclass('public.project_group_assessments') AS t`);
  check('tabel project_group_assessments bestaat', !!fn.t);
} finally {
  await client.query('ROLLBACK');
  await client.end();
}
console.log(results.join('\n'));
console.log('(alles teruggedraaid)');
