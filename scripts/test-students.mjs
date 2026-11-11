// Teststudenten in een cursus, om indelen en groepen in de app te kunnen zien.
// Accounts op @example.org (er gaat geen mail uit), herkenbaar aan "Teststudent".
//
//   node --env-file=.env scripts/test-students.mjs add "<cursusnaam>" [aantal]
//   node --env-file=.env scripts/test-students.mjs remove "<cursusnaam>"
//
// remove haalt de teststudenten van die cursus weg, met hun groepslidmaatschap.
// Let op: lokaal en live delen één database. Gebruik dit alleen voor een
// testcursus; echte studenten zien deze accounts niet, maar docenten van die
// cursus wel (als leden).
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const [cmd, courseName, countArg] = process.argv.slice(2);
const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const NAMES = ['Anna', 'Bram', 'Cas', 'Dewi', 'Emre', 'Fleur', 'Gijs', 'Hira', 'Ivo', 'Jade', 'Kees', 'Lina'];
const PREFIX = 'leap-teststudent-';

if (!['add', 'remove'].includes(cmd) || !courseName) {
  console.log('Gebruik: add|remove "<cursusnaam>" [aantal]');
  process.exit(1);
}
const { data: courses } = await admin.from('courses').select('id, name').eq('name', courseName);
if (!courses?.length) { console.log(`Cursus "${courseName}" niet gevonden`); process.exit(1); }
if (courses.length > 1) { console.log(`Meer cursussen heten "${courseName}"`); process.exit(1); }
const course = courses[0];
const slug = course.id.slice(0, 8);
const mail = (n) => `${PREFIX}${n.toLowerCase()}-${slug}@example.org`;

if (cmd === 'add') {
  const n = Math.min(NAMES.length, Math.max(1, Number(countArg) || 8));
  for (const name of NAMES.slice(0, n)) {
    let id = (await admin.from('profiles').select('id').eq('email', mail(name)).maybeSingle()).data?.id;
    if (id) {
      // Alleen een account hergebruiken dat dit script zelf heeft gemaakt.
      const { data: au } = await admin.auth.admin.getUserById(id);
      if (!au?.user?.app_metadata?.leap_test_student) { console.log(`OVERGESLAGEN ${mail(name)}: bestaand account, niet door dit script gemaakt`); continue; }
    } else {
      // Willekeurig wachtwoord dat nergens wordt bewaard: met deze accounts logt niemand in.
      const { data, error } = await admin.auth.admin.createUser({
        email: mail(name), email_confirm: true, password: randomBytes(24).toString('base64url'),
        user_metadata: { full_name: `Teststudent ${name}` }, app_metadata: { leap_test_student: true },
      });
      if (error) { console.log(`FOUT ${name}: ${error.message}`); continue; }
      id = data.user.id;
    }
    await admin.from('profiles').update({ full_name: `Teststudent ${name}` }).eq('id', id);
    const { error } = await admin.from('course_members').upsert({ course_id: course.id, user_id: id, member_role: 'student' }, { onConflict: 'course_id,user_id' });
    console.log(error ? `FOUT ${name}: ${error.message}` : `+ Teststudent ${name} (${mail(name)})`);
  }
} else {
  const { data: profs } = await admin.from('profiles').select('id, email').like('email', `${PREFIX}%-${slug}@example.org`);
  for (const p of profs || []) {
    const { data: au } = await admin.auth.admin.getUserById(p.id);
    if (!au?.user?.app_metadata?.leap_test_student) { console.log(`OVERGESLAGEN ${p.email}: niet door dit script gemaakt`); continue; }
    await admin.from('project_group_members').delete().eq('user_id', p.id);
    await admin.from('student_project_sessions').delete().eq('student_id', p.id);
    await admin.from('course_members').delete().eq('user_id', p.id);
    const { error } = await admin.auth.admin.deleteUser(p.id);
    console.log(error ? `FOUT ${p.email}: ${error.message}` : `- ${p.email}`);
  }
  console.log(`${(profs || []).length} teststudenten verwijderd`);
}
