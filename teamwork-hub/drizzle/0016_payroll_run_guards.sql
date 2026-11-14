-- Payroll integrity (additive).
-- 1. A payroll run's numbers are frozen once approved: snapshot, range and totals cannot change,
--    status only moves forward (draft -> approved -> exported), and approved/exported runs cannot be deleted.
CREATE OR REPLACE FUNCTION payroll_run_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'approved payroll runs cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.from_date IS DISTINCT FROM OLD.from_date
    OR NEW.to_date IS DISTINCT FROM OLD.to_date OR NEW.gross_minor IS DISTINCT FROM OLD.gross_minor
    OR NEW.deduction_minor IS DISTINCT FROM OLD.deduction_minor OR NEW.net_minor IS DISTINCT FROM OLD.net_minor
    OR NEW.org_id IS DISTINCT FROM OLD.org_id) THEN
    RAISE EXCEPTION 'approved payroll runs are immutable; start a new run';
  END IF;
  IF (OLD.status = 'approved' AND NEW.status = 'draft') OR (OLD.status = 'exported' AND NEW.status <> 'exported') THEN
    RAISE EXCEPTION 'payroll run status cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payroll_run_no_edit BEFORE UPDATE OR DELETE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION payroll_run_guard();
--> statement-breakpoint
-- 2. Original clock values are write-once: corrections change clock_in/clock_out, never original_*.
CREATE OR REPLACE FUNCTION time_entry_original_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'time entries cannot be deleted; void them with a reason';
  END IF;
  IF NEW.original_clock_in IS DISTINCT FROM OLD.original_clock_in
     OR (OLD.original_clock_out IS NOT NULL AND NEW.original_clock_out IS DISTINCT FROM OLD.original_clock_out)
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'original clock values and owner of a time entry cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER time_entry_original_no_edit BEFORE UPDATE OR DELETE ON "time_entries"
  FOR EACH ROW EXECUTE FUNCTION time_entry_original_guard();
