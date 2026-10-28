-- Tokenbudget voor accounts uit open registratie (2026-10-28, server/tokenBudget.js).
--
-- open_accounts: wie via open registratie binnenkwam. In een eigen tabel zonder
--   policies (alleen de server), want een student kan zijn profiel en zijn
--   account-metadata zelf aanpassen.
-- token_usage: tokens per gebruiker per dag (alleen voor open accounts). Een
--   docent ziet dit nooit; de student ziet zijn eigen percentage; de beheerder
--   ziet het totaal van alle open accounts.
--
-- Terugdraaien: supabase/rollback/20261028100000_token_budget_down.sql

CREATE TABLE IF NOT EXISTS public.open_accounts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  registered_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.open_accounts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.token_usage (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day date NOT NULL,
  tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS token_usage_day_idx ON public.token_usage (day);
ALTER TABLE public.token_usage ENABLE ROW LEVEL SECURITY;

-- Optellen zonder race: twee verzoeken tegelijk verliezen geen tokens.
CREATE OR REPLACE FUNCTION public.leap_add_token_usage(p_user uuid, p_day date, p_tokens bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.token_usage (user_id, day, tokens) VALUES (p_user, p_day, GREATEST(p_tokens, 0))
  ON CONFLICT (user_id, day) DO UPDATE SET tokens = public.token_usage.tokens + EXCLUDED.tokens;
$$;
REVOKE ALL ON FUNCTION public.leap_add_token_usage(uuid, date, bigint) FROM PUBLIC, anon, authenticated;

-- Totaal van alle open accounts vanaf een dag (de noodrem).
CREATE OR REPLACE FUNCTION public.leap_open_token_total(p_from date)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(t.tokens), 0)::bigint FROM public.token_usage t
   WHERE t.day >= p_from AND EXISTS (SELECT 1 FROM public.open_accounts o WHERE o.user_id = t.user_id);
$$;
REVOKE ALL ON FUNCTION public.leap_open_token_total(date) FROM PUBLIC, anon, authenticated;

-- Bestaande accounts uit open registratie: student, geen VU-adres, niet via
-- Canvas, niet door een docent uitgenodigd, en lid van een open cursus.
INSERT INTO public.open_accounts (user_id)
SELECT p.id FROM public.profiles p
 WHERE p.role = 'student'
   AND COALESCE(p.email, '') !~* '(@|\.)vu\.nl$'
   AND NOT EXISTS (SELECT 1 FROM public.lti_identities l WHERE l.user_id = p.id)
   AND NOT EXISTS (SELECT 1 FROM public.course_invitations i WHERE i.user_id = p.id)
   AND EXISTS (
     SELECT 1 FROM public.course_members m JOIN public.courses c ON c.id = m.course_id
      WHERE m.user_id = p.id AND c.enrollment_mode IN ('open', 'canvas_open'))
ON CONFLICT DO NOTHING;
