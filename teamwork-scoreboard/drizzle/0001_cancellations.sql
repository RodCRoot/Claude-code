CREATE TABLE `cancellations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`athlete_name` text NOT NULL,
	`athlete_id` integer,
	`effective_date` text NOT NULL,
	`drop_reason` text,
	`sub_drop_reason` text,
	`cancelled_by` text,
	`status` text,
	`category` text DEFAULT 'other' NOT NULL,
	`dedupe_key` text NOT NULL,
	`duplicate_rows` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`demo` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cancellation_dedupe_unique` ON `cancellations` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `cancellations_date_idx` ON `cancellations` (`effective_date`);