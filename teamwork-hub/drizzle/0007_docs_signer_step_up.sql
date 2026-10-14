CREATE TABLE "signer_step_up_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"form_request_id" uuid NOT NULL,
	"signer_person_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"signer_role" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"address" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivery_status" text,
	"delivery_reason" text,
	"provider_message_id" text,
	"verified_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"signature_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signer_step_up_challenges" ADD CONSTRAINT "signer_step_up_challenges_form_request_id_form_requests_id_fk" FOREIGN KEY ("form_request_id") REFERENCES "public"."form_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signer_step_up_challenges" ADD CONSTRAINT "signer_step_up_challenges_signer_person_id_people_id_fk" FOREIGN KEY ("signer_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signer_step_up_challenges" ADD CONSTRAINT "signer_step_up_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signer_step_up_challenges" ADD CONSTRAINT "signer_step_up_challenges_signature_id_signatures_id_fk" FOREIGN KEY ("signature_id") REFERENCES "public"."signatures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "step_up_signer_idx" ON "signer_step_up_challenges" USING btree ("form_request_id","signer_person_id","created_at");