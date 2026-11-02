CREATE TABLE `frames` (
	`id` text PRIMARY KEY NOT NULL,
	`canvasId` text NOT NULL,
	`pageId` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`width` real NOT NULL,
	`height` real NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`updatedBy` text NOT NULL,
	`demo` integer,
	`hidden` integer,
	`locked` integer,
	`approval` text,
	`html` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `versions` (
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
CREATE INDEX `versions_by_frame` ON `versions` (`frameId`,`savedAt`);