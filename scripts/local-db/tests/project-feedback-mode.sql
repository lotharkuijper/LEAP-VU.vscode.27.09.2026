-- Checks for supabase/migrations/20261111300000_project_feedback_mode.sql.
-- The column takes the three choices or NULL, nothing else. Runs as postgres on
-- the seed.sql fixture, in one rolled-back transaction (test.sh fails on FAIL).
\set ON_ERROR_STOP on
begin;
insert into public.projects (id, title, research_question, course_id, status) values
  ('00000000-0000-0000-0000-0000000f0e01', 'Modus', 'Q', '00000000-0000-0000-0000-0000000c0a01', 'draft');

create temp table results(check_name text, ok boolean);

insert into results select 'feedback_mode starts empty', (select feedback_mode is null from public.projects where id = '00000000-0000-0000-0000-0000000f0e01');
update public.projects set feedback_mode = 'marking' where id = '00000000-0000-0000-0000-0000000f0e01';
insert into results select 'feedback_mode accepts marking', (select feedback_mode = 'marking' from public.projects where id = '00000000-0000-0000-0000-0000000f0e01');
do $$ begin
  begin
    update public.projects set feedback_mode = 'grade' where id = '00000000-0000-0000-0000-0000000f0e01';
    insert into results values ('feedback_mode rejects an unknown value', false);
  exception when check_violation then insert into results values ('feedback_mode rejects an unknown value', true); end;
end $$;

select (case when ok then 'PASS ' else 'FAIL ' end) || check_name from results;
rollback;
