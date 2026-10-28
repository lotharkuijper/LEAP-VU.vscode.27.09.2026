-- Terugdraaien van 20261028100000_token_budget.sql (het budget verdwijnt; niets anders verandert).
DROP FUNCTION IF EXISTS public.leap_add_token_usage(uuid, date, bigint);
DROP FUNCTION IF EXISTS public.leap_open_token_total(date);
DROP TABLE IF EXISTS public.token_usage;
DROP TABLE IF EXISTS public.open_accounts;
DELETE FROM public.chatbot_prompts WHERE name = '__token_budget__';
DELETE FROM public.leap_migrations WHERE name = '20261028100000_token_budget.sql';
