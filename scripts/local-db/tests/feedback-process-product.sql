-- Checks for supabase/migrations/20261126100000_feedback_process_product.sql.
-- A new evaluator gives both kinds by default; process rounds take 1..50 or NULL.
-- Runs as postgres on the seed.sql fixture, in one rolled-back transaction.
\set ON_ERROR_STOP on
begin;
insert into public.projects (id, title, research_question, course_id, status) values
  ('00000000-0000-0000-0000-0000000f0f01', 'Proces', 'Q', '00000000-0000-0000-0000-0000000c0a01', 'draft');
insert into public.project_personas (id, project_id, name, system_prompt, persona_type, max_reviews) values
  ('00000000-0000-0000-0000-0000000f0f02', '00000000-0000-0000-0000-0000000f0f01', 'Feedbackgever', 'x', 'evaluator', 3);

create temp table results(check_name text, ok boolean);

insert into results select 'both kinds on by default',
  (select product_feedback and process_feedback from public.project_personas where id = '00000000-0000-0000-0000-0000000f0f02');
update public.project_personas set max_process_reviews = 2, process_focus = 'Samenwerking' where id = '00000000-0000-0000-0000-0000000f0f02';
insert into results select 'process rounds and focus are stored',
  (select max_process_reviews = 2 and process_focus = 'Samenwerking' from public.project_personas where id = '00000000-0000-0000-0000-0000000f0f02');
do $$ begin
  begin
    update public.project_personas set max_process_reviews = 0 where id = '00000000-0000-0000-0000-0000000f0f02';
    insert into results values ('process rounds reject 0', false);
  exception when check_violation then insert into results values ('process rounds reject 0', true); end;
end $$;

select (case when ok then 'PASS ' else 'FAIL ' end) || check_name from results;
rollback;
