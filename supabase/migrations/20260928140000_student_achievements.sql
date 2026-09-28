-- Achievements voor studenten (fase A: niveau per onderwerp) — 2026-09-28.
--
-- Een achievement wordt ALLEEN door de server toegekend (service role), op
-- basis van bewijs: nu een positief oordeel op "klaar voor een hoger niveau?"
-- in de chat. Studenten kunnen hun eigen achievements lezen, niet schrijven.
--
-- kind: 'level' (fase A). Later o.a. 'quiz_mastery', 'quiz_perfect',
--       'project_badge', 'learning_goal' — daarom geen CHECK op kind.
-- topic_key: concept_id als tekst, of '' voor de hele cursus; samen met
--       (user, course, kind, level) uniek, zodat je elk achievement één keer verdient.
-- evidence_journal_id: de dagboekregel met het oordeel (het bewijs).
--
-- Volledig ADDITIEF. Terugdraaien: supabase/rollback/20260928140000_student_achievements_down.sql
BEGIN;

CREATE TABLE IF NOT EXISTS student_achievements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id uuid REFERENCES courses(id) ON DELETE CASCADE,
  kind text NOT NULL,
  concept_id uuid REFERENCES concepts(id) ON DELETE SET NULL,
  topic_label text,
  topic_key text NOT NULL DEFAULT '',
  level smallint CHECK (level IS NULL OR level BETWEEN 1 AND 5),
  evidence_journal_id uuid REFERENCES learning_journal_entries(id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  earned_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS student_achievements_unique
  ON student_achievements (user_id, course_id, kind, topic_key, level);
CREATE INDEX IF NOT EXISTS student_achievements_user ON student_achievements (user_id, earned_at DESC);

ALTER TABLE student_achievements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students read own achievements" ON student_achievements;
CREATE POLICY "Students read own achievements"
  ON student_achievements FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

COMMIT;
