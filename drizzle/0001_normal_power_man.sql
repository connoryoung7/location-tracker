CREATE TABLE `waypoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`desc` text NOT NULL,
	`tst` integer NOT NULL,
	`lat` real,
	`lon` real,
	`rad` real,
	`uuid` text,
	`major` integer,
	`minor` integer,
	`rid` text,
	`created_at` text DEFAULT (datetime('now'))
);
