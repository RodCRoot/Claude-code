-- Billing integrity (additive). Product versions are immutable price/terms records:
-- only effective_to may be set (to close a version when a newer one takes effect).
CREATE OR REPLACE FUNCTION product_version_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product versions cannot be deleted; create a new version';
  END IF;
  IF NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.price_minor IS DISTINCT FROM OLD.price_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.interval IS DISTINCT FROM OLD.interval OR NEW.interval_count IS DISTINCT FROM OLD.interval_count
     OR NEW.credits_per_period IS DISTINCT FROM OLD.credits_per_period OR NEW.unlimited IS DISTINCT FROM OLD.unlimited
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
--> statement-breakpoint
CREATE TRIGGER product_version_no_edit BEFORE UPDATE OR DELETE ON "product_versions"
  FOR EACH ROW EXECUTE FUNCTION product_version_immutable();
--> statement-breakpoint
-- Offline money must be attributable: staff_attested rows need a recorder and a reference.
ALTER TABLE "transactions" ADD CONSTRAINT "txn_staff_attested_attributed"
  CHECK ("verification" <> 'staff_attested' OR ("recorded_by" IS NOT NULL AND "manual_reference" IS NOT NULL AND length(btrim("manual_reference")) > 0));
--> statement-breakpoint
-- A manual/offline record can never claim provider verification.
ALTER TABLE "transactions" ADD CONSTRAINT "txn_manual_never_provider_verified"
  CHECK ("provider" <> 'manual' OR "verification" = 'staff_attested');
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_qty_pos" CHECK ("quantity" > 0);
