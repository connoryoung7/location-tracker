CREATE TABLE IF NOT EXISTS `locations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`tst` integer NOT NULL,
	`tid` text NOT NULL,
	`acc` real,
	`alt` real,
	`batt` integer,
	`vel` real,
	`conn` text,
	`tag` text,
	`topic` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tst` integer NOT NULL,
	`wtst` integer NOT NULL,
	`acc` real NOT NULL,
	`event` text NOT NULL,
	`lat` real,
	`lon` real,
	`tid` text,
	`desc` text,
	`t` text,
	`rid` text,
	`created_at` text DEFAULT (datetime('now'))
);
