CREATE TABLE `frames` (
	`id` text PRIMARY KEY NOT NULL,
	`canvasId` text NOT NULL,
	`pageId` text,
	`name` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`width` real NOT NULL,
	`height` real NOT NULL,
	`html` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`updatedBy` text NOT NULL,
	`demo` integer,
	`hidden` integer,
	`locked` integer,
	`z` real,
	`approval` text
);
