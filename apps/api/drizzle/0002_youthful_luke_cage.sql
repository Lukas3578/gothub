CREATE TYPE "public"."mirror_direction" AS ENUM('push', 'pull');--> statement-breakpoint
CREATE TYPE "public"."mirror_status" AS ENUM('idle', 'running', 'success', 'failure');--> statement-breakpoint
CREATE TABLE "repository_mirrors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"direction" "mirror_direction" NOT NULL,
	"remote_url" varchar(1000) NOT NULL,
	"remote_username" varchar(200),
	"token_enc" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"is_exact_copy" boolean DEFAULT false NOT NULL,
	"status" "mirror_status" DEFAULT 'idle' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"lease_expires_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repository_mirrors" ADD CONSTRAINT "repository_mirrors_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_mirrors" ADD CONSTRAINT "repository_mirrors_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repository_mirrors_repo_direction_key" ON "repository_mirrors" USING btree ("repository_id","direction");--> statement-breakpoint
CREATE INDEX "repository_mirrors_pull_idx" ON "repository_mirrors" USING btree ("direction","is_enabled","last_sync_at");