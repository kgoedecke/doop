CREATE TABLE `frame_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`frameId` text NOT NULL,
	`html` text NOT NULL,
	`width` real NOT NULL,
	`height` real NOT NULL,
	`savedAt` integer NOT NULL,
	`savedBy` text NOT NULL,
	`savedByKind` text
);
--> statement-breakpoint
CREATE INDEX `frame_versions_frame_idx` ON `frame_versions` (`frameId`,`savedAt`);--> statement-breakpoint
ALTER TABLE `frames` ADD `rotation` real;