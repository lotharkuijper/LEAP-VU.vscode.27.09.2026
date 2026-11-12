-- RLS checks for 20261112200000_quiz_sessions.sql. The server keeps the answer
-- key of a quiz in quiz_sessions and checks every answer; nobody else reads or
-- writes these tables (no policies). A student no longer inserts quiz attempts
-- directly: the server does that when the quiz is finished.
-- Runs as postgres on the seed.sql fixture, all in one rolled-back transaction
-- (test.sh fails on any line starting with FAIL).
\set ON_ERROR_STOP on
begin;
insert into public.quiz_sessions (id, user_id, course_id, difficulty, question_type, questions) values
  ('00000000-0000-0000-0000-0000000a5e01', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000c0a01',
   'medium', 'mcq', '[{"type":"mcq","question":"Q","options":["a","b","c","d"],"correctAnswer":2,"explanation":"GEHEIM"}]');
insert into public.quiz_session_answers (session_id, question_index, answer) values
  ('00000000-0000-0000-0000-0000000a5e01', 0, '{"type":"mcq","selectedIndex":2,"isCorrect":true}');

create temp table results(check_name text, ok boolean);
grant all on results to authenticated;

create or replace function pg_temp.as_user(uid uuid, email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', email)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.denied(stmt text) returns boolean language plpgsql as $$
begin
  execute stmt;
  return false;
exception when insufficient_privilege then
  return true;
end $$;

-- 1. the student who owns the quiz cannot read the answer key or write answers
select pg_temp.as_user('00000000-0000-0000-0000-00000000c001', 'student1@leap.local');
insert into results select 'student cannot read own quiz session (answer key stays on the server)',
  pg_temp.denied('select * from public.quiz_sessions');
insert into results select 'student cannot write an answer directly',
  pg_temp.denied($q$insert into public.quiz_session_answers (session_id, question_index, answer) values ('00000000-0000-0000-0000-0000000a5e01', 1, '{}')$q$);
insert into results select 'student cannot insert a quiz attempt directly',
  pg_temp.denied($q$insert into public.quiz_attempts (student_id, course_id, topics, difficulty, question_type, questions_data, answers, score, total_questions, score_percentage)
                    values ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000c0a01', '{}', 'medium', 'mcq', '[]', '[]', 0, 0, 100)$q$)
  or not exists (select 1 from public.quiz_attempts where student_id = '00000000-0000-0000-0000-00000000c001' and score_percentage = 100);
reset role;

-- 2. the course teacher cannot read it either (teachers never see learning data)
select pg_temp.as_user('00000000-0000-0000-0000-00000000b001', 'teacher@leap.local');
insert into results select 'teacher cannot read quiz sessions', pg_temp.denied('select * from public.quiz_sessions');
reset role;

select (case when ok then 'PASS ' else 'FAIL ' end) || check_name from results;
rollback;
