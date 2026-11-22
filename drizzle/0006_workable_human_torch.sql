CREATE TABLE `area_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `area_categories_user_id_idx` ON `area_categories` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `area_categories_user_id_name_idx` ON `area_categories` (`user_id`,lower("name"));--> statement-breakpoint
ALTER TABLE `areas` ADD `category_id` text REFERENCES area_categories(id);--> statement-breakpoint
CREATE INDEX `areas_category_id_idx` ON `areas` (`category_id`);