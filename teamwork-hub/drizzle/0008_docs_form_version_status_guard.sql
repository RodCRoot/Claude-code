-- Forms integrity (additive). 0001's form_version_no_edit trigger only freezes the content
-- columns while a row is 'published'. Without this guard, raw SQL could flip a published
-- version back to 'draft' (or to 'retired'), edit its content there, and the signatures that
-- reference it would no longer match what they were made over.
--   * published is terminal: no published -> draft / retired (or any other) status change
--   * nothing returns to draft once it has left it (retired -> draft is refused too)
--   * non-draft rows keep their content, template and version number
--   * only drafts can be deleted
CREATE OR REPLACE FUNCTION form_version_status_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'form version % is %; only drafts can be deleted', OLD.id, OLD.status;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'published' AND NEW.status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'published form versions cannot change status (published -> %); create a new version', NEW.status;
  END IF;
  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'form versions cannot return to draft (% -> draft); create a new version', OLD.status;
  END IF;
  IF OLD.status <> 'draft' AND (NEW.body_markdown IS DISTINCT FROM OLD.body_markdown
     OR NEW.fields IS DISTINCT FROM OLD.fields OR NEW.signers IS DISTINCT FROM OLD.signers
     OR NEW.title IS DISTINCT FROM OLD.title OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.template_id IS DISTINCT FROM OLD.template_id OR NEW.version IS DISTINCT FROM OLD.version) THEN
    RAISE EXCEPTION 'form version % is %; its content is immutable', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER form_version_status_guard BEFORE UPDATE OR DELETE ON "form_template_versions"
  FOR EACH ROW EXECUTE FUNCTION form_version_status_guard();
