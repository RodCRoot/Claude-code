CREATE TABLE `appointments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer,
	`athlete_id` integer,
	`type_key` text DEFAULT 'success_session' NOT NULL,
	`scheduled_at` text NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`confirmed` integer DEFAULT 0 NOT NULL,
	`assigned_user_id` integer,
	`outcome_note` text,
	`created_at` text NOT NULL,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `appts_sched_idx` ON `appointments` (`scheduled_at`);--> statement-breakpoint
CREATE TABLE `athlete_onboarding` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`athlete_id` integer NOT NULL,
	`step_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`completed_at` text,
	`completed_by_user_id` integer,
	`note` text,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `onboarding_steps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`completed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `athlete_onboarding_unique` ON `athlete_onboarding` (`athlete_id`,`step_id`);--> statement-breakpoint
CREATE TABLE `athletes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`guardian_name` text,
	`birth_year` integer,
	`program` text,
	`start_date` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`lead_source` text,
	`expected_sessions_per_week` integer DEFAULT 2 NOT NULL,
	`assigned_user_id` integer,
	`risk_override` text,
	`reactivated_at` text,
	`notes` text,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`assigned_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `athletes_status_idx` ON `athletes` (`status`);--> statement-breakpoint
CREATE TABLE `attendance` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`athlete_id` integer NOT NULL,
	`session_id` integer,
	`date` text NOT NULL,
	`status` text DEFAULT 'attended' NOT NULL,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `class_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attendance_date_idx` ON `attendance` (`date`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`audience` text,
	`start_date` text,
	`end_date` text,
	`goal` text,
	`checklist` text DEFAULT '{}' NOT NULL,
	`leads_generated` integer DEFAULT 0 NOT NULL,
	`appointments_booked` integer DEFAULT 0 NOT NULL,
	`enrollments` integer DEFAULT 0 NOT NULL,
	`revenue` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`notes` text,
	`demo` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `class_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`time` text NOT NULL,
	`name` text NOT NULL,
	`capacity` integer DEFAULT 8 NOT NULL,
	`coach_user_id` integer,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`coach_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_date_idx` ON `class_sessions` (`date`);--> statement-breakpoint
CREATE TABLE `connectors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`mode` text DEFAULT 'csv' NOT NULL,
	`status` text DEFAULT 'not_configured' NOT NULL,
	`env_vars` text DEFAULT '[]' NOT NULL,
	`config_note` text,
	`last_sync_at` text,
	`last_sync_status` text,
	`sync_interval_minutes` integer DEFAULT 1440 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connectors_key_unique` ON `connectors` (`key`);--> statement-breakpoint
CREATE TABLE `content_themes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_of_week` integer NOT NULL,
	`theme` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`target_entity` text NOT NULL,
	`connector_key` text,
	`mapping` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`demo` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kpi_values` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`metric_id` integer NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`value` real NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`entered_by_user_id` integer,
	`source_note` text,
	`override_reason` text,
	`created_at` text NOT NULL,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`metric_id`) REFERENCES `metrics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entered_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `kpi_values_metric_idx` ON `kpi_values` (`metric_id`,`period_start`);--> statement-breakpoint
CREATE TABLE `lead_activities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`user_id` integer,
	`type` text DEFAULT 'note' NOT NULL,
	`at` text NOT NULL,
	`note` text,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`contact_name` text,
	`phone` text,
	`email` text,
	`source` text DEFAULT 'other' NOT NULL,
	`stage` text DEFAULT 'new' NOT NULL,
	`qualified` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`first_contacted_at` text,
	`assigned_user_id` integer,
	`notes` text,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`assigned_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `leads_stage_idx` ON `leads` (`stage`);--> statement-breakpoint
CREATE INDEX `leads_created_idx` ON `leads` (`created_at`);--> statement-breakpoint
CREATE TABLE `marketing_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pillar` text NOT NULL,
	`name` text NOT NULL,
	`month` text NOT NULL,
	`target` real,
	`actual` real DEFAULT 0 NOT NULL,
	`unit` text DEFAULT 'count' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`notes` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`demo` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`athlete_id` integer NOT NULL,
	`plan` text NOT NULL,
	`monthly_rate` real DEFAULT 0 NOT NULL,
	`is_trial` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`hold_start` text,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`group_key` text NOT NULL,
	`definition` text,
	`formula` text,
	`source_system` text,
	`source_fields` text,
	`data_owner` text,
	`frequency` text DEFAULT 'weekly' NOT NULL,
	`unit` text DEFAULT 'count' NOT NULL,
	`direction` text DEFAULT 'up' NOT NULL,
	`goal` real,
	`red_below_pct` real DEFAULT 70 NOT NULL,
	`yellow_below_pct` real DEFAULT 90 NOT NULL,
	`kind` text DEFAULT 'flow' NOT NULL,
	`auto_compute` integer DEFAULT 0 NOT NULL,
	`sensitive` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`active` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metrics_key_unique` ON `metrics` (`key`);--> statement-breakpoint
CREATE TABLE `onboarding_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`due_offset_days` integer DEFAULT 7 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outreach` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`athlete_id` integer NOT NULL,
	`user_id` integer,
	`type` text DEFAULT 'call' NOT NULL,
	`at` text NOT NULL,
	`note` text,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`athlete_id` integer,
	`date` text NOT NULL,
	`amount` real NOT NULL,
	`category` text DEFAULT 'membership' NOT NULL,
	`status` text DEFAULT 'paid' NOT NULL,
	`note` text,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payments_date_idx` ON `payments` (`date`);--> statement-breakpoint
CREATE TABLE `report_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`report_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `reports_515`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reports_515` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`week_start` text NOT NULL,
	`rating` integer,
	`wins` text,
	`kpi_wins` text,
	`commitments_completed` text,
	`commitments_missed` text,
	`challenges` text,
	`client_concerns` text,
	`facility_concerns` text,
	`help_needed` text,
	`next_priorities` text,
	`manager_response` text,
	`manager_status` text DEFAULT 'pending' NOT NULL,
	`follow_up_actions` text,
	`submitted_at` text,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_515_unique` ON `reports_515` (`user_id`,`week_start`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`builtin` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_name_unique` ON `roles` (`name`);--> statement-breakpoint
CREATE TABLE `scorecard_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scorecard_metric_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`week_start` text NOT NULL,
	`value` real NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`scorecard_metric_id`) REFERENCES `scorecard_metrics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scorecard_entry_unique` ON `scorecard_entries` (`scorecard_metric_id`,`user_id`,`week_start`);--> statement-breakpoint
CREATE TABLE `scorecard_metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`template_id` integer NOT NULL,
	`name` text NOT NULL,
	`unit` text DEFAULT 'count' NOT NULL,
	`weekly_goal` real DEFAULT 0 NOT NULL,
	`direction` text DEFAULT 'up' NOT NULL,
	`auto_key` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `scorecard_templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scorecard_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`role_name` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scorecard_weeks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`week_start` text NOT NULL,
	`staff_note` text,
	`owner_comment` text,
	`submitted_at` text,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scorecard_week_unique` ON `scorecard_weeks` (`user_id`,`week_start`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connector_id` integer NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'success' NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`records_processed` integer DEFAULT 0 NOT NULL,
	`records_rejected` integer DEFAULT 0 NOT NULL,
	`message` text,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_runs_connector_idx` ON `sync_runs` (`connector_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `task_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`category` text DEFAULT 'operations' NOT NULL,
	`subcategory` text,
	`recurrence` text DEFAULT 'daily' NOT NULL,
	`day_of_week` integer,
	`day_of_month` integer,
	`assigned_role` text,
	`assigned_user_id` integer,
	`requires_approval` integer DEFAULT 0 NOT NULL,
	`requires_proof` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`assigned_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`template_id` integer,
	`title` text NOT NULL,
	`category` text DEFAULT 'operations' NOT NULL,
	`subcategory` text,
	`due_date` text NOT NULL,
	`assigned_role` text,
	`assigned_user_id` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`completed_at` text,
	`completed_by_user_id` integer,
	`completed_late` integer DEFAULT 0 NOT NULL,
	`proof_note` text,
	`proof_url` text,
	`requires_approval` integer DEFAULT 0 NOT NULL,
	`approved_by_user_id` integer,
	`created_at` text NOT NULL,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `task_templates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assigned_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`completed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_template_due_unique` ON `tasks` (`template_id`,`due_date`);--> statement-breakpoint
CREATE INDEX `tasks_due_idx` ON `tasks` (`due_date`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role_id` integer NOT NULL,
	`title` text,
	`active` integer DEFAULT 1 NOT NULL,
	`demo` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);