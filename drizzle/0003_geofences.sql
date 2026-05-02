CREATE TABLE `geofence_states` (
	`geofence_id` integer NOT NULL,
	`tid` text NOT NULL,
	`status` text NOT NULL,
	`pending_exit_at` integer,
	`last_evaluated_at` integer NOT NULL,
	PRIMARY KEY(`geofence_id`, `tid`),
	FOREIGN KEY (`geofence_id`) REFERENCES `geofences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `geofences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`radius_meters` real NOT NULL,
	`tid` text NOT NULL,
	`exit_grace_seconds` integer DEFAULT 60 NOT NULL,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_geofences_tid` ON `geofences` (`tid`);