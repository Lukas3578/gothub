/**
 * Forge – Datenbankschema (PostgreSQL / Drizzle ORM)
 *
 * Leitlinien:
 *
 * 1. Git ist die alleinige Quelle der Wahrheit für Commits, Trees, Blobs und
 *    Refs. Tabellen wie `commitIndex` sind ausdrücklich nur Suchindizes und
 *    dürfen nie als Primärquelle gelesen werden. Wird ein Index inkonsistent,
 *    wird er aus dem Repository neu aufgebaut.
 *
 * 2. Benutzer und Organisationen teilen sich einen Namensraum, damit die Route
 *    /:owner eindeutig auflösbar bleibt. Durchgesetzt wird das über die
 *    Tabelle `namespaces` mit einem UNIQUE-Index auf dem kleingeschriebenen
 *    Namen – nicht über Anwendungslogik, die man vergessen kann.
 *
 * 3. Issues und Pull Requests teilen sich pro Repository einen Nummernkreis.
 *    Deshalb liegen beide in `issues`; PR-spezifische Felder stehen in der
 *    1:1-Erweiterung `pullRequests`.
 */

import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const namespaceKindEnum = pgEnum('namespace_kind', ['user', 'organization']);
export const repoVisibilityEnum = pgEnum('repo_visibility', ['public', 'private', 'internal']);
export const accessLevelEnum = pgEnum('access_level', ['read', 'triage', 'write', 'maintain', 'admin']);
export const orgRoleEnum = pgEnum('org_role', ['member', 'admin', 'owner']);
export const issueKindEnum = pgEnum('issue_kind', ['issue', 'pull_request']);
export const issueStateEnum = pgEnum('issue_state', ['open', 'closed']);
export const issueCloseReasonEnum = pgEnum('issue_close_reason', ['completed', 'not_planned', 'duplicate', 'merged']);
export const mergeStrategyEnum = pgEnum('merge_strategy', ['merge', 'squash', 'rebase']);
export const mergeableStateEnum = pgEnum('mergeable_state', ['unknown', 'clean', 'conflicted', 'behind', 'blocked']);
export const reviewStateEnum = pgEnum('review_state', ['pending', 'commented', 'approved', 'changes_requested', 'dismissed']);
export const runStatusEnum = pgEnum('run_status', [
  'queued',
  'waiting',
  'running',
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'skipped',
]);
export const runnerStatusEnum = pgEnum('runner_status', ['offline', 'idle', 'busy', 'disabled']);
export const notificationReasonEnum = pgEnum('notification_reason', [
  'assign',
  'author',
  'comment',
  'mention',
  'review_requested',
  'state_change',
  'subscribed',
  'workflow_failure',
]);
export const webhookEventEnum = pgEnum('webhook_event', [
  'push',
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'release',
  'workflow_run',
]);
export const auditActorTypeEnum = pgEnum('audit_actor_type', ['user', 'system', 'runner']);

// ---------------------------------------------------------------------------
// Namensraum
// ---------------------------------------------------------------------------

/**
 * Gemeinsame Registry für Benutzer- und Organisationsnamen.
 * `nameLower` trägt den UNIQUE-Index, damit Groß-/Kleinschreibung nicht zu
 * zwei verschiedenen Besitzern mit faktisch gleichem Namen führen kann.
 */
export const namespaces = pgTable(
  'namespaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 39 }).notNull(),
    nameLower: varchar('name_lower', { length: 39 }).notNull(),
    kind: namespaceKindEnum('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('namespaces_name_lower_key').on(t.nameLower)],
);

// ---------------------------------------------------------------------------
// Benutzer
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    namespaceId: uuid('namespace_id')
      .notNull()
      .references(() => namespaces.id, { onDelete: 'restrict' }),

    email: varchar('email', { length: 320 }).notNull(),
    emailLower: varchar('email_lower', { length: 320 }).notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    /** Steuert, ob die E-Mail auf dem öffentlichen Profil erscheint. */
    emailPublic: boolean('email_public').notNull().default(false),

    /** Argon2id-Hash. Enthält Salt und Parameter; keine separate Salt-Spalte nötig. */
    passwordHash: text('password_hash').notNull(),
    /**
     * Wird bei Passwortwechsel hochgezählt. Sessions mit abweichendem Wert
     * gelten als ungültig – dadurch beendet ein Passwortwechsel alle Sessions,
     * ohne dass ein separater Löschlauf nötig ist.
     */
    credentialVersion: integer('credential_version').notNull().default(1),

    displayName: varchar('display_name', { length: 100 }),
    bio: varchar('bio', { length: 500 }),
    company: varchar('company', { length: 100 }),
    location: varchar('location', { length: 100 }),
    websiteUrl: varchar('website_url', { length: 500 }),
    socialLinks: jsonb('social_links').$type<{ label: string; url: string }[]>().notNull().default(sql`'[]'::jsonb`),
    avatarPath: varchar('avatar_path', { length: 400 }),

    isAdmin: boolean('is_admin').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    /** Gesetzt, wenn ein Administrator den Account gesperrt hat. */
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspendedReason: varchar('suspended_reason', { length: 500 }),

    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    /** TOTP-Seed, AES-256-GCM-verschlüsselt mit ENCRYPTION_KEY. Niemals im Klartext. */
    twoFactorSecretEnc: text('two_factor_secret_enc'),
    /** Argon2-Hashes der Wiederherstellungscodes. */
    twoFactorRecoveryHashes: jsonb('two_factor_recovery_hashes').$type<string[]>().notNull().default(sql`'[]'::jsonb`),

    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_namespace_key').on(t.namespaceId),
    uniqueIndex('users_email_lower_key').on(t.emailLower),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * SHA-256 des Session-Tokens. Das Token selbst wird nie gespeichert – ein
     * Datenbankleck erlaubt dadurch keine Session-Übernahme.
     */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    credentialVersion: integer('credential_version').notNull(),
    userAgent: varchar('user_agent', { length: 400 }),
    ipAddress: varchar('ip_address', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
);

/** Kurzlebige Tokens für E-Mail-Verifizierung und Passwort-Reset. */
export const verificationTokens = pgTable(
  'verification_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: varchar('purpose', { length: 32 }).notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /** Bei E-Mail-Wechsel die neue Adresse, die nach Bestätigung übernommen wird. */
    payload: varchar('payload', { length: 320 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('verification_tokens_hash_key').on(t.tokenHash),
    index('verification_tokens_user_idx').on(t.userId, t.purpose),
  ],
);

/** Persönliche Zugriffstokens für API und Git über HTTPS. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /** Die ersten Zeichen des Tokens, damit Benutzer es in der Liste wiedererkennen. */
    tokenPrefix: varchar('token_prefix', { length: 16 }).notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_tokens_hash_key').on(t.tokenHash), index('api_tokens_user_idx').on(t.userId)],
);

export const sshKeys = pgTable(
  'ssh_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 100 }).notNull(),
    /** SHA-256-Fingerprint im OpenSSH-Format, Basis für die Zuordnung beim Login. */
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    publicKey: text('public_key').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ssh_keys_fingerprint_key').on(t.fingerprint), index('ssh_keys_user_idx').on(t.userId)],
);

export const userBlocks = pgTable(
  'user_blocks',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: varchar('reason', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), index('user_blocks_blocked_idx').on(t.blockedId)],
);

export const follows = pgTable(
  'follows',
  {
    followerId: uuid('follower_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followingId: uuid('following_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.followerId, t.followingId] }), index('follows_following_idx').on(t.followingId)],
);

export const abuseReports = pgTable(
  'abuse_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reporterId: uuid('reporter_id').references(() => users.id, { onDelete: 'set null' }),
    /** 'user' | 'repository' | 'issue' | 'comment' */
    subjectType: varchar('subject_type', { length: 32 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    reason: varchar('reason', { length: 64 }).notNull(),
    details: text('details'),
    status: varchar('status', { length: 32 }).notNull().default('open'),
    resolvedById: uuid('resolved_by_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('abuse_reports_status_idx').on(t.status, t.createdAt), index('abuse_reports_subject_idx').on(t.subjectType, t.subjectId)],
);

// ---------------------------------------------------------------------------
// Organisationen und Teams
// ---------------------------------------------------------------------------

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    namespaceId: uuid('namespace_id')
      .notNull()
      .references(() => namespaces.id, { onDelete: 'restrict' }),
    displayName: varchar('display_name', { length: 100 }),
    description: varchar('description', { length: 500 }),
    websiteUrl: varchar('website_url', { length: 500 }),
    location: varchar('location', { length: 100 }),
    avatarPath: varchar('avatar_path', { length: 400 }),
    /**
     * Standard-Sichtbarkeit für neu erstellte Repositories dieser Organisation.
     * Verhindert, dass interner Code versehentlich öffentlich wird.
     */
    defaultRepoVisibility: repoVisibilityEnum('default_repo_visibility').notNull().default('private'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('organizations_namespace_key').on(t.namespaceId)],
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRoleEnum('role').notNull().default('member'),
    /** Steuert, ob die Mitgliedschaft auf dem öffentlichen Profil sichtbar ist. */
    isPublic: boolean('is_public').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    index('organization_members_user_idx').on(t.userId),
    index('organization_members_role_idx').on(t.organizationId, t.role),
  ],
);

export const organizationInvitations = pgTable(
  'organization_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Gesetzt, wenn ein bestehender Account eingeladen wird. */
    inviteeId: uuid('invitee_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Gesetzt, wenn per E-Mail eingeladen wird und noch kein Account existiert. */
    inviteeEmail: varchar('invitee_email', { length: 320 }),
    role: orgRoleEnum('role').notNull().default('member'),
    invitedById: uuid('invited_by_id').references(() => users.id, { onDelete: 'set null' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('organization_invitations_token_key').on(t.tokenHash),
    index('organization_invitations_org_idx').on(t.organizationId),
  ],
);

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull(),
    description: varchar('description', { length: 500 }),
    /** Berechtigung, die Mitglieder auf zugeordnete Repositories erhalten. */
    defaultPermission: accessLevelEnum('default_permission').notNull().default('read'),
    /** Spezialteam, das automatisch alle Organisationsmitglieder enthält. */
    isAllMembers: boolean('is_all_members').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('teams_org_slug_key').on(t.organizationId, t.slug)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    isMaintainer: boolean('is_maintainer').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] }), index('team_members_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Besitzer – Benutzer oder Organisation, aufgelöst über den Namensraum. */
    ownerNamespaceId: uuid('owner_namespace_id')
      .notNull()
      .references(() => namespaces.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 100 }).notNull(),
    nameLower: varchar('name_lower', { length: 100 }).notNull(),
    description: varchar('description', { length: 500 }),
    visibility: repoVisibilityEnum('visibility').notNull().default('private'),

    defaultBranch: varchar('default_branch', { length: 255 }).notNull().default('main'),
    /** True, solange noch kein Commit gepusht wurde. Steuert die Repo-Startseite. */
    isEmpty: boolean('is_empty').notNull().default(true),
    isArchived: boolean('is_archived').notNull().default(false),
    isTemplate: boolean('is_template').notNull().default(false),
    isMirror: boolean('is_mirror').notNull().default(false),

    isFork: boolean('is_fork').notNull().default(false),
    parentId: uuid('parent_id').references((): any => repositories.id, { onDelete: 'set null' }),

    websiteUrl: varchar('website_url', { length: 500 }),
    topics: jsonb('topics').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    primaryLanguage: varchar('primary_language', { length: 50 }),
    /** Byte-Anteile je Sprache, aus dem Dateibaum berechnet. */
    languages: jsonb('languages').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),

    hasIssues: boolean('has_issues').notNull().default(true),
    hasPullRequests: boolean('has_pull_requests').notNull().default(true),
    hasWiki: boolean('has_wiki').notNull().default(true),
    hasActions: boolean('has_actions').notNull().default(true),
    hasReleases: boolean('has_releases').notNull().default(true),

    allowMergeCommit: boolean('allow_merge_commit').notNull().default(true),
    allowSquashMerge: boolean('allow_squash_merge').notNull().default(true),
    allowRebaseMerge: boolean('allow_rebase_merge').notNull().default(true),
    deleteBranchOnMerge: boolean('delete_branch_on_merge').notNull().default(false),

    /**
     * Zähler werden denormalisiert gehalten, weil sie auf Listenseiten für jedes
     * Repository gebraucht werden. Aktualisierung erfolgt transaktional
     * zusammen mit der auslösenden Änderung.
     */
    starCount: integer('star_count').notNull().default(0),
    forkCount: integer('fork_count').notNull().default(0),
    watcherCount: integer('watcher_count').notNull().default(0),
    openIssueCount: integer('open_issue_count').notNull().default(0),
    openPullRequestCount: integer('open_pull_request_count').notNull().default(0),
    /** Laufende Nummer für den gemeinsamen Issue-/PR-Nummernkreis. */
    issueCounter: integer('issue_counter').notNull().default(0),

    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),

    pushedAt: timestamp('pushed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft Delete: erlaubt Wiederherstellung und verhindert Namens-Recycling-Angriffe. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('repositories_owner_name_key').on(t.ownerNamespaceId, t.nameLower),
    index('repositories_visibility_idx').on(t.visibility, t.updatedAt),
    index('repositories_parent_idx').on(t.parentId),
    index('repositories_language_idx').on(t.primaryLanguage),
  ],
);

/** Direkt auf einen Benutzer vergebene Repository-Rechte (ohne Team-Umweg). */
export const repositoryCollaborators = pgTable(
  'repository_collaborators',
  {
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permission: accessLevelEnum('permission').notNull().default('read'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.userId] }),
    index('repository_collaborators_user_idx').on(t.userId),
  ],
);

/** Repository-Zugriff für ein Team einer Organisation. */
export const teamRepositories = pgTable(
  'team_repositories',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    permission: accessLevelEnum('permission').notNull().default('read'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.repositoryId] }),
    index('team_repositories_repo_idx').on(t.repositoryId),
  ],
);

export const branchProtections = pgTable(
  'branch_protections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** Glob-Muster, z. B. "main" oder "release/*". */
    pattern: varchar('pattern', { length: 255 }).notNull(),
    requirePullRequest: boolean('require_pull_request').notNull().default(true),
    requiredApprovals: smallint('required_approvals').notNull().default(1),
    dismissStaleReviews: boolean('dismiss_stale_reviews').notNull().default(false),
    requireStatusChecks: boolean('require_status_checks').notNull().default(false),
    requiredStatusChecks: jsonb('required_status_checks').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    requireLinearHistory: boolean('require_linear_history').notNull().default(false),
    /** Verbietet force-push auf passende Branches. */
    blockForcePush: boolean('block_force_push').notNull().default(true),
    blockDeletion: boolean('block_deletion').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('branch_protections_repo_pattern_key').on(t.repositoryId, t.pattern)],
);

export const stars = pgTable(
  'stars',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.repositoryId] }), index('stars_repo_idx').on(t.repositoryId)],
);

export const watches = pgTable(
  'watches',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** 'all' | 'participating' | 'ignore' */
    level: varchar('level', { length: 16 }).notNull().default('all'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.repositoryId] }), index('watches_repo_idx').on(t.repositoryId)],
);

/**
 * Suchindex für Commits. KEINE Quelle der Wahrheit – wird aus dem Git-Repository
 * befüllt und kann jederzeit verworfen und neu aufgebaut werden.
 */
export const commitIndex = pgTable(
  'commit_index',
  {
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    oid: varchar('oid', { length: 40 }).notNull(),
    authorName: varchar('author_name', { length: 255 }).notNull(),
    authorEmail: varchar('author_email', { length: 320 }).notNull(),
    /** Zuordnung zum Plattform-Account über verifizierte E-Mail, sofern möglich. */
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    committedAt: timestamp('committed_at', { withTimezone: true }).notNull(),
    subject: varchar('subject', { length: 500 }).notNull(),
    body: text('body'),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    filesChanged: integer('files_changed').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.oid] }),
    index('commit_index_repo_date_idx').on(t.repositoryId, t.committedAt),
    index('commit_index_author_idx').on(t.authorUserId, t.committedAt),
  ],
);

/** Push-Historie, Grundlage für Aktivitäts-Feeds und Audit. */
export const pushEvents = pgTable(
  'push_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    pusherId: uuid('pusher_id').references(() => users.id, { onDelete: 'set null' }),
    refName: varchar('ref_name', { length: 255 }).notNull(),
    oldOid: varchar('old_oid', { length: 40 }).notNull(),
    newOid: varchar('new_oid', { length: 40 }).notNull(),
    isForcePush: boolean('is_force_push').notNull().default(false),
    commitCount: integer('commit_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('push_events_repo_idx').on(t.repositoryId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Issues und Pull Requests
// ---------------------------------------------------------------------------

export const labels = pgTable(
  'labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    /** Hex-Farbe ohne führendes #. */
    color: varchar('color', { length: 6 }).notNull().default('6b7280'),
    description: varchar('description', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('labels_repo_name_key').on(t.repositoryId, t.name)],
);

export const milestones = pgTable(
  'milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    dueOn: timestamp('due_on', { withTimezone: true }),
    state: issueStateEnum('state').notNull().default('open'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('milestones_repo_number_key').on(t.repositoryId, t.number)],
);

export const issues = pgTable(
  'issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** Pro Repository fortlaufend, gemeinsam für Issues und Pull Requests. */
    number: integer('number').notNull(),
    kind: issueKindEnum('kind').notNull().default('issue'),
    title: varchar('title', { length: 500 }).notNull(),
    body: text('body'),
    state: issueStateEnum('state').notNull().default('open'),
    closeReason: issueCloseReasonEnum('close_reason'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    milestoneId: uuid('milestone_id').references(() => milestones.id, { onDelete: 'set null' }),
    isLocked: boolean('is_locked').notNull().default(false),
    commentCount: integer('comment_count').notNull().default(0),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedById: uuid('closed_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('issues_repo_number_key').on(t.repositoryId, t.number),
    index('issues_repo_state_idx').on(t.repositoryId, t.kind, t.state, t.updatedAt),
    index('issues_author_idx').on(t.authorId, t.createdAt),
    index('issues_milestone_idx').on(t.milestoneId),
  ],
);

export const pullRequests = pgTable(
  'pull_requests',
  {
    /** 1:1-Erweiterung von `issues`. */
    issueId: uuid('issue_id')
      .primaryKey()
      .references(() => issues.id, { onDelete: 'cascade' }),

    baseRepositoryId: uuid('base_repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    baseBranch: varchar('base_branch', { length: 255 }).notNull(),
    baseSha: varchar('base_sha', { length: 40 }),

    /** Null, wenn das Fork-Repository nach dem Öffnen gelöscht wurde. */
    headRepositoryId: uuid('head_repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    headBranch: varchar('head_branch', { length: 255 }).notNull(),
    headSha: varchar('head_sha', { length: 40 }),

    isDraft: boolean('is_draft').notNull().default(false),
    mergeableState: mergeableStateEnum('mergeable_state').notNull().default('unknown'),
    /** Commit, in dem der Testmerge berechnet wurde – Cache-Invalidierung. */
    mergeCheckedSha: varchar('merge_checked_sha', { length: 40 }),

    mergedAt: timestamp('merged_at', { withTimezone: true }),
    mergedById: uuid('merged_by_id').references(() => users.id, { onDelete: 'set null' }),
    mergeStrategy: mergeStrategyEnum('merge_strategy'),
    mergeCommitSha: varchar('merge_commit_sha', { length: 40 }),

    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    changedFiles: integer('changed_files').notNull().default(0),
    commitCount: integer('commit_count').notNull().default(0),
  },
  (t) => [
    index('pull_requests_base_idx').on(t.baseRepositoryId, t.baseBranch),
    index('pull_requests_head_idx').on(t.headRepositoryId, t.headBranch),
  ],
);

export const issueLabels = pgTable(
  'issue_labels',
  {
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.labelId] }), index('issue_labels_label_idx').on(t.labelId)],
);

export const issueAssignees = pgTable(
  'issue_assignees',
  {
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.userId] }), index('issue_assignees_user_idx').on(t.userId)],
);

export const issueComments = pgTable(
  'issue_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('issue_comments_issue_idx').on(t.issueId, t.createdAt)],
);

/** Strukturierte Ereignisse im Issue-Verlauf (geschlossen, Label gesetzt, …). */
export const issueEvents = pgTable(
  'issue_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    eventType: varchar('event_type', { length: 48 }).notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('issue_events_issue_idx').on(t.issueId, t.createdAt)],
);

/** Verknüpfungen zwischen Issues (duplicate_of, blocks, relates_to, closes). */
export const issueLinks = pgTable(
  'issue_links',
  {
    sourceIssueId: uuid('source_issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    targetIssueId: uuid('target_issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    linkType: varchar('link_type', { length: 32 }).notNull(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceIssueId, t.targetIssueId, t.linkType] }),
    index('issue_links_target_idx').on(t.targetIssueId),
  ],
);

export const pullRequestReviews = pgTable(
  'pull_request_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    state: reviewStateEnum('state').notNull().default('pending'),
    body: text('body'),
    /** Commit, auf den sich das Review bezieht – für "stale review"-Erkennung. */
    commitSha: varchar('commit_sha', { length: 40 }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    dismissedReason: varchar('dismissed_reason', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pull_request_reviews_issue_idx').on(t.issueId), index('pull_request_reviews_reviewer_idx').on(t.reviewerId)],
);

export const reviewRequests = pgTable(
  'review_requests',
  {
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    /** Entweder ein einzelner Benutzer … */
    reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'cascade' }),
    /** … oder ein ganzes Team. */
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    requestedById: uuid('requested_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('review_requests_issue_idx').on(t.issueId),
    uniqueIndex('review_requests_user_key').on(t.issueId, t.reviewerId),
    uniqueIndex('review_requests_team_key').on(t.issueId, t.teamId),
  ],
);

export const reviewComments = pgTable(
  'review_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reviewId: uuid('review_id').references(() => pullRequestReviews.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    path: varchar('path', { length: 1000 }).notNull(),
    /** Zeile in der neuen Fassung; null bei Kommentaren auf gelöschte Zeilen. */
    line: integer('line'),
    startLine: integer('start_line'),
    /** 'left' = alte Fassung, 'right' = neue Fassung. */
    diffSide: varchar('diff_side', { length: 8 }).notNull().default('right'),
    commitSha: varchar('commit_sha', { length: 40 }).notNull(),
    /** Antworten innerhalb eines Threads. */
    replyToId: uuid('reply_to_id').references((): any => reviewComments.id, { onDelete: 'cascade' }),
    isResolved: boolean('is_resolved').notNull().default(false),
    resolvedById: uuid('resolved_by_id').references(() => users.id, { onDelete: 'set null' }),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('review_comments_issue_idx').on(t.issueId), index('review_comments_review_idx').on(t.reviewId)],
);

export const reactions = pgTable(
  'reactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'issue' | 'issue_comment' | 'review_comment' | 'release' */
    subjectType: varchar('subject_type', { length: 32 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    content: varchar('content', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('reactions_unique_key').on(t.userId, t.subjectType, t.subjectId, t.content),
    index('reactions_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

/** Vorlagen für Issues und Pull Requests, aus .forge/ im Repository gelesen. */
export const issueTemplates = pgTable(
  'issue_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    kind: issueKindEnum('kind').notNull().default('issue'),
    name: varchar('name', { length: 100 }).notNull(),
    about: varchar('about', { length: 300 }),
    titlePrefix: varchar('title_prefix', { length: 100 }),
    body: text('body').notNull(),
    defaultLabels: jsonb('default_labels').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    sourcePath: varchar('source_path', { length: 500 }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('issue_templates_repo_path_key').on(t.repositoryId, t.sourcePath)],
);

// ---------------------------------------------------------------------------
// CI/CD: Workflows, Runs, Runner
// ---------------------------------------------------------------------------

export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    /** Pfad innerhalb des Repositories, z. B. .forge/workflows/build.yml */
    path: varchar('path', { length: 500 }).notNull(),
    isEnabled: boolean('is_enabled').notNull().default(true),
    /** Letzter Validierungsfehler der YAML-Datei, null wenn gültig. */
    parseError: text('parse_error'),
    /** Cron-Ausdrücke aus dem `schedule`-Trigger, für den Scheduler. */
    schedules: jsonb('schedules').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workflows_repo_path_key').on(t.repositoryId, t.path)],
);

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
    /** Pro Repository fortlaufende Run-Nummer. */
    runNumber: integer('run_number').notNull(),
    /** Zählt hoch bei Wiederholung desselben Runs. */
    runAttempt: integer('run_attempt').notNull().default(1),
    /** 'push' | 'pull_request' | 'workflow_dispatch' | 'schedule' */
    event: varchar('event', { length: 48 }).notNull(),
    status: runStatusEnum('status').notNull().default('queued'),
    headBranch: varchar('head_branch', { length: 255 }),
    headSha: varchar('head_sha', { length: 40 }).notNull(),
    /** Snapshot der Workflow-Definition zum Zeitpunkt des Starts. */
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    triggeredById: uuid('triggered_by_id').references(() => users.id, { onDelete: 'set null' }),
    /** Bei pull_request-Trigger der auslösende PR. */
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('workflow_runs_repo_number_key').on(t.repositoryId, t.runNumber, t.runAttempt),
    index('workflow_runs_repo_status_idx').on(t.repositoryId, t.status, t.createdAt),
    index('workflow_runs_sha_idx').on(t.repositoryId, t.headSha),
  ],
);

export const workflowJobs = pgTable(
  'workflow_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    /** Schlüssel aus der YAML-Datei (jobs.<key>). */
    jobKey: varchar('job_key', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    status: runStatusEnum('status').notNull().default('queued'),
    /** Labels, die ein Runner erfüllen muss (runs-on). */
    requiredLabels: jsonb('required_labels').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** jobKeys, die vorher erfolgreich sein müssen (needs). */
    dependsOn: jsonb('depends_on').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Zugewiesener Runner; null solange der Job in der Warteschlange liegt. */
    runnerId: uuid('runner_id').references((): any => runners.id, { onDelete: 'set null' }),
    /**
     * Wird bei Zuweisung gesetzt und vom Runner per Heartbeat verlängert.
     * Läuft die Lease ab, gilt der Job als verwaist und wird neu eingereiht.
     */
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    timeoutMinutes: integer('timeout_minutes').notNull().default(60),
    exitCode: integer('exit_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('workflow_jobs_run_key').on(t.runId, t.jobKey),
    index('workflow_jobs_queue_idx').on(t.status, t.createdAt),
    index('workflow_jobs_runner_idx').on(t.runnerId),
    index('workflow_jobs_lease_idx').on(t.leaseExpiresAt),
  ],
);

export const workflowSteps = pgTable(
  'workflow_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => workflowJobs.id, { onDelete: 'cascade' }),
    stepNumber: integer('step_number').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    status: runStatusEnum('status').notNull().default('queued'),
    exitCode: integer('exit_code'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('workflow_steps_job_number_key').on(t.jobId, t.stepNumber)],
);

/**
 * Log-Zeilen werden blockweise gespeichert statt einzeln, um die Zeilenanzahl
 * beherrschbar zu halten. Ein Block fasst die Ausgabe eines Zeitfensters.
 */
export const workflowLogChunks = pgTable(
  'workflow_log_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => workflowJobs.id, { onDelete: 'cascade' }),
    stepNumber: integer('step_number'),
    /** Fortlaufend je Job, stellt die Reihenfolge sicher. */
    sequence: integer('sequence').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workflow_log_chunks_job_seq_key').on(t.jobId, t.sequence)],
);

export const workflowArtifacts = pgTable(
  'workflow_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    /** Pfad im Objektspeicher. Nie direkt an den Client ausgeliefert. */
    storageKey: varchar('storage_key', { length: 500 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    contentType: varchar('content_type', { length: 128 }),
    sha256: varchar('sha256', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workflow_artifacts_run_name_key').on(t.runId, t.name)],
);

export const runners = pgTable(
  'runners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    /**
     * Geltungsbereich. Ist beides null, handelt es sich um einen
     * plattformweiten Runner, den nur Administratoren registrieren dürfen.
     */
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    /** SHA-256 des Registrierungstokens. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    labels: jsonb('labels').$type<string[]>().notNull().default(sql`'["self-hosted"]'::jsonb`),
    status: runnerStatusEnum('status').notNull().default('offline'),
    osName: varchar('os_name', { length: 64 }),
    architecture: varchar('architecture', { length: 32 }),
    version: varchar('version', { length: 32 }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('runners_token_key').on(t.tokenHash),
    index('runners_scope_idx').on(t.repositoryId, t.organizationId),
    index('runners_status_idx').on(t.status, t.lastSeenAt),
  ],
);

/**
 * Secrets für Workflows. Der Wert ist AES-256-GCM-verschlüsselt und wird
 * ausschließlich an den Runner übergeben, der den zugehörigen Job ausführt –
 * nie über die API an das Frontend.
 */
export const secrets = pgTable(
  'secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    /** Optionale Umgebung (production, staging …). */
    environment: varchar('environment', { length: 64 }),
    name: varchar('name', { length: 128 }).notNull(),
    valueEnc: text('value_enc').notNull(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('secrets_repo_env_name_key').on(t.repositoryId, t.environment, t.name),
    uniqueIndex('secrets_org_env_name_key').on(t.organizationId, t.environment, t.name),
  ],
);

/** Nicht-geheime Umgebungsvariablen. Im Gegensatz zu Secrets lesbar. */
export const variables = pgTable(
  'variables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    environment: varchar('environment', { length: 64 }),
    name: varchar('name', { length: 128 }).notNull(),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('variables_repo_env_name_key').on(t.repositoryId, t.environment, t.name),
    uniqueIndex('variables_org_env_name_key').on(t.organizationId, t.environment, t.name),
  ],
);

// ---------------------------------------------------------------------------
// Releases und Packages
// ---------------------------------------------------------------------------

export const releases = pgTable(
  'releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    tagName: varchar('tag_name', { length: 255 }).notNull(),
    /** Branch oder Commit, auf dem das Tag erzeugt wurde. */
    targetCommitish: varchar('target_commitish', { length: 255 }),
    name: varchar('name', { length: 255 }),
    body: text('body'),
    isDraft: boolean('is_draft').notNull().default(false),
    isPrerelease: boolean('is_prerelease').notNull().default(false),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('releases_repo_tag_key').on(t.repositoryId, t.tagName),
    index('releases_repo_published_idx').on(t.repositoryId, t.publishedAt),
  ],
);

export const releaseAssets = pgTable(
  'release_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    label: varchar('label', { length: 255 }),
    storageKey: varchar('storage_key', { length: 500 }).notNull(),
    contentType: varchar('content_type', { length: 128 }),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    sha256: varchar('sha256', { length: 64 }),
    downloadCount: integer('download_count').notNull().default(0),
    uploadedById: uuid('uploaded_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('release_assets_release_name_key').on(t.releaseId, t.name)],
);

/**
 * Package-Registry. Bewusst formatneutral gehalten: `format` unterscheidet
 * npm, docker, maven usw., `metadata` nimmt formatspezifische Felder auf.
 * Dadurch lassen sich weitere Registries ergänzen, ohne das Schema zu ändern.
 */
export const packages = pgTable(
  'packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerNamespaceId: uuid('owner_namespace_id')
      .notNull()
      .references(() => namespaces.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    format: varchar('format', { length: 32 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: varchar('description', { length: 500 }),
    visibility: repoVisibilityEnum('visibility').notNull().default('private'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('packages_owner_format_name_key').on(t.ownerNamespaceId, t.format, t.name)],
);

export const packageVersions = pgTable(
  'package_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packages.id, { onDelete: 'cascade' }),
    version: varchar('version', { length: 128 }).notNull(),
    storageKey: varchar('storage_key', { length: 500 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    sha256: varchar('sha256', { length: 64 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    downloadCount: integer('download_count').notNull().default(0),
    publishedById: uuid('published_by_id').references(() => users.id, { onDelete: 'set null' }),
    yankedAt: timestamp('yanked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('package_versions_pkg_version_key').on(t.packageId, t.version)],
);

// ---------------------------------------------------------------------------
// Benachrichtigungen, Webhooks, Audit
// ---------------------------------------------------------------------------

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    /** 'issue' | 'pull_request' | 'workflow_run' | 'release' */
    subjectType: varchar('subject_type', { length: 32 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    reason: notificationReasonEnum('reason').notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    /** Relative URL innerhalb der Anwendung. */
    targetPath: varchar('target_path', { length: 1000 }).notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_unread_idx').on(t.userId, t.readAt, t.createdAt),
    index('notifications_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

export const notificationSettings = pgTable(
  'notification_settings',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    emailOnMention: boolean('email_on_mention').notNull().default(true),
    emailOnReviewRequest: boolean('email_on_review_request').notNull().default(true),
    emailOnAssign: boolean('email_on_assign').notNull().default(true),
    emailOnWorkflowFailure: boolean('email_on_workflow_failure').notNull().default(true),
    /** Automatisch Repositories beobachten, zu denen man Schreibrechte erhält. */
    autoWatchOnAccess: boolean('auto_watch_on_access').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    url: varchar('url', { length: 1000 }).notNull(),
    /** HMAC-SHA256-Schlüssel, verschlüsselt gespeichert. */
    secretEnc: text('secret_enc'),
    contentType: varchar('content_type', { length: 64 }).notNull().default('application/json'),
    events: jsonb('events').$type<string[]>().notNull().default(sql`'["push"]'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    /** Anzahl aufeinanderfolgender Fehlzustellungen; deaktiviert den Hook ab einem Grenzwert. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webhooks_repo_idx').on(t.repositoryId), index('webhooks_org_idx').on(t.organizationId)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    event: varchar('event', { length: 48 }).notNull(),
    requestBody: text('request_body').notNull(),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    attempt: integer('attempt').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webhook_deliveries_hook_idx').on(t.webhookId, t.createdAt)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorType: auditActorTypeEnum('actor_type').notNull().default('user'),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Maschinenlesbare Aktion, z. B. "repository.visibility_changed". */
    action: varchar('action', { length: 64 }).notNull(),
    /** Betroffenes Objekt. */
    targetType: varchar('target_type', { length: 32 }),
    targetId: uuid('target_id'),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: varchar('user_agent', { length: 400 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_actor_idx').on(t.actorId, t.createdAt),
    index('audit_logs_action_idx').on(t.action, t.createdAt),
    index('audit_logs_repo_idx').on(t.repositoryId, t.createdAt),
  ],
);

/** Plattformweite Einstellungen als Key-Value, vom Admin-Panel verwaltet. */
export const platformSettings = pgTable('platform_settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const namespacesRelations = relations(namespaces, ({ one, many }) => ({
  user: one(users, { fields: [namespaces.id], references: [users.namespaceId] }),
  organization: one(organizations, { fields: [namespaces.id], references: [organizations.namespaceId] }),
  repositories: many(repositories),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  namespace: one(namespaces, { fields: [users.namespaceId], references: [namespaces.id] }),
  sessions: many(sessions),
  apiTokens: many(apiTokens),
  sshKeys: many(sshKeys),
  organizationMemberships: many(organizationMembers),
  teamMemberships: many(teamMembers),
  collaborations: many(repositoryCollaborators),
  stars: many(stars),
  watches: many(watches),
  notifications: many(notifications),
}));

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  namespace: one(namespaces, { fields: [organizations.namespaceId], references: [namespaces.id] }),
  members: many(organizationMembers),
  teams: many(teams),
  invitations: many(organizationInvitations),
}));

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.organizationId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [organizationMembers.userId], references: [users.id] }),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  organization: one(organizations, { fields: [teams.organizationId], references: [organizations.id] }),
  members: many(teamMembers),
  repositories: many(teamRepositories),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, { fields: [teamMembers.teamId], references: [teams.id] }),
  user: one(users, { fields: [teamMembers.userId], references: [users.id] }),
}));

export const teamRepositoriesRelations = relations(teamRepositories, ({ one }) => ({
  team: one(teams, { fields: [teamRepositories.teamId], references: [teams.id] }),
  repository: one(repositories, { fields: [teamRepositories.repositoryId], references: [repositories.id] }),
}));

export const repositoriesRelations = relations(repositories, ({ one, many }) => ({
  ownerNamespace: one(namespaces, { fields: [repositories.ownerNamespaceId], references: [namespaces.id] }),
  parent: one(repositories, { fields: [repositories.parentId], references: [repositories.id], relationName: 'fork' }),
  forks: many(repositories, { relationName: 'fork' }),
  collaborators: many(repositoryCollaborators),
  teamAccess: many(teamRepositories),
  issues: many(issues),
  labels: many(labels),
  milestones: many(milestones),
  releases: many(releases),
  workflows: many(workflows),
  webhooks: many(webhooks),
  branchProtections: many(branchProtections),
}));

export const repositoryCollaboratorsRelations = relations(repositoryCollaborators, ({ one }) => ({
  repository: one(repositories, {
    fields: [repositoryCollaborators.repositoryId],
    references: [repositories.id],
  }),
  user: one(users, { fields: [repositoryCollaborators.userId], references: [users.id] }),
}));

export const issuesRelations = relations(issues, ({ one, many }) => ({
  repository: one(repositories, { fields: [issues.repositoryId], references: [repositories.id] }),
  author: one(users, { fields: [issues.authorId], references: [users.id] }),
  milestone: one(milestones, { fields: [issues.milestoneId], references: [milestones.id] }),
  pullRequest: one(pullRequests, { fields: [issues.id], references: [pullRequests.issueId] }),
  comments: many(issueComments),
  labels: many(issueLabels),
  assignees: many(issueAssignees),
  reviews: many(pullRequestReviews),
  events: many(issueEvents),
}));

export const pullRequestsRelations = relations(pullRequests, ({ one }) => ({
  issue: one(issues, { fields: [pullRequests.issueId], references: [issues.id] }),
  baseRepository: one(repositories, {
    fields: [pullRequests.baseRepositoryId],
    references: [repositories.id],
    relationName: 'base',
  }),
  headRepository: one(repositories, {
    fields: [pullRequests.headRepositoryId],
    references: [repositories.id],
    relationName: 'head',
  }),
  mergedBy: one(users, { fields: [pullRequests.mergedById], references: [users.id] }),
}));

export const issueCommentsRelations = relations(issueComments, ({ one }) => ({
  issue: one(issues, { fields: [issueComments.issueId], references: [issues.id] }),
  author: one(users, { fields: [issueComments.authorId], references: [users.id] }),
}));

export const issueLabelsRelations = relations(issueLabels, ({ one }) => ({
  issue: one(issues, { fields: [issueLabels.issueId], references: [issues.id] }),
  label: one(labels, { fields: [issueLabels.labelId], references: [labels.id] }),
}));

export const issueAssigneesRelations = relations(issueAssignees, ({ one }) => ({
  issue: one(issues, { fields: [issueAssignees.issueId], references: [issues.id] }),
  user: one(users, { fields: [issueAssignees.userId], references: [users.id] }),
}));

export const workflowRunsRelations = relations(workflowRuns, ({ one, many }) => ({
  repository: one(repositories, { fields: [workflowRuns.repositoryId], references: [repositories.id] }),
  workflow: one(workflows, { fields: [workflowRuns.workflowId], references: [workflows.id] }),
  triggeredBy: one(users, { fields: [workflowRuns.triggeredById], references: [users.id] }),
  jobs: many(workflowJobs),
  artifacts: many(workflowArtifacts),
}));

export const workflowJobsRelations = relations(workflowJobs, ({ one, many }) => ({
  run: one(workflowRuns, { fields: [workflowJobs.runId], references: [workflowRuns.id] }),
  runner: one(runners, { fields: [workflowJobs.runnerId], references: [runners.id] }),
  steps: many(workflowSteps),
  logChunks: many(workflowLogChunks),
}));

export const workflowStepsRelations = relations(workflowSteps, ({ one }) => ({
  job: one(workflowJobs, { fields: [workflowSteps.jobId], references: [workflowJobs.id] }),
}));

export const releasesRelations = relations(releases, ({ one, many }) => ({
  repository: one(repositories, { fields: [releases.repositoryId], references: [repositories.id] }),
  author: one(users, { fields: [releases.authorId], references: [users.id] }),
  assets: many(releaseAssets),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
  repository: one(repositories, { fields: [notifications.repositoryId], references: [repositories.id] }),
  actor: one(users, { fields: [notifications.actorId], references: [users.id] }),
}));

export const starsRelations = relations(stars, ({ one }) => ({
  user: one(users, { fields: [stars.userId], references: [users.id] }),
  repository: one(repositories, { fields: [stars.repositoryId], references: [repositories.id] }),
}));

export const watchesRelations = relations(watches, ({ one }) => ({
  user: one(users, { fields: [watches.userId], references: [users.id] }),
  repository: one(repositories, { fields: [watches.repositoryId], references: [repositories.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------
// Gists (Code-Schnipsel)
// ---------------------------------------------------------------------------

/**
 * Ein Gist ist ein kleines Repository ohne Issues, Branches und Rechtesystem.
 * Die Dateien liegen wie überall in Git – unter
 * <storage>/gists/<aa>/<bb>/<uuid>.git –, damit auch Schnipsel eine echte
 * Historie haben und sich klonen lassen.
 */
export const gists = pgTable(
  'gists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    description: varchar('description', { length: 500 }),
    /**
     * Gists kennen nur zwei Stufen: öffentlich oder nicht gelistet.
     * "Nicht gelistet" bedeutet: nicht in Listen, aber über die ID erreichbar –
     * deshalb heißt es nicht "privat", was eine Zugriffsprüfung verspräche,
     * die es hier nicht gibt.
     */
    isPublic: boolean('is_public').notNull().default(false),
    /** Vorschau der ersten Datei, damit Listen ohne Git-Zugriff auskommen. */
    primaryFilename: varchar('primary_filename', { length: 255 }),
    primaryLanguage: varchar('primary_language', { length: 50 }),
    fileCount: integer('file_count').notNull().default(0),
    forkOfId: uuid('fork_of_id').references((): any => gists.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('gists_owner_idx').on(t.ownerId, t.createdAt),
    index('gists_public_idx').on(t.isPublic, t.createdAt),
  ],
);

export const gistComments = pgTable(
  'gist_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gistId: uuid('gist_id')
      .notNull()
      .references(() => gists.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('gist_comments_gist_idx').on(t.gistId, t.createdAt)],
);

export const gistStars = pgTable(
  'gist_stars',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gistId: uuid('gist_id')
      .notNull()
      .references(() => gists.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.gistId] }), index('gist_stars_gist_idx').on(t.gistId)],
);

// ---------------------------------------------------------------------------
// Projektboards
// ---------------------------------------------------------------------------

export const projectBoards = pgTable(
  'project_boards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Ein Board gehört entweder zu einem Repository oder zu einer Organisation. */
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    number: integer('number').notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    description: varchar('description', { length: 1000 }),
    isClosed: boolean('is_closed').notNull().default(false),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_boards_repo_number_key').on(t.repositoryId, t.number),
    index('project_boards_org_idx').on(t.organizationId),
  ],
);

export const projectColumns = pgTable(
  'project_columns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => projectBoards.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    /**
     * Sortierung als Fließkommazahl: eine Karte lässt sich zwischen zwei
     * bestehende einfügen, indem der Mittelwert genommen wird – ohne alle
     * folgenden Zeilen neu zu nummerieren.
     */
    position: integer('position').notNull().default(0),
    /** Optional: Karten hier landen automatisch bei geschlossenen Issues. */
    isDoneColumn: boolean('is_done_column').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('project_columns_board_idx').on(t.boardId, t.position)],
);

export const projectCards = pgTable(
  'project_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    columnId: uuid('column_id')
      .notNull()
      .references(() => projectColumns.id, { onDelete: 'cascade' }),
    /** Entweder eine Notiz … */
    note: text('note'),
    /** … oder ein verknüpftes Issue bzw. ein Pull Request. */
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('project_cards_column_idx').on(t.columnId, t.position),
    uniqueIndex('project_cards_issue_key').on(t.columnId, t.issueId),
  ],
);

export const gistsRelations = relations(gists, ({ one, many }) => ({
  owner: one(users, { fields: [gists.ownerId], references: [users.id] }),
  comments: many(gistComments),
  stars: many(gistStars),
}));

export const projectBoardsRelations = relations(projectBoards, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [projectBoards.repositoryId],
    references: [repositories.id],
  }),
  organization: one(organizations, {
    fields: [projectBoards.organizationId],
    references: [organizations.id],
  }),
  columns: many(projectColumns),
}));

export const projectColumnsRelations = relations(projectColumns, ({ one, many }) => ({
  board: one(projectBoards, { fields: [projectColumns.boardId], references: [projectBoards.id] }),
  cards: many(projectCards),
}));

export const projectCardsRelations = relations(projectCards, ({ one }) => ({
  column: one(projectColumns, { fields: [projectCards.columnId], references: [projectColumns.id] }),
  issue: one(issues, { fields: [projectCards.issueId], references: [issues.id] }),
}));

// ---------------------------------------------------------------------------
// Spiegelung auf fremde Git-Hoster
// ---------------------------------------------------------------------------

export const mirrorDirectionEnum = pgEnum('mirror_direction', ['push', 'pull']);
export const mirrorStatusEnum = pgEnum('mirror_status', ['idle', 'running', 'success', 'failure']);

/**
 * Spiegelung eines Repositories auf einen anderen Git-Hoster.
 *
 * Zweck: Werkzeuge, die diese Instanz nicht erreichen können – etwa
 * KI-Assistenten, deren Sandkasten nur bestimmte Adressen zulässt –, über
 * GitHub o. Ä. am Projekt arbeiten lassen.
 *
 * Richtung:
 *  - `push`: nach jedem Push hierher wird der Stand zum Gegenstück geschoben.
 *  - `pull`: der Stand des Gegenstücks wird hierher übernommen.
 *
 * Es gibt bewusst keine automatische Zusammenführung beider Richtungen für
 * dasselbe Repository: wer auf beiden Seiten schreibt, erzeugt Konflikte, die
 * eine Spiegelung nicht auflösen kann. Die Oberfläche lässt deshalb je
 * Repository nur eine Richtung zu.
 */
export const repositoryMirrors = pgTable(
  'repository_mirrors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),

    direction: mirrorDirectionEnum('direction').notNull(),
    /** Adresse des Gegenstücks, immer https. Ohne Zugangsdaten. */
    remoteUrl: varchar('remote_url', { length: 1000 }).notNull(),
    /** Benutzername für die Anmeldung; bei GitHub beliebig, wenn ein Token dient. */
    remoteUsername: varchar('remote_username', { length: 200 }),
    /**
     * Zugangstoken, AES-256-GCM-verschlüsselt. Wird nie zurückgegeben und
     * gelangt auch nicht in die Prozessargumente – siehe services/mirrors.ts.
     */
    tokenEnc: text('token_enc'),

    isEnabled: boolean('is_enabled').notNull().default(true),
    /**
     * True: der Gegenstand wird zu einer exakten Kopie, auch durch Löschen
     * dortiger Branches. False: es werden nur Branches und Tags übertragen,
     * nichts entfernt.
     */
    isExactCopy: boolean('is_exact_copy').notNull().default(false),

    status: mirrorStatusEnum('status').notNull().default('idle'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    /** Verhindert, dass zwei Läufe desselben Spiegels sich überschneiden. */
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),

    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Je Repository und Richtung höchstens ein Spiegel.
    uniqueIndex('repository_mirrors_repo_direction_key').on(t.repositoryId, t.direction),
    index('repository_mirrors_pull_idx').on(t.direction, t.isEnabled, t.lastSyncAt),
  ],
);

export const repositoryMirrorsRelations = relations(repositoryMirrors, ({ one }) => ({
  repository: one(repositories, {
    fields: [repositoryMirrors.repositoryId],
    references: [repositories.id],
  }),
}));
