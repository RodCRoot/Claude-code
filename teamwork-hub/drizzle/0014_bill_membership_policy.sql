ALTER TABLE "membership_holds" ADD COLUMN "kind" text DEFAULT 'hold' NOT NULL;--> statement-breakpoint
ALTER TABLE "membership_holds" ADD COLUMN "requested_on" date;--> statement-breakpoint
ALTER TABLE "membership_holds" ADD COLUMN "request_channel" text;--> statement-breakpoint
ALTER TABLE "membership_holds" ADD COLUMN "override_reason" text;--> statement-breakpoint
ALTER TABLE "membership_holds" ADD COLUMN "related_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "membership_holds" ADD COLUMN "makeup_bucket_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "kind" text DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "commitment_starts_on" date;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "commitment_ends_on" date;--> statement-breakpoint
ALTER TABLE "product_versions" ADD COLUMN "classes_per_week" integer;
--> statement-breakpoint
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_classes_per_week_ck" CHECK ("classes_per_week" IS NULL OR "classes_per_week" > 0);
--> statement-breakpoint
ALTER TABLE "membership_holds" ADD CONSTRAINT "membership_holds_kind_ck" CHECK ("kind" IN ('hold','in_season'));
--> statement-breakpoint
ALTER TABLE "membership_holds" ADD CONSTRAINT "membership_holds_channel_ck" CHECK ("request_channel" IS NULL OR "request_channel" IN ('email','forwarded_email','sms','messenger','phone','voice_agent_recap','website_form','in_person'));
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_kind_ck" CHECK ("kind" IN ('regular','in_season'));
--> statement-breakpoint
-- An In Season membership is fixed-term: it always has an end and a cancel date, so it can never auto-renew.
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_in_season_fixed_term_ck" CHECK ("kind" <> 'in_season' OR ("end_date" IS NOT NULL AND "cancel_at" IS NOT NULL));
--> statement-breakpoint
-- Keep product versions immutable, now including the weekly class cap.
CREATE OR REPLACE FUNCTION product_version_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product versions cannot be deleted; create a new version';
  END IF;
  IF NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.price_minor IS DISTINCT FROM OLD.price_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.interval IS DISTINCT FROM OLD.interval OR NEW.interval_count IS DISTINCT FROM OLD.interval_count
     OR NEW.credits_per_period IS DISTINCT FROM OLD.credits_per_period OR NEW.unlimited IS DISTINCT FROM OLD.unlimited
     OR NEW.classes_per_week IS DISTINCT FROM OLD.classes_per_week
     OR NEW.credit_expiry_days IS DISTINCT FROM OLD.credit_expiry_days OR NEW.rollover_max IS DISTINCT FROM OLD.rollover_max
     OR NEW.service_type_ids IS DISTINCT FROM OLD.service_type_ids OR NEW.trial_days IS DISTINCT FROM OLD.trial_days
     OR NEW.commitment_months IS DISTINCT FROM OLD.commitment_months
     OR NEW.cancellation_notice_days IS DISTINCT FROM OLD.cancellation_notice_days
     OR NEW.family_discount IS DISTINCT FROM OLD.family_discount OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
    RAISE EXCEPTION 'product versions are immutable; create a new version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
