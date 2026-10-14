DROP INDEX "maxes_source_uq";--> statement-breakpoint
DROP INDEX "test_sessions_src_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "maxes_source_uq" ON "maxes" USING btree ("org_id","source","source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_sessions_src_uq" ON "test_sessions" USING btree ("org_id","source","source_record_id");