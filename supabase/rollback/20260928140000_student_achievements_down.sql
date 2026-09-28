-- TERUGDRAAIEN van 20260928140000_student_achievements.sql.
-- LET OP: verdiende achievements gaan hiermee verloren (de bijbehorende
-- dagboekregels blijven bestaan).
BEGIN;

DROP TABLE IF EXISTS student_achievements;

COMMIT;
