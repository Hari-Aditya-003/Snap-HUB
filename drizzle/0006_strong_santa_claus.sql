CREATE TABLE `rate_limit_buckets` (
	`scope_key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`reset_at` integer NOT NULL
);
