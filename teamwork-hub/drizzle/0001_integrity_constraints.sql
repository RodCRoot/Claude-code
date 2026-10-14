-- Integrity guarantees that Drizzle's schema DSL cannot express.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
-- Minute offsets are timezone-independent, so this is safe to declare IMMUTABLE for indexing.
CREATE OR REPLACE FUNCTION tw_buffered_range(s timestamptz, e timestamptz, before_min integer, after_min integer)
RETURNS tstzrange LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT tstzrange(s - (before_min * interval '1 minute'), e + (after_min * interval '1 minute'), '[)')
$$;
--> statement-breakpoint
-- A coach cannot hold two exclusive (private/assessment) sessions whose buffered intervals overlap.
ALTER TABLE "schedule_sessions" ADD CONSTRAINT "sessions_coach_no_overlap"
  EXCLUDE USING gist (
    "coach_user_id" WITH =,
    tw_buffered_range("starts_at", "ends_at", "buffer_before_minutes", "buffer_after_minutes") WITH &&
  ) WHERE ("status" <> 'cancelled' AND "exclusive_coach" AND "coach_user_id" IS NOT NULL);
--> statement-breakpoint
-- An exclusive resource (e.g. assessment room) cannot be double-booked.
ALTER TABLE "schedule_sessions" ADD CONSTRAINT "sessions_resource_no_overlap"
  EXCLUDE USING gist (
    "resource_id" WITH =,
    tw_buffered_range("starts_at", "ends_at", "buffer_before_minutes", "buffer_after_minutes") WITH &&
  ) WHERE ("status" <> 'cancelled' AND "exclusive_resource" AND "resource_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "schedule_sessions" ADD CONSTRAINT "sessions_time_order" CHECK ("ends_at" > "starts_at");
--> statement-breakpoint
ALTER TABLE "schedule_sessions" ADD CONSTRAINT "sessions_capacity_nonneg" CHECK ("capacity" >= 0 AND "waitlist_capacity" >= 0);
--> statement-breakpoint
ALTER TABLE "credit_buckets" ADD CONSTRAINT "credit_buckets_nonneg" CHECK ("available" >= 0 AND "reserved" >= 0 AND "granted" >= 0);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amounts_nonneg" CHECK ("subtotal_minor" >= 0 AND "total_minor" >= 0 AND "discount_minor" >= 0 AND "tax_minor" >= 0);
--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "attempts_amount_pos" CHECK ("amount_minor" > 0);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');
--> statement-breakpoint
ALTER TABLE "body_region_reports" ADD CONSTRAINT "body_reports_severity" CHECK ("severity" BETWEEN 0 AND 10);
--> statement-breakpoint
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_srpe_range" CHECK ("session_rpe" IS NULL OR "session_rpe" BETWEEN 0 AND 10);
--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_srpe_range" CHECK ("session_rpe" IS NULL OR "session_rpe" BETWEEN 0 AND 10);
--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_duration_nonneg" CHECK ("duration_minutes" IS NULL OR "duration_minutes" >= 0);
--> statement-breakpoint
-- Audit history is append-only.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint
-- Signatures are immutable evidence.
CREATE OR REPLACE FUNCTION signatures_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'signatures are immutable';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER signatures_no_update BEFORE UPDATE OR DELETE ON "signatures"
  FOR EACH ROW EXECUTE FUNCTION signatures_immutable();
--> statement-breakpoint
-- Published form versions are immutable (content cannot change after publishing).
CREATE OR REPLACE FUNCTION form_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'published' AND (NEW.body_markdown IS DISTINCT FROM OLD.body_markdown
     OR NEW.fields IS DISTINCT FROM OLD.fields OR NEW.signers IS DISTINCT FROM OLD.signers
     OR NEW.title IS DISTINCT FROM OLD.title OR NEW.content_hash IS DISTINCT FROM OLD.content_hash) THEN
    RAISE EXCEPTION 'published form versions are immutable; create a new version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER form_version_no_edit BEFORE UPDATE ON "form_template_versions"
  FOR EACH ROW EXECUTE FUNCTION form_version_immutable();
