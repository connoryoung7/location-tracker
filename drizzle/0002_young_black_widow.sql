CREATE TABLE `addresses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`display_name` text NOT NULL,
	`street` text,
	`city` text,
	`state` text,
	`country` text,
	`country_code` text,
	`postal_code` text,
	`created_at` text DEFAULT (datetime('now'))
);
