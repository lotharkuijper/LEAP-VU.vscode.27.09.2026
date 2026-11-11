// Controle van "Studenten indelen" (server/projects/projectGroups.js) tegen de
// echte database en de draaiende API (poort 3001). Maakt een tijdelijke cursus,
// een project en tijdelijke studenten aan en ruimt alles weer op.
//
//   node --env-file=.env scripts/check-project-groups.mjs
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const API = process.env.CHECK_API || 'http://localhost:3001';
const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.VITE_PUBLIC_SUPABASE_URL;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_PUBLIC_SUPABASE_ANON_KEY;
const anon = () => createClient(url, anonKey, { auth: { persistSession: false } });

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FOUT'} ${msg}`); if (!cond) failures += 1; };
const stamp = Date.now();
const PASSWORD = randomBytes(24).toString('base64url'); // alleen in het geheugen van deze run
const mail = (n) => `leap-groups-check-${n}-${stamp}@example.org`;
const created = { users: [], course: null };

async function api(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5000', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function makeUser(name) {
  const { data, error } = await admin.auth.admin.createUser({ email: mail(name), email_confirm: true, password: PASSWORD, user_metadata: { full_name: name } });
  if (error) throw new Error(`account ${name}: ${error.message}`);
  created.users.push(data.user.id);
  await admin.from('profiles').update({ full_name: `Test ${name}` }).eq('id', data.user.id);
  return data.user.id;
}

const tokenOf = async (name) => {
  const { data, error } = await anon().auth.signInWithPassword({ email: mail(name), password: PASSWORD });
  if (error) throw new Error(`inloggen ${name}: ${error.message}`);
  return data.session.access_token;
};

try {
  const { data: course, error: cErr } = await admin.from('courses').insert({ name: `Test groepen ${stamp}`, folder_name: `test-groepen-${stamp}`, is_active: true }).select('id').single();
  if (cErr) throw new Error(`cursus aanmaken: ${cErr.message}`);
  created.course = course.id;
  const { data: project, error: pErr } = await admin.from('projects').insert({
    title: `Test groepen ${stamp}`, research_question: 'Test', course_id: course.id, rubric_criteria: [],
    min_group_size: 1, max_group_size: 4, group_mode: 'teacher', allow_self_signup: false, submissions_enabled: false, status: 'draft',
  }).select('id').single();
  if (pErr) throw new Error(`project aanmaken: ${pErr.message}`);
  const base = `/api/projects/${project.id}/group-admin`;

  // Zes studenten, één docent in de cursus en één buitenstaander.
  const names = ['Anna', 'Bram', 'Cas', 'Dewi', 'Emre', 'Fleur'];
  const students = [];
  for (const n of names) students.push(await makeUser(n));
  const teacher = await makeUser('Docent');
  const outsider = await makeUser('Buiten');
  await admin.from('course_members').insert([
    ...students.map((id) => ({ course_id: course.id, user_id: id, member_role: 'student' })),
    { course_id: course.id, user_id: teacher, member_role: 'teacher' },
  ]);
  // Ingelogd als de docent van deze cursus (geen beheerder).
  const token = await tokenOf('Docent');

  // 1. Overzicht: zes studenten, niemand ingedeeld, de docent staat er niet bij.
  let r = await api('GET', base, token);
  ok(r.status === 200, `overzicht laden (${r.status} ${r.body.error || ''})`);
  ok(r.body.unassigned?.length === 6, `6 studenten nog niet ingedeeld (${r.body.unassigned?.length})`);
  ok(!r.body.unassigned?.some((p) => p.userId === teacher), 'de docent staat niet in de lijst');
  ok(r.body.unassigned?.every((p) => p.student === true), 'studenten zijn als student gemarkeerd');

  // 2. Twee studenten zelf in een nieuwe groep zetten.
  const g1 = await api('POST', `${base}/groups`, token, { name: 'Team Noord' });
  ok(g1.status === 200 && g1.body.group?.id, 'nieuwe groep "Team Noord"');
  r = await api('PUT', `${base}/members`, token, { userIds: [students[0], students[1]], groupId: g1.body.group.id });
  ok(r.status === 200 && r.body.count === 2, `Anna en Bram ingedeeld (${r.status} ${r.body.error || ''})`);

  // 3. De vier anderen willekeurig verdelen, hoogstens 3 per groep → 2 groepen van 2.
  r = await api('GET', base, token);
  const rest = r.body.unassigned.map((p) => p.userId);
  ok(rest.length === 4, `nog 4 over (${rest.length})`);
  r = await api('POST', `${base}/auto`, token, { size: 3, userIds: rest });
  ok(r.status === 200 && r.body.groups === 2, `willekeurig verdeeld over 2 groepen (${r.body.groups})`);
  r = await api('GET', base, token);
  ok(r.body.unassigned.length === 0, 'iedereen is ingedeeld');
  const sizes = r.body.groups.map((g) => g.members.length).sort();
  ok(JSON.stringify(sizes) === JSON.stringify([2, 2, 2]), `groepsgroottes 2, 2, 2 (${sizes})`);

  // 4. Verplaatsen en uit de groep halen.
  const other = r.body.groups.find((g) => g.id !== g1.body.group.id);
  r = await api('PUT', `${base}/members`, token, { userIds: [students[0]], groupId: other.id });
  ok(r.status === 200, 'Anna verplaatst naar een andere groep');
  r = await api('PUT', `${base}/members`, token, { userIds: [students[1]], groupId: null });
  ok(r.status === 200, 'Bram uit de groep gehaald');
  r = await api('GET', base, token);
  ok(r.body.groups.find((g) => g.id === other.id).members.some((m) => m.userId === students[0]), 'Anna zit in de nieuwe groep');
  ok(!r.body.groups.find((g) => g.id === g1.body.group.id).members.some((m) => m.userId === students[0]), 'en niet meer in Team Noord');
  ok(r.body.unassigned.some((p) => p.userId === students[1]), 'Bram staat weer bij nog niet ingedeeld');

  // 5. Grenzen: geen docent, geen buitenstaander, niet in de testgroep van een docent.
  r = await api('PUT', `${base}/members`, token, { userIds: [teacher], groupId: other.id });
  ok(r.status === 403, `een docent kan niet in een studentengroep (${r.status})`);
  r = await api('PUT', `${base}/members`, token, { userIds: [students[1], outsider], groupId: other.id });
  ok(r.status === 400, `iemand buiten de cursus wordt geweigerd, ook in een mengselectie (${r.status})`);
  r = await api('GET', base, token);
  ok(r.body.unassigned.some((p) => p.userId === students[1]), 'en dan is ook Bram niet ingedeeld (alles of niets)');
  // De docent probeert het project uit in een eigen groep van één, ook nu het
  // project open is voor studenten en de docent indeelt.
  await admin.from('projects').update({ status: 'active' }).eq('id', project.id);
  let ov = await api('GET', '/api/projects/student-overview', token);
  const ovT = ov.body.courses?.find((c) => c.course.id === course.id)?.projects.find((p) => p.id === project.id);
  ok(ovT?.tryout === true, `de docent ziet "uitproberen" bij een open project (${ovT?.tryout})`);
  ov = await api('GET', '/api/projects/student-overview', await tokenOf('Cas'));
  const ovS = ov.body.courses?.find((c) => c.course.id === course.id)?.projects.find((p) => p.id === project.id);
  ok(ovS && !ovS.tryout, `een student niet (${ovS?.tryout})`);
  const tg = await api('POST', '/api/projects/groups', token, { projectId: project.id });
  ok(tg.status === 200 && tg.body.group?.id, `de docent start zijn eigen testgroep (${tg.status} ${tg.body.error || ''})`);
  ok(/^Testgroep van /.test(tg.body.group?.name || ''), `naam "${tg.body.group?.name}"`);
  r = await api('GET', `/api/projects/${project.id}/room?groupId=${tg.body.group?.id}`, token);
  ok(r.status === 200 && r.body.members?.length === 1 && !!r.body.members[0].profiles, `projectruimte: 1 lid met naam (${r.status} ${r.body.members?.length})`);
  r = await api('POST', '/api/projects/groups', await tokenOf('Cas'), { projectId: project.id });
  ok(r.status === 403, `een student start zelf geen groep als de docent indeelt (${r.status})`);
  r = await api('POST', '/api/projects/groups/join', await tokenOf('Cas'), { inviteCode: tg.body.group.invite_code });
  ok(r.status === 403 || r.status === 400, `een student komt niet met de code in de testgroep (${r.status})`);
  r = await api('GET', base, token);
  const tgRow = r.body.groups.find((g) => g.id === tg.body.group.id);
  ok(tgRow?.teacherGroup === true && tgRow.members.length === 1, 'testgroep: herkenbaar en alleen de docent erin');
  r = await api('PUT', `${base}/members`, token, { userIds: [students[1]], groupId: tg.body.group.id });
  ok(r.status === 403 && r.body.code === 'teacherGroup', `student kan niet in de testgroep van een docent (${r.status})`);
  r = await api('PUT', `${base}/members`, token, { userIds: [], groupId: other.id });
  ok(r.status === 400, `lege selectie geweigerd (${r.status})`);

  // 6. Zonder inlog of als student: geen toegang.
  r = await api('GET', base, null);
  ok(r.status === 401, `zonder inlog geen toegang (${r.status})`);
  r = await api('PUT', `${base}/members`, await tokenOf('Cas'), { userIds: [students[1]], groupId: other.id });
  ok(r.status === 403, `een student kan niet indelen (${r.status})`);
  r = await api('GET', base, await tokenOf('Buiten'));
  ok(r.status === 403, `iemand buiten de cursus ziet de indeling niet (${r.status})`);
} catch (e) {
  failures += 1;
  console.error('FOUT', e.message);
} finally {
  if (created.course) {
    await admin.from('projects').delete().eq('course_id', created.course);
    await admin.from('courses').delete().eq('id', created.course);
  }
  for (const id of created.users) await admin.auth.admin.deleteUser(id).catch(() => {});
  const { count } = await admin.from('profiles').select('id', { count: 'exact', head: true }).like('email', `leap-groups-check-%-${stamp}@example.org`);
  console.log(`opgeruimd (achtergebleven testaccounts: ${count ?? '?'})`);
}
console.log(failures ? `\n${failures} fout(en)` : '\nalles in orde');
process.exit(failures ? 1 : 0);
