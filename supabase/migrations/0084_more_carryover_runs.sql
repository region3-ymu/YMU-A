-- ===========================================================================
-- 0084 — three more back-to-back runs carry over
-- ===========================================================================
--
-- YMU 2026-08-26, reversing the earlier "keep the normal clock-in here" call
-- for these three:
--
--   James Perez / Madison Middle       Drumline I -> Beginning Band   5 min
--   Reinaldo Velez / Benjamin Franklin Drumline I -> Beginning Band   3 min
--   Reinaldo Velez / Lillie C. Evans   Drumline I -> Beginning Band   0-3 min
--
-- Between them: 160 dates a term and 5 late flags already raised.
--
-- ── Why these three are unscoped and Little River is not ─────────────────
--
-- A rule with null patterns covers ANY pair of that teacher's consecutive
-- classes at that school, so it is only safe where there is exactly one run to
-- cover. Checked before writing this, via back_to_back_runs():
--
--   James Perez / Madison        1 run
--   Reinaldo / Benjamin Franklin 1 run (listed twice — the Wednesday bell
--                                schedule shifts it, same pair of classes)
--   Reinaldo / Lillie C. Evans   1 run (same, Wednesday variant)
--
-- Reinaldo's Little River rule (0077) stays title-scoped because there he has
-- four classes in a row and only the last link carries over. Rules are keyed
-- per (school, teacher, title pair), so these three do not touch it.
--
-- ── Morningside was asked for and then withdrawn ─────────────────────────
--
-- Omar Cuellar / Morningside was in the same request and YMU pulled it back
-- immediately. Worth recording why it was the awkward one: its gap is 30
-- minutes, not 3 to 5, so it would have needed max_gap_minutes raised past the
-- 15 default — and 30 minutes is long enough to leave the building, which
-- makes "they clocked into the first one" a much weaker claim about the second.
-- If it comes back, it needs its own max_gap_minutes, not this default.
-- ===========================================================================

insert into public.auto_clock_in_rules (
  school_id, teacher_id, first_class_pattern, second_class_pattern, max_gap_minutes, note
)
select s.id, p.id, v.first_pattern, v.second_pattern, 15, v.note
  from (values
    -- Nulls spelled out rather than implied: "any pair of this teacher's
    -- consecutive classes here" is the decision being made, and it should be
    -- visible on the row. Same shape as 0077's seed so one parser reads both.
    ('Madison Middle School', 'James Perez', null, null,
     'Drumline I into Beginning Band, 5-minute gap, same school. 57 dates, 2 late flags. YMU 2026-08-26.'),
    ('Benjamin Franklin K-8', 'Reinaldo Velez', null, null,
     'Drumline I into Beginning Band, 3-minute gap, same school. 58 dates, 2 late flags. YMU 2026-08-26.'),
    ('Lillie C. Evans K-8', 'Reinaldo Velez', null, null,
     'Drumline I into Beginning Band, 0-3 minute gap, same school. 57 dates, 2 late flags. YMU 2026-08-26.')
  ) as v (school_name, teacher_name, first_pattern, second_pattern, note)
  join public.schools s on s.name = v.school_name
  join public.profiles p on p.full_name = v.teacher_name and p.archived_at is null
on conflict do nothing;
