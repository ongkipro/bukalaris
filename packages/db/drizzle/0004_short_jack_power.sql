CREATE TABLE "rate_limit" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rate_limit_key_window_start_pk" PRIMARY KEY("key","window_start")
);
