CREATE TABLE "member_request_athletes" (
	"request_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	CONSTRAINT "member_request_athletes_request_id_athlete_id_pk" PRIMARY KEY("request_id","athlete_id")
);
--> statement-breakpoint
CREATE TABLE "member_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" text NOT NULL,
	"channel" text NOT NULL,
	"requester_person_id" uuid,
	"sent_on" date NOT NULL,
	"received_on" date,
	"summary" text,
	"requested_effective_on" date,
	"thread_id" uuid,
	"source_message_id" uuid,
	"source_inbound_id" uuid,
	"pasted_text" text,
	"status" text DEFAULT 'new' NOT NULL,
	"suggested" boolean DEFAULT false NOT NULL,
	"matched_keyword" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_user_id" uuid,
	"owner_user_id" uuid,
	"resolution_notes" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"created_by_user_id" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_request_athletes" ADD CONSTRAINT "member_request_athletes_request_id_member_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."member_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_request_athletes" ADD CONSTRAINT "member_request_athletes_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_requester_person_id_people_id_fk" FOREIGN KEY ("requester_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_source_inbound_id_inbound_messages_id_fk" FOREIGN KEY ("source_inbound_id") REFERENCES "public"."inbound_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_request_athletes_athlete_idx" ON "member_request_athletes" USING btree ("athlete_id");--> statement-breakpoint
CREATE INDEX "member_requests_org_status_idx" ON "member_requests" USING btree ("org_id","status","sent_on");--> statement-breakpoint
CREATE UNIQUE INDEX "member_requests_source_message_uq" ON "member_requests" USING btree ("org_id","source_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_requests_source_inbound_uq" ON "member_requests" USING btree ("org_id","source_inbound_id");--> statement-breakpoint
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_type_ck" CHECK ("type" IN ('hold','pause','cancel','in_season','plan_change','card_update','billing_question','other'));--> statement-breakpoint
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_channel_ck" CHECK ("channel" IN ('email_direct','email_forwarded','sms','messenger','phone_ai_recap','web_form','in_app','in_person','other'));--> statement-breakpoint
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_status_ck" CHECK ("status" IN ('new','in_progress','resolved','declined','dismissed'));--> statement-breakpoint
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_received_after_sent_ck" CHECK ("received_on" IS NULL OR "received_on" >= "sent_on");
