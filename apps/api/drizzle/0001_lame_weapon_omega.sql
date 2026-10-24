CREATE TABLE "gist_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gist_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gist_stars" (
	"user_id" uuid NOT NULL,
	"gist_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gist_stars_user_id_gist_id_pk" PRIMARY KEY("user_id","gist_id")
);
--> statement-breakpoint
CREATE TABLE "gists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"description" varchar(500),
	"is_public" boolean DEFAULT false NOT NULL,
	"primary_filename" varchar(255),
	"primary_language" varchar(50),
	"file_count" integer DEFAULT 0 NOT NULL,
	"fork_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid,
	"organization_id" uuid,
	"number" integer NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" varchar(1000),
	"is_closed" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"column_id" uuid NOT NULL,
	"note" text,
	"issue_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_done_column" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gist_comments" ADD CONSTRAINT "gist_comments_gist_id_gists_id_fk" FOREIGN KEY ("gist_id") REFERENCES "public"."gists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gist_comments" ADD CONSTRAINT "gist_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gist_stars" ADD CONSTRAINT "gist_stars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gist_stars" ADD CONSTRAINT "gist_stars_gist_id_gists_id_fk" FOREIGN KEY ("gist_id") REFERENCES "public"."gists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gists" ADD CONSTRAINT "gists_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gists" ADD CONSTRAINT "gists_fork_of_id_gists_id_fk" FOREIGN KEY ("fork_of_id") REFERENCES "public"."gists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_boards" ADD CONSTRAINT "project_boards_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_boards" ADD CONSTRAINT "project_boards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_boards" ADD CONSTRAINT "project_boards_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cards" ADD CONSTRAINT "project_cards_column_id_project_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."project_columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cards" ADD CONSTRAINT "project_cards_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cards" ADD CONSTRAINT "project_cards_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_columns" ADD CONSTRAINT "project_columns_board_id_project_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."project_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gist_comments_gist_idx" ON "gist_comments" USING btree ("gist_id","created_at");--> statement-breakpoint
CREATE INDEX "gist_stars_gist_idx" ON "gist_stars" USING btree ("gist_id");--> statement-breakpoint
CREATE INDEX "gists_owner_idx" ON "gists" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "gists_public_idx" ON "gists" USING btree ("is_public","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_boards_repo_number_key" ON "project_boards" USING btree ("repository_id","number");--> statement-breakpoint
CREATE INDEX "project_boards_org_idx" ON "project_boards" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "project_cards_column_idx" ON "project_cards" USING btree ("column_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "project_cards_issue_key" ON "project_cards" USING btree ("column_id","issue_id");--> statement-breakpoint
CREATE INDEX "project_columns_board_idx" ON "project_columns" USING btree ("board_id","position");