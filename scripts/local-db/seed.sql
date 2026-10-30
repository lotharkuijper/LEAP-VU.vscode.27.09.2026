-- Small fixed fixture for RLS tests. Run as postgres (outside any as-user block).
-- Idempotent. Fixed ids so tests can refer to them.
--   admin    ...a001  (role admin)
--   teacher  ...b001  (profile docent, course_members.member_role teacher in Course A)
--   student1 ...c001  (member of Course A)
--   student2 ...c002  (member of Course B only)
--   outsider ...d001  (no memberships)
-- Password for all of them: test1234 (LOCAL-ONLY throwaway, fixture data).
-- NB: the signup trigger on auth.users creates the profile (first ever user => admin).
begin;
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id::uuid, 'authenticated', 'authenticated', email,
       extensions.crypt('test1234', extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}', json_build_object('full_name', name)::jsonb, now(), now()
from (values
  ('00000000-0000-0000-0000-00000000a001', 'admin@leap.local',    'Admin Local'),
  ('00000000-0000-0000-0000-00000000b001', 'teacher@leap.local',  'Teacher A'),
  ('00000000-0000-0000-0000-00000000c001', 'student1@leap.local', 'Student One'),
  ('00000000-0000-0000-0000-00000000c002', 'student2@leap.local', 'Student Two'),
  ('00000000-0000-0000-0000-00000000d001', 'outsider@leap.local', 'Out Sider')
) v(id, email, name)
on conflict (id) do nothing;

update public.profiles set role = case id
    when '00000000-0000-0000-0000-00000000a001' then 'admin'
    when '00000000-0000-0000-0000-00000000b001' then 'docent'
    else 'student' end
  where id in ('00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-00000000b001',
               '00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-00000000c002',
               '00000000-0000-0000-0000-00000000d001');

insert into public.courses (id, name, description) values
  ('00000000-0000-0000-0000-0000000c0a01', 'Course A (local)', 'RLS fixture'),
  ('00000000-0000-0000-0000-0000000c0b01', 'Course B (local)', 'RLS fixture')
on conflict (id) do nothing;

insert into public.course_members (course_id, user_id, role, member_role) values
  ('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-00000000b001', 'teacher', 'teacher'),
  ('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-00000000c001', 'student', 'student'),
  ('00000000-0000-0000-0000-0000000c0b01', '00000000-0000-0000-0000-00000000c002', 'student', 'student')
on conflict (course_id, user_id) do nothing;
commit;
