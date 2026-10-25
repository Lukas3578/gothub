CREATE TABLE `abuse_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_id` text,
	`subject_type` text(32) NOT NULL,
	`subject_id` text NOT NULL,
	`reason` text(64) NOT NULL,
	`details` text,
	`status` text(32) DEFAULT 'open' NOT NULL,
	`resolved_by_id` text,
	`resolved_at` integer,
	`resolution_note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `abuse_reports_status_idx` ON `abuse_reports` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `abuse_reports_subject_idx` ON `abuse_reports` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text(100) NOT NULL,
	`token_hash` text(64) NOT NULL,
	`token_prefix` text(16) NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_key` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_user_idx` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_type` text DEFAULT 'user' NOT NULL,
	`actor_id` text,
	`action` text(64) NOT NULL,
	`target_type` text(32),
	`target_id` text,
	`repository_id` text,
	`organization_id` text,
	`ip_address` text(45),
	`user_agent` text(400),
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_logs_actor_idx` ON `audit_logs` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_action_idx` ON `audit_logs` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_repo_idx` ON `audit_logs` (`repository_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `branch_protections` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`pattern` text(255) NOT NULL,
	`require_pull_request` integer DEFAULT true NOT NULL,
	`required_approvals` integer DEFAULT 1 NOT NULL,
	`dismiss_stale_reviews` integer DEFAULT false NOT NULL,
	`require_status_checks` integer DEFAULT false NOT NULL,
	`required_status_checks` text DEFAULT '[]' NOT NULL,
	`require_linear_history` integer DEFAULT false NOT NULL,
	`block_force_push` integer DEFAULT true NOT NULL,
	`block_deletion` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `branch_protections_repo_pattern_key` ON `branch_protections` (`repository_id`,`pattern`);--> statement-breakpoint
CREATE TABLE `commit_index` (
	`repository_id` text NOT NULL,
	`oid` text(40) NOT NULL,
	`author_name` text(255) NOT NULL,
	`author_email` text(320) NOT NULL,
	`author_user_id` text,
	`committed_at` integer NOT NULL,
	`subject` text(500) NOT NULL,
	`body` text,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`files_changed` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`repository_id`, `oid`),
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `commit_index_repo_date_idx` ON `commit_index` (`repository_id`,`committed_at`);--> statement-breakpoint
CREATE INDEX `commit_index_author_idx` ON `commit_index` (`author_user_id`,`committed_at`);--> statement-breakpoint
CREATE TABLE `follows` (
	`follower_id` text NOT NULL,
	`following_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`follower_id`, `following_id`),
	FOREIGN KEY (`follower_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`following_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `follows_following_idx` ON `follows` (`following_id`);--> statement-breakpoint
CREATE TABLE `gist_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`gist_id` text NOT NULL,
	`author_id` text,
	`body` text NOT NULL,
	`edited_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`gist_id`) REFERENCES `gists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `gist_comments_gist_idx` ON `gist_comments` (`gist_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `gist_stars` (
	`user_id` text NOT NULL,
	`gist_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `gist_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`gist_id`) REFERENCES `gists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gist_stars_gist_idx` ON `gist_stars` (`gist_id`);--> statement-breakpoint
CREATE TABLE `gists` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`description` text(500),
	`is_public` integer DEFAULT false NOT NULL,
	`primary_filename` text(255),
	`primary_language` text(50),
	`file_count` integer DEFAULT 0 NOT NULL,
	`fork_of_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fork_of_id`) REFERENCES `gists`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `gists_owner_idx` ON `gists` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `gists_public_idx` ON `gists` (`is_public`,`created_at`);--> statement-breakpoint
CREATE TABLE `issue_assignees` (
	`issue_id` text NOT NULL,
	`user_id` text NOT NULL,
	`assigned_at` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `user_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_assignees_user_idx` ON `issue_assignees` (`user_id`);--> statement-breakpoint
CREATE TABLE `issue_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`author_id` text,
	`body` text NOT NULL,
	`edited_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `issue_comments_issue_idx` ON `issue_comments` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `issue_events` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`actor_id` text,
	`event_type` text(48) NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `issue_events_issue_idx` ON `issue_events` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `issue_labels` (
	`issue_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`issue_id`, `label_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_labels_label_idx` ON `issue_labels` (`label_id`);--> statement-breakpoint
CREATE TABLE `issue_links` (
	`source_issue_id` text NOT NULL,
	`target_issue_id` text NOT NULL,
	`link_type` text(32) NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`source_issue_id`, `target_issue_id`, `link_type`),
	FOREIGN KEY (`source_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `issue_links_target_idx` ON `issue_links` (`target_issue_id`);--> statement-breakpoint
CREATE TABLE `issue_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`kind` text DEFAULT 'issue' NOT NULL,
	`name` text(100) NOT NULL,
	`about` text(300),
	`title_prefix` text(100),
	`body` text NOT NULL,
	`default_labels` text DEFAULT '[]' NOT NULL,
	`source_path` text(500) NOT NULL,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_templates_repo_path_key` ON `issue_templates` (`repository_id`,`source_path`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`number` integer NOT NULL,
	`kind` text DEFAULT 'issue' NOT NULL,
	`title` text(500) NOT NULL,
	`body` text,
	`state` text DEFAULT 'open' NOT NULL,
	`close_reason` text,
	`author_id` text,
	`milestone_id` text,
	`is_locked` integer DEFAULT false NOT NULL,
	`comment_count` integer DEFAULT 0 NOT NULL,
	`closed_at` integer,
	`closed_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`milestone_id`) REFERENCES `milestones`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`closed_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_repo_number_key` ON `issues` (`repository_id`,`number`);--> statement-breakpoint
CREATE INDEX `issues_repo_state_idx` ON `issues` (`repository_id`,`kind`,`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `issues_author_idx` ON `issues` (`author_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `issues_milestone_idx` ON `issues` (`milestone_id`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`name` text(64) NOT NULL,
	`color` text(6) DEFAULT '6b7280' NOT NULL,
	`description` text(200),
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_repo_name_key` ON `labels` (`repository_id`,`name`);--> statement-breakpoint
CREATE TABLE `milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text(255) NOT NULL,
	`description` text,
	`due_on` integer,
	`state` text DEFAULT 'open' NOT NULL,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `milestones_repo_number_key` ON `milestones` (`repository_id`,`number`);--> statement-breakpoint
CREATE TABLE `namespaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text(39) NOT NULL,
	`name_lower` text(39) NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `namespaces_name_lower_key` ON `namespaces` (`name_lower`);--> statement-breakpoint
CREATE TABLE `notification_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email_on_mention` integer DEFAULT true NOT NULL,
	`email_on_review_request` integer DEFAULT true NOT NULL,
	`email_on_assign` integer DEFAULT true NOT NULL,
	`email_on_workflow_failure` integer DEFAULT true NOT NULL,
	`auto_watch_on_access` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`repository_id` text,
	`subject_type` text(32) NOT NULL,
	`subject_id` text NOT NULL,
	`reason` text NOT NULL,
	`title` text(500) NOT NULL,
	`target_path` text(1000) NOT NULL,
	`actor_id` text,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `notifications_user_unread_idx` ON `notifications` (`user_id`,`read_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_subject_idx` ON `notifications` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `organization_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`invitee_id` text,
	`invitee_email` text(320),
	`role` text DEFAULT 'member' NOT NULL,
	`invited_by_id` text,
	`token_hash` text(64) NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`declined_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invitee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invitations_token_key` ON `organization_invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `organization_invitations_org_idx` ON `organization_invitations` (`organization_id`);--> statement-breakpoint
CREATE TABLE `organization_members` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`is_public` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `user_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `organization_members_user_idx` ON `organization_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `organization_members_role_idx` ON `organization_members` (`organization_id`,`role`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`display_name` text(100),
	`description` text(500),
	`website_url` text(500),
	`location` text(100),
	`avatar_path` text(400),
	`default_repo_visibility` text DEFAULT 'private' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_namespace_key` ON `organizations` (`namespace_id`);--> statement-breakpoint
CREATE TABLE `package_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`version` text(128) NOT NULL,
	`storage_key` text(500) NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`sha256` text(64),
	`metadata` text DEFAULT '{}' NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`published_by_id` text,
	`yanked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `packages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`published_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `package_versions_pkg_version_key` ON `package_versions` (`package_id`,`version`);--> statement-breakpoint
CREATE TABLE `packages` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_namespace_id` text NOT NULL,
	`repository_id` text,
	`format` text(32) NOT NULL,
	`name` text(255) NOT NULL,
	`description` text(500),
	`visibility` text DEFAULT 'private' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packages_owner_format_name_key` ON `packages` (`owner_namespace_id`,`format`,`name`);--> statement-breakpoint
CREATE TABLE `platform_settings` (
	`key` text(64) PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `project_boards` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text,
	`organization_id` text,
	`number` integer NOT NULL,
	`name` text(200) NOT NULL,
	`description` text(1000),
	`is_closed` integer DEFAULT false NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_boards_repo_number_key` ON `project_boards` (`repository_id`,`number`);--> statement-breakpoint
CREATE INDEX `project_boards_org_idx` ON `project_boards` (`organization_id`);--> statement-breakpoint
CREATE TABLE `project_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`column_id` text NOT NULL,
	`note` text,
	`issue_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`column_id`) REFERENCES `project_columns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `project_cards_column_idx` ON `project_cards` (`column_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_cards_issue_key` ON `project_cards` (`column_id`,`issue_id`);--> statement-breakpoint
CREATE TABLE `project_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text(100) NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`is_done_column` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `project_boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_columns_board_idx` ON `project_columns` (`board_id`,`position`);--> statement-breakpoint
CREATE TABLE `pull_request_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`reviewer_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`body` text,
	`commit_sha` text(40),
	`submitted_at` integer,
	`dismissed_at` integer,
	`dismissed_reason` text(500),
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `pull_request_reviews_issue_idx` ON `pull_request_reviews` (`issue_id`);--> statement-breakpoint
CREATE INDEX `pull_request_reviews_reviewer_idx` ON `pull_request_reviews` (`reviewer_id`);--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`issue_id` text PRIMARY KEY NOT NULL,
	`base_repository_id` text NOT NULL,
	`base_branch` text(255) NOT NULL,
	`base_sha` text(40),
	`head_repository_id` text,
	`head_branch` text(255) NOT NULL,
	`head_sha` text(40),
	`is_draft` integer DEFAULT false NOT NULL,
	`mergeable_state` text DEFAULT 'unknown' NOT NULL,
	`merge_checked_sha` text(40),
	`merged_at` integer,
	`merged_by_id` text,
	`merge_strategy` text,
	`merge_commit_sha` text(40),
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`changed_files` integer DEFAULT 0 NOT NULL,
	`commit_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`base_repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`head_repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`merged_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `pull_requests_base_idx` ON `pull_requests` (`base_repository_id`,`base_branch`);--> statement-breakpoint
CREATE INDEX `pull_requests_head_idx` ON `pull_requests` (`head_repository_id`,`head_branch`);--> statement-breakpoint
CREATE TABLE `push_events` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`pusher_id` text,
	`ref_name` text(255) NOT NULL,
	`old_oid` text(40) NOT NULL,
	`new_oid` text(40) NOT NULL,
	`is_force_push` integer DEFAULT false NOT NULL,
	`commit_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pusher_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `push_events_repo_idx` ON `push_events` (`repository_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`subject_type` text(32) NOT NULL,
	`subject_id` text NOT NULL,
	`content` text(32) NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reactions_unique_key` ON `reactions` (`user_id`,`subject_type`,`subject_id`,`content`);--> statement-breakpoint
CREATE INDEX `reactions_subject_idx` ON `reactions` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `release_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`label` text(255),
	`storage_key` text(500) NOT NULL,
	`content_type` text(128),
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`sha256` text(64),
	`download_count` integer DEFAULT 0 NOT NULL,
	`uploaded_by_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_assets_release_name_key` ON `release_assets` (`release_id`,`name`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`tag_name` text(255) NOT NULL,
	`target_commitish` text(255),
	`name` text(255),
	`body` text,
	`is_draft` integer DEFAULT false NOT NULL,
	`is_prerelease` integer DEFAULT false NOT NULL,
	`author_id` text,
	`published_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `releases_repo_tag_key` ON `releases` (`repository_id`,`tag_name`);--> statement-breakpoint
CREATE INDEX `releases_repo_published_idx` ON `releases` (`repository_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_namespace_id` text NOT NULL,
	`name` text(100) NOT NULL,
	`name_lower` text(100) NOT NULL,
	`description` text(500),
	`visibility` text DEFAULT 'private' NOT NULL,
	`default_branch` text(255) DEFAULT 'main' NOT NULL,
	`is_empty` integer DEFAULT true NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`is_template` integer DEFAULT false NOT NULL,
	`is_mirror` integer DEFAULT false NOT NULL,
	`is_fork` integer DEFAULT false NOT NULL,
	`parent_id` text,
	`website_url` text(500),
	`topics` text DEFAULT '[]' NOT NULL,
	`primary_language` text(50),
	`languages` text DEFAULT '{}' NOT NULL,
	`has_issues` integer DEFAULT true NOT NULL,
	`has_pull_requests` integer DEFAULT true NOT NULL,
	`has_wiki` integer DEFAULT true NOT NULL,
	`has_actions` integer DEFAULT true NOT NULL,
	`has_releases` integer DEFAULT true NOT NULL,
	`allow_merge_commit` integer DEFAULT true NOT NULL,
	`allow_squash_merge` integer DEFAULT true NOT NULL,
	`allow_rebase_merge` integer DEFAULT true NOT NULL,
	`delete_branch_on_merge` integer DEFAULT false NOT NULL,
	`star_count` integer DEFAULT 0 NOT NULL,
	`fork_count` integer DEFAULT 0 NOT NULL,
	`watcher_count` integer DEFAULT 0 NOT NULL,
	`open_issue_count` integer DEFAULT 0 NOT NULL,
	`open_pull_request_count` integer DEFAULT 0 NOT NULL,
	`issue_counter` integer DEFAULT 0 NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`pushed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parent_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_owner_name_key` ON `repositories` (`owner_namespace_id`,`name_lower`);--> statement-breakpoint
CREATE INDEX `repositories_visibility_idx` ON `repositories` (`visibility`,`updated_at`);--> statement-breakpoint
CREATE INDEX `repositories_parent_idx` ON `repositories` (`parent_id`);--> statement-breakpoint
CREATE INDEX `repositories_language_idx` ON `repositories` (`primary_language`);--> statement-breakpoint
CREATE TABLE `repository_collaborators` (
	`repository_id` text NOT NULL,
	`user_id` text NOT NULL,
	`permission` text DEFAULT 'read' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`repository_id`, `user_id`),
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `repository_collaborators_user_idx` ON `repository_collaborators` (`user_id`);--> statement-breakpoint
CREATE TABLE `repository_mirrors` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`direction` text NOT NULL,
	`remote_url` text(1000) NOT NULL,
	`remote_username` text(200),
	`token_enc` text,
	`is_enabled` integer DEFAULT true NOT NULL,
	`is_exact_copy` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_sync_at` integer,
	`last_error` text,
	`lease_expires_at` integer,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repository_mirrors_repo_direction_key` ON `repository_mirrors` (`repository_id`,`direction`);--> statement-breakpoint
CREATE INDEX `repository_mirrors_pull_idx` ON `repository_mirrors` (`direction`,`is_enabled`,`last_sync_at`);--> statement-breakpoint
CREATE TABLE `review_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text,
	`issue_id` text NOT NULL,
	`author_id` text,
	`body` text NOT NULL,
	`path` text(1000) NOT NULL,
	`line` integer,
	`start_line` integer,
	`diff_side` text(8) DEFAULT 'right' NOT NULL,
	`commit_sha` text(40) NOT NULL,
	`reply_to_id` text,
	`is_resolved` integer DEFAULT false NOT NULL,
	`resolved_by_id` text,
	`edited_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `pull_request_reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reply_to_id`) REFERENCES `review_comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `review_comments_issue_idx` ON `review_comments` (`issue_id`);--> statement-breakpoint
CREATE INDEX `review_comments_review_idx` ON `review_comments` (`review_id`);--> statement-breakpoint
CREATE TABLE `review_requests` (
	`issue_id` text NOT NULL,
	`reviewer_id` text,
	`team_id` text,
	`requested_by_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `review_requests_issue_idx` ON `review_requests` (`issue_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_requests_user_key` ON `review_requests` (`issue_id`,`reviewer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_requests_team_key` ON `review_requests` (`issue_id`,`team_id`);--> statement-breakpoint
CREATE TABLE `runners` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text(255) NOT NULL,
	`repository_id` text,
	`organization_id` text,
	`token_hash` text(64) NOT NULL,
	`labels` text DEFAULT '["self-hosted"]' NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`os_name` text(64),
	`architecture` text(32),
	`version` text(32),
	`last_seen_at` integer,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runners_token_key` ON `runners` (`token_hash`);--> statement-breakpoint
CREATE INDEX `runners_scope_idx` ON `runners` (`repository_id`,`organization_id`);--> statement-breakpoint
CREATE INDEX `runners_status_idx` ON `runners` (`status`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text,
	`organization_id` text,
	`environment` text(64),
	`name` text(128) NOT NULL,
	`value_enc` text NOT NULL,
	`created_by_id` text,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_repo_env_name_key` ON `secrets` (`repository_id`,`environment`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_org_env_name_key` ON `secrets` (`organization_id`,`environment`,`name`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text(64) NOT NULL,
	`credential_version` integer NOT NULL,
	`user_agent` text(400),
	`ip_address` text(45),
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_key` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `ssh_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text(100) NOT NULL,
	`fingerprint` text(64) NOT NULL,
	`public_key` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ssh_keys_fingerprint_key` ON `ssh_keys` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `ssh_keys_user_idx` ON `ssh_keys` (`user_id`);--> statement-breakpoint
CREATE TABLE `stars` (
	`user_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `repository_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stars_repo_idx` ON `stars` (`repository_id`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`is_maintainer` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_members_user_idx` ON `team_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `team_repositories` (
	`team_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`permission` text DEFAULT 'read' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`team_id`, `repository_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_repositories_repo_idx` ON `team_repositories` (`repository_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text(100) NOT NULL,
	`slug` text(100) NOT NULL,
	`description` text(500),
	`default_permission` text DEFAULT 'read' NOT NULL,
	`is_all_members` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_org_slug_key` ON `teams` (`organization_id`,`slug`);--> statement-breakpoint
CREATE TABLE `user_blocks` (
	`blocker_id` text NOT NULL,
	`blocked_id` text NOT NULL,
	`reason` text(500),
	`created_at` integer NOT NULL,
	PRIMARY KEY(`blocker_id`, `blocked_id`),
	FOREIGN KEY (`blocker_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocked_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_blocks_blocked_idx` ON `user_blocks` (`blocked_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text NOT NULL,
	`email` text(320) NOT NULL,
	`email_lower` text(320) NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`email_public` integer DEFAULT false NOT NULL,
	`password_hash` text NOT NULL,
	`credential_version` integer DEFAULT 1 NOT NULL,
	`display_name` text(100),
	`bio` text(500),
	`company` text(100),
	`location` text(100),
	`website_url` text(500),
	`social_links` text DEFAULT '[]' NOT NULL,
	`avatar_path` text(400),
	`is_admin` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`suspended_at` integer,
	`suspended_reason` text(500),
	`two_factor_enabled` integer DEFAULT false NOT NULL,
	`two_factor_secret_enc` text,
	`two_factor_recovery_hashes` text DEFAULT '[]' NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespaces`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_namespace_key` ON `users` (`namespace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_lower_key` ON `users` (`email_lower`);--> statement-breakpoint
CREATE TABLE `variables` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text,
	`organization_id` text,
	`environment` text(64),
	`name` text(128) NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variables_repo_env_name_key` ON `variables` (`repository_id`,`environment`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `variables_org_env_name_key` ON `variables` (`organization_id`,`environment`,`name`);--> statement-breakpoint
CREATE TABLE `verification_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text(32) NOT NULL,
	`token_hash` text(64) NOT NULL,
	`payload` text(320),
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_tokens_hash_key` ON `verification_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `verification_tokens_user_idx` ON `verification_tokens` (`user_id`,`purpose`);--> statement-breakpoint
CREATE TABLE `watches` (
	`user_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`level` text(16) DEFAULT 'all' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `repository_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `watches_repo_idx` ON `watches` (`repository_id`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event` text(48) NOT NULL,
	`request_body` text NOT NULL,
	`response_status` integer,
	`response_body` text,
	`duration_ms` integer,
	`error` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_hook_idx` ON `webhook_deliveries` (`webhook_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text,
	`organization_id` text,
	`url` text(1000) NOT NULL,
	`secret_enc` text,
	`content_type` text(64) DEFAULT 'application/json' NOT NULL,
	`events` text DEFAULT '["push"]' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `webhooks_repo_idx` ON `webhooks` (`repository_id`);--> statement-breakpoint
CREATE INDEX `webhooks_org_idx` ON `webhooks` (`organization_id`);--> statement-breakpoint
CREATE TABLE `workflow_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`storage_key` text(500) NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`content_type` text(128),
	`sha256` text(64),
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_artifacts_run_name_key` ON `workflow_artifacts` (`run_id`,`name`);--> statement-breakpoint
CREATE TABLE `workflow_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`job_key` text(255) NOT NULL,
	`name` text(255) NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`required_labels` text DEFAULT '[]' NOT NULL,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`runner_id` text,
	`lease_expires_at` integer,
	`timeout_minutes` integer DEFAULT 60 NOT NULL,
	`exit_code` integer,
	`error_message` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_jobs_run_key` ON `workflow_jobs` (`run_id`,`job_key`);--> statement-breakpoint
CREATE INDEX `workflow_jobs_queue_idx` ON `workflow_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `workflow_jobs_runner_idx` ON `workflow_jobs` (`runner_id`);--> statement-breakpoint
CREATE INDEX `workflow_jobs_lease_idx` ON `workflow_jobs` (`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `workflow_log_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`step_number` integer,
	`sequence` integer NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `workflow_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_log_chunks_job_seq_key` ON `workflow_log_chunks` (`job_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`workflow_id` text,
	`run_number` integer NOT NULL,
	`run_attempt` integer DEFAULT 1 NOT NULL,
	`event` text(48) NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`head_branch` text(255),
	`head_sha` text(40) NOT NULL,
	`definition` text NOT NULL,
	`triggered_by_id` text,
	`issue_id` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`triggered_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_runs_repo_number_key` ON `workflow_runs` (`repository_id`,`run_number`,`run_attempt`);--> statement-breakpoint
CREATE INDEX `workflow_runs_repo_status_idx` ON `workflow_runs` (`repository_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `workflow_runs_sha_idx` ON `workflow_runs` (`repository_id`,`head_sha`);--> statement-breakpoint
CREATE TABLE `workflow_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`step_number` integer NOT NULL,
	`name` text(255) NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`exit_code` integer,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `workflow_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_steps_job_number_key` ON `workflow_steps` (`job_id`,`step_number`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`path` text(500) NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`parse_error` text,
	`schedules` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_repo_path_key` ON `workflows` (`repository_id`,`path`);