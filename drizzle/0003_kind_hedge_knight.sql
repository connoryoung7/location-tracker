CREATE TABLE `area_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`user_id` text NOT NULL,
	`area_id` text NOT NULL,
	`area_name` text,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`tst` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now'))
);
