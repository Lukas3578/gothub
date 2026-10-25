/**
 * Forge – Datenbankschema (libSQL / Turso, Drizzle ORM)
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
import { randomUUID } from 'node:crypto';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const namespaceKindValues = ['user', 'organization'] as const;
export const namespaceKindEnum = (name: string) => text(name, { enum: namespaceKindValues });
export const repoVisibilityValues = ['public', 'private', 'internal'] as const;
export const repoVisibilityEnum = (name: string) => text(name, { enum: repoVisibilityValues });
export const accessLevelValues = ['read', 'triage', 'write', 'maintain', 'admin'] as const;
export const accessLevelEnum = (name: string) => text(name, { enum: accessLevelValues });
export const orgRoleValues = ['member', 'admin', 'owner'] as const;
export const orgRoleEnum = (name: string) => text(name, { enum: orgRoleValues });
export const issueKindValues = ['issue', 'pull_request'] as const;
export const issueKindEnum = (name: string) => text(name, { enum: issueKindValues });
export const issueStateValues = ['open', 'closed'] as const;
export const issueStateEnum = (name: string) => text(name, { enum: issueStateValues });
export const issueCloseReasonValues = ['completed', 'not_planned', 'duplicate', 'merged'] as const;
export const issueCloseReasonEnum = (name: string) => text(name, { enum: issueCloseReasonValues });
export const mergeStrategyValues = ['merge', 'squash', 'rebase'] as const;
export const mergeStrategyEnum = (name: string) => text(name, { enum: mergeStrategyValues });
export const mergeableStateValues = ['unknown', 'clean', 'conflicted', 'behind', 'blocked'] as const;
export const mergeableStateEnum = (name: string) => text(name, { enum: mergeableStateValues });
export const reviewStateValues = ['pending', 'commented', 'approved', 'changes_requested', 'dismissed'] as const;
export const reviewStateEnum = (name: string) => text(name, { enum: reviewStateValues });
export const runStatusValues = ['queued', 'waiting', 'running', 'success', 'failure', 'cancelled', 'timed_out', 'skipped',] as const;
export const runStatusEnum = (name: string) => text(name, { enum: runStatusValues });
export const runnerStatusValues = ['offline', 'idle', 'busy', 'disabled'] as const;
export const runnerStatusEnum = (name: string) => text(name, { enum: runnerStatusValues });
export const notificationReasonValues = ['assign', 'author', 'comment', 'mention', 'review_requested', 'state_change', 'subscribed', 'workflow_failure',] as const;
export const notificationReasonEnum = (name: string) => text(name, { enum: notificationReasonValues });
export const webhookEventValues = ['push', 'issues', 'issue_comment', 'pull_request', 'pull_request_review', 'release', 'workflow_run',] as const;
export const webhookEventEnum = (name: string) => text(name, { enum: webhookEventValues });
export const auditActorTypeValues = ['user', 'system', 'runner'] as const;
export const auditActorTypeEnum = (name: string) => text(name, { enum: auditActorTypeValues });

// ---------------------------------------------------------------------------
// Namensraum
// ---------------------------------------------------------------------------

/**
 * Gemeinsame Registry für Benutzer- und Organisationsnamen.
 * `nameLower` trägt den UNIQUE-Index, damit Groß-/Kleinschreibung nicht zu
 * zwei verschiedenen Besitzern mit faktisch gleichem Namen führen kann.
 */
export const namespaces = sqliteTable(
  'namespaces',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    name: text('name', { length: 39 }).notNull(),
    nameLower: text('name_lower', { length: 39 }).notNull(),
    kind: namespaceKindEnum('kind').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('namespaces_name_lower_key').on(t.nameLower)],
);

// ---------------------------------------------------------------------------
// Benutzer
// ---------------------------------------------------------------------------

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    namespaceId: text('namespace_id')
      .notNull()
      .references(() => namespaces.id, { onDelete: 'restrict' }),

    email: text('email', { length: 320 }).notNull(),
    emailLower: text('email_lower', { length: 320 }).notNull(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    /** Steuert, ob die E-Mail auf dem öffentlichen Profil erscheint. */
    emailPublic: integer('email_public', { mode: 'boolean' }).notNull().default(false),

    /** Argon2id-Hash. Enthält Salt und Parameter; keine separate Salt-Spalte nötig. */
    passwordHash: text('password_hash').notNull(),
    /**
     * Wird bei Passwortwechsel hochgezählt. Sessions mit abweichendem Wert
     * gelten als ungültig – dadurch beendet ein Passwortwechsel alle Sessions,
     * ohne dass ein separater Löschlauf nötig ist.
     */
    credentialVersion: integer('credential_version').notNull().default(1),

    displayName: text('display_name', { length: 100 }),
    bio: text('bio', { length: 500 }),
    company: text('company', { length: 100 }),
    location: text('location', { length: 100 }),
    websiteUrl: text('website_url', { length: 500 }),
    socialLinks: text('social_links', { mode: 'json' }).$type<{ label: string; url: string }[]>().notNull().default(sql`'[]'`),
    avatarPath: text('avatar_path', { length: 400 }),

    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    /** Gesetzt, wenn ein Administrator den Account gesperrt hat. */
    suspendedAt: integer('suspended_at', { mode: 'timestamp_ms' }),
    suspendedReason: text('suspended_reason', { length: 500 }),

    twoFactorEnabled: integer('two_factor_enabled', { mode: 'boolean' }).notNull().default(false),
    /** TOTP-Seed, AES-256-GCM-verschlüsselt mit ENCRYPTION_KEY. Niemals im Klartext. */
    twoFactorSecretEnc: text('two_factor_secret_enc'),
    /** Argon2-Hashes der Wiederherstellungscodes. */
    twoFactorRecoveryHashes: text('two_factor_recovery_hashes', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),

    lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('users_namespace_key').on(t.namespaceId),
    uniqueIndex('users_email_lower_key').on(t.emailLower),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * SHA-256 des Session-Tokens. Das Token selbst wird nie gespeichert – ein
     * Datenbankleck erlaubt dadurch keine Session-Übernahme.
     */
    tokenHash: text('token_hash', { length: 64 }).notNull(),
    credentialVersion: integer('credential_version').notNull(),
    userAgent: text('user_agent', { length: 400 }),
    ipAddress: text('ip_address', { length: 45 }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
);

/** Kurzlebige Tokens für E-Mail-Verifizierung und Passwort-Reset. */
export const verificationTokens = sqliteTable(
  'verification_tokens',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { length: 32 }).notNull(),
    tokenHash: text('token_hash', { length: 64 }).notNull(),
    /** Bei E-Mail-Wechsel die neue Adresse, die nach Bestätigung übernommen wird. */
    payload: text('payload', { length: 320 }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('verification_tokens_hash_key').on(t.tokenHash),
    index('verification_tokens_user_idx').on(t.userId, t.purpose),
  ],
);

/** Persönliche Zugriffstokens für API und Git über HTTPS. */
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name', { length: 100 }).notNull(),
    tokenHash: text('token_hash', { length: 64 }).notNull(),
    /** Die ersten Zeichen des Tokens, damit Benutzer es in der Liste wiedererkennen. */
    tokenPrefix: text('token_prefix', { length: 16 }).notNull(),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('api_tokens_hash_key').on(t.tokenHash), index('api_tokens_user_idx').on(t.userId)],
);

export const sshKeys = sqliteTable(
  'ssh_keys',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title', { length: 100 }).notNull(),
    /** SHA-256-Fingerprint im OpenSSH-Format, Basis für die Zuordnung beim Login. */
    fingerprint: text('fingerprint', { length: 64 }).notNull(),
    publicKey: text('public_key').notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('ssh_keys_fingerprint_key').on(t.fingerprint), index('ssh_keys_user_idx').on(t.userId)],
);

export const userBlocks = sqliteTable(
  'user_blocks',
  {
    blockerId: text('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: text('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason', { length: 500 }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), index('user_blocks_blocked_idx').on(t.blockedId)],
);

export const follows = sqliteTable(
  'follows',
  {
    followerId: text('follower_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followingId: text('following_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.followerId, t.followingId] }), index('follows_following_idx').on(t.followingId)],
);

export const abuseReports = sqliteTable(
  'abuse_reports',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    reporterId: text('reporter_id').references(() => users.id, { onDelete: 'set null' }),
    /** 'user' | 'repository' | 'issue' | 'comment' */
    subjectType: text('subject_type', { length: 32 }).notNull(),
    subjectId: text('subject_id').notNull(),
    reason: text('reason', { length: 64 }).notNull(),
    details: text('details'),
    status: text('status', { length: 32 }).notNull().default('open'),
    resolvedById: text('resolved_by_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
    resolutionNote: text('resolution_note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index('abuse_reports_status_idx').on(t.status, t.createdAt), index('abuse_reports_subject_idx').on(t.subjectType, t.subjectId)],
);

// ---------------------------------------------------------------------------
// Organisationen und Teams
// ---------------------------------------------------------------------------

export const organizations = sqliteTable(
  'organizations',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    namespaceId: text('namespace_id')
      .notNull()
      .references(() => namespaces.id, { onDelete: 'restrict' }),
    displayName: text('display_name', { length: 100 }),
    description: text('description', { length: 500 }),
    websiteUrl: text('website_url', { length: 500 }),
    location: text('location', { length: 100 }),
    avatarPath: text('avatar_path', { length: 400 }),
    /**
     * Standard-Sichtbarkeit für neu erstellte Repositories dieser Organisation.
     * Verhindert, dass interner Code versehentlich öffentlich wird.
     */
    defaultRepoVisibility: repoVisibilityEnum('default_repo_visibility').notNull().default('private'),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('organizations_namespace_key').on(t.namespaceId)],
);

export const organizationMembers = sqliteTable(
  'organization_members',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRoleEnum('role').notNull().default('member'),
    /** Steuert, ob die Mitgliedschaft auf dem öffentlichen Profil sichtbar ist. */
    isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    index('organization_members_user_idx').on(t.userId),
    index('organization_members_role_idx').on(t.organizationId, t.role),
  ],
);

export const organizationInvitations = sqliteTable(
  'organization_invitations',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Gesetzt, wenn ein bestehender Account eingeladen wird. */
    inviteeId: text('invitee_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Gesetzt, wenn per E-Mail eingeladen wird und noch kein Account existiert. */
    inviteeEmail: text('invitee_email', { length: 320 }),
    role: orgRoleEnum('role').notNull().default('member'),
    invitedById: text('invited_by_id').references(() => users.id, { onDelete: 'set null' }),
    tokenHash: text('token_hash', { length: 64 }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    acceptedAt: integer('accepted_at', { mode: 'timestamp_ms' }),
    declinedAt: integer('declined_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('organization_invitations_token_key').on(t.tokenHash),
    index('organization_invitations_org_idx').on(t.organizationId),
  ],
);

export const teams = sqliteTable(
  'teams',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name', { length: 100 }).notNull(),
    slug: text('slug', { length: 100 }).notNull(),
    description: text('description', { length: 500 }),
    /** Berechtigung, die Mitglieder auf zugeordnete Repositories erhalten. */
    defaultPermission: accessLevelEnum('default_permission').notNull().default('read'),
    /** Spezialteam, das automatisch alle Organisationsmitglieder enthält. */
    isAllMembers: integer('is_all_members', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('teams_org_slug_key').on(t.organizationId, t.slug)],
);

export const teamMembers = sqliteTable(
  'team_members',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    isMaintainer: integer('is_maintainer', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] }), index('team_members_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export const repositories = sqliteTable(
  'repositories',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    /** Besitzer – Benutzer oder Organisation, aufgelöst über den Namensraum. */
    ownerNamespaceId: text('owner_namespace_id')
      .notNull()
      .references(() => namespaces.id, { onDelete: 'restrict' }),
    name: text('name', { length: 100 }).notNull(),
    nameLower: text('name_lower', { length: 100 }).notNull(),
    description: text('description', { length: 500 }),
    visibility: repoVisibilityEnum('visibility').notNull().default('private'),

    defaultBranch: text('default_branch', { length: 255 }).notNull().default('main'),
    /** True, solange noch kein Commit gepusht wurde. Steuert die Repo-Startseite. */
    isEmpty: integer('is_empty', { mode: 'boolean' }).notNull().default(true),
    isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
    isTemplate: integer('is_template', { mode: 'boolean' }).notNull().default(false),
    isMirror: integer('is_mirror', { mode: 'boolean' }).notNull().default(false),

    isFork: integer('is_fork', { mode: 'boolean' }).notNull().default(false),
    parentId: text('parent_id').references((): any => repositories.id, { onDelete: 'set null' }),

    websiteUrl: text('website_url', { length: 500 }),
    topics: text('topics', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    primaryLanguage: text('primary_language', { length: 50 }),
    /** Byte-Anteile je Sprache, aus dem Dateibaum berechnet. */
    languages: text('languages', { mode: 'json' }).$type<Record<string, number>>().notNull().default(sql`'{}'`),

    hasIssues: integer('has_issues', { mode: 'boolean' }).notNull().default(true),
    hasPullRequests: integer('has_pull_requests', { mode: 'boolean' }).notNull().default(true),
    hasWiki: integer('has_wiki', { mode: 'boolean' }).notNull().default(true),
    hasActions: integer('has_actions', { mode: 'boolean' }).notNull().default(true),
    hasReleases: integer('has_releases', { mode: 'boolean' }).notNull().default(true),

    allowMergeCommit: integer('allow_merge_commit', { mode: 'boolean' }).notNull().default(true),
    allowSquashMerge: integer('allow_squash_merge', { mode: 'boolean' }).notNull().default(true),
    allowRebaseMerge: integer('allow_rebase_merge', { mode: 'boolean' }).notNull().default(true),
    deleteBranchOnMerge: integer('delete_branch_on_merge', { mode: 'boolean' }).notNull().default(false),

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

    sizeBytes: integer('size_bytes').notNull().default(0),

    pushedAt: integer('pushed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    /** Soft Delete: erlaubt Wiederherstellung und verhindert Namens-Recycling-Angriffe. */
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('repositories_owner_name_key').on(t.ownerNamespaceId, t.nameLower),
    index('repositories_visibility_idx').on(t.visibility, t.updatedAt),
    index('repositories_parent_idx').on(t.parentId),
    index('repositories_language_idx').on(t.primaryLanguage),
  ],
);

/** Direkt auf einen Benutzer vergebene Repository-Rechte (ohne Team-Umweg). */
export const repositoryCollaborators = sqliteTable(
  'repository_collaborators',
  {
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permission: accessLevelEnum('permission').notNull().default('read'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.userId] }),
    index('repository_collaborators_user_idx').on(t.userId),
  ],
);

/** Repository-Zugriff für ein Team einer Organisation. */
export const teamRepositories = sqliteTable(
  'team_repositories',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    permission: accessLevelEnum('permission').notNull().default('read'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.repositoryId] }),
    index('team_repositories_repo_idx').on(t.repositoryId),
  ],
);

export const branchProtections = sqliteTable(
  'branch_protections',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** Glob-Muster, z. B. "main" oder "release/*". */
    pattern: text('pattern', { length: 255 }).notNull(),
    requirePullRequest: integer('require_pull_request', { mode: 'boolean' }).notNull().default(true),
    requiredApprovals: integer('required_approvals').notNull().default(1),
    dismissStaleReviews: integer('dismiss_stale_reviews', { mode: 'boolean' }).notNull().default(false),
    requireStatusChecks: integer('require_status_checks', { mode: 'boolean' }).notNull().default(false),
    requiredStatusChecks: text('required_status_checks', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    requireLinearHistory: integer('require_linear_history', { mode: 'boolean' }).notNull().default(false),
    /** Verbietet force-push auf passende Branches. */
    blockForcePush: integer('block_force_push', { mode: 'boolean' }).notNull().default(true),
    blockDeletion: integer('block_deletion', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('branch_protections_repo_pattern_key').on(t.repositoryId, t.pattern)],
);

export const stars = sqliteTable(
  'stars',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.repositoryId] }), index('stars_repo_idx').on(t.repositoryId)],
);

export const watches = sqliteTable(
  'watches',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** 'all' | 'participating' | 'ignore' */
    level: text('level', { length: 16 }).notNull().default('all'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.repositoryId] }), index('watches_repo_idx').on(t.repositoryId)],
);

/**
 * Suchindex für Commits. KEINE Quelle der Wahrheit – wird aus dem Git-Repository
 * befüllt und kann jederzeit verworfen und neu aufgebaut werden.
 */
export const commitIndex = sqliteTable(
  'commit_index',
  {
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    oid: text('oid', { length: 40 }).notNull(),
    authorName: text('author_name', { length: 255 }).notNull(),
    authorEmail: text('author_email', { length: 320 }).notNull(),
    /** Zuordnung zum Plattform-Account über verifizierte E-Mail, sofern möglich. */
    authorUserId: text('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    committedAt: integer('committed_at', { mode: 'timestamp_ms' }).notNull(),
    subject: text('subject', { length: 500 }).notNull(),
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
export const pushEvents = sqliteTable(
  'push_events',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    pusherId: text('pusher_id').references(() => users.id, { onDelete: 'set null' }),
    refName: text('ref_name', { length: 255 }).notNull(),
    oldOid: text('old_oid', { length: 40 }).notNull(),
    newOid: text('new_oid', { length: 40 }).notNull(),
    isForcePush: integer('is_force_push', { mode: 'boolean' }).notNull().default(false),
    commitCount: integer('commit_count').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index('push_events_repo_idx').on(t.repositoryId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Issues und Pull Requests
// ---------------------------------------------------------------------------

export const labels = sqliteTable(
  'labels',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    name: text('name', { length: 64 }).notNull(),
    /** Hex-Farbe ohne führendes #. */
    color: text('color', { length: 6 }).notNull().default('6b7280'),
    description: text('description', { length: 200 }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('labels_repo_name_key').on(t.repositoryId, t.name)],
);

export const milestones = sqliteTable(
  'milestones',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title', { length: 255 }).notNull(),
    description: text('description'),
    dueOn: integer('due_on', { mode: 'timestamp_ms' }),
    state: issueStateEnum('state').notNull().default('open'),
    closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('milestones_repo_number_key').on(t.repositoryId, t.number)],
);

export const issues = sqliteTable(
  'issues',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** Pro Repository fortlaufend, gemeinsam für Issues und Pull Requests. */
    number: integer('number').notNull(),
    kind: issueKindEnum('kind').notNull().default('issue'),
    title: text('title', { length: 500 }).notNull(),
    body: text('body'),
    state: issueStateEnum('state').notNull().default('open'),
    closeReason: issueCloseReasonEnum('close_reason'),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    milestoneId: text('milestone_id').references(() => milestones.id, { onDelete: 'set null' }),
    isLocked: integer('is_locked', { mode: 'boolean' }).notNull().default(false),
    commentCount: integer('comment_count').notNull().default(0),
    closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
    closedById: text('closed_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('issues_repo_number_key').on(t.repositoryId, t.number),
    index('issues_repo_state_idx').on(t.repositoryId, t.kind, t.state, t.updatedAt),
    index('issues_author_idx').on(t.authorId, t.createdAt),
    index('issues_milestone_idx').on(t.milestoneId),
  ],
);

export const pullRequests = sqliteTable(
  'pull_requests',
  {
    /** 1:1-Erweiterung von `issues`. */
    issueId: text('issue_id')
      .primaryKey()
      .references(() => issues.id, { onDelete: 'cascade' }),

    baseRepositoryId: text('base_repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    baseBranch: text('base_branch', { length: 255 }).notNull(),
    baseSha: text('base_sha', { length: 40 }),

    /** Null, wenn das Fork-Repository nach dem Öffnen gelöscht wurde. */
    headRepositoryId: text('head_repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    headBranch: text('head_branch', { length: 255 }).notNull(),
    headSha: text('head_sha', { length: 40 }),

    isDraft: integer('is_draft', { mode: 'boolean' }).notNull().default(false),
    mergeableState: mergeableStateEnum('mergeable_state').notNull().default('unknown'),
    /** Commit, in dem der Testmerge berechnet wurde – Cache-Invalidierung. */
    mergeCheckedSha: text('merge_checked_sha', { length: 40 }),

    mergedAt: integer('merged_at', { mode: 'timestamp_ms' }),
    mergedById: text('merged_by_id').references(() => users.id, { onDelete: 'set null' }),
    mergeStrategy: mergeStrategyEnum('merge_strategy'),
    mergeCommitSha: text('merge_commit_sha', { length: 40 }),

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

export const issueLabels = sqliteTable(
  'issue_labels',
  {
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    labelId: text('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.labelId] }), index('issue_labels_label_idx').on(t.labelId)],
);

export const issueAssignees = sqliteTable(
  'issue_assignees',
  {
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assignedAt: integer('assigned_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.userId] }), index('issue_assignees_user_idx').on(t.userId)],
);

export const issueComments = sqliteTable(
  'issue_comments',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    editedAt: integer('edited_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index('issue_comments_issue_idx').on(t.issueId, t.createdAt)],
);

/** Strukturierte Ereignisse im Issue-Verlauf (geschlossen, Label gesetzt, …). */
export const issueEvents = sqliteTable(
  'issue_events',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    eventType: text('event_type', { length: 48 }).notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index('issue_events_issue_idx').on(t.issueId, t.createdAt)],
);

/** Verknüpfungen zwischen Issues (duplicate_of, blocks, relates_to, closes). */
export const issueLinks = sqliteTable(
  'issue_links',
  {
    sourceIssueId: text('source_issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    targetIssueId: text('target_issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    linkType: text('link_type', { length: 32 }).notNull(),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.sourceIssueId, t.targetIssueId, t.linkType] }),
    index('issue_links_target_idx').on(t.targetIssueId),
  ],
);

export const pullRequestReviews = sqliteTable(
  'pull_request_reviews',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    reviewerId: text('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    state: reviewStateEnum('state').notNull().default('pending'),
    body: text('body'),
    /** Commit, auf den sich das Review bezieht – für "stale review"-Erkennung. */
    commitSha: text('commit_sha', { length: 40 }),
    submittedAt: integer('submitted_at', { mode: 'timestamp_ms' }),
    dismissedAt: integer('dismissed_at', { mode: 'timestamp_ms' }),
    dismissedReason: text('dismissed_reason', { length: 500 }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index('pull_request_reviews_issue_idx').on(t.issueId), index('pull_request_reviews_reviewer_idx').on(t.reviewerId)],
);

export const reviewRequests = sqliteTable(
  'review_requests',
  {
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    /** Entweder ein einzelner Benutzer … */
    reviewerId: text('reviewer_id').references(() => users.id, { onDelete: 'cascade' }),
    /** … oder ein ganzes Team. */
    teamId: text('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    requestedById: text('requested_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index('review_requests_issue_idx').on(t.issueId),
    uniqueIndex('review_requests_user_key').on(t.issueId, t.reviewerId),
    uniqueIndex('review_requests_team_key').on(t.issueId, t.teamId),
  ],
);

export const reviewComments = sqliteTable(
  'review_comments',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    reviewId: text('review_id').references(() => pullRequestReviews.id, { onDelete: 'cascade' }),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    path: text('path', { length: 1000 }).notNull(),
    /** Zeile in der neuen Fassung; null bei Kommentaren auf gelöschte Zeilen. */
    line: integer('line'),
    startLine: integer('start_line'),
    /** 'left' = alte Fassung, 'right' = neue Fassung. */
    diffSide: text('diff_side', { length: 8 }).notNull().default('right'),
    commitSha: text('commit_sha', { length: 40 }).notNull(),
    /** Antworten innerhalb eines Threads. */
    replyToId: text('reply_to_id').references((): any => reviewComments.id, { onDelete: 'cascade' }),
    isResolved: integer('is_resolved', { mode: 'boolean' }).notNull().default(false),
    resolvedById: text('resolved_by_id').references(() => users.id, { onDelete: 'set null' }),
    editedAt: integer('edited_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index('review_comments_issue_idx').on(t.issueId), index('review_comments_review_idx').on(t.reviewId)],
);

export const reactions = sqliteTable(
  'reactions',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'issue' | 'issue_comment' | 'review_comment' | 'release' */
    subjectType: text('subject_type', { length: 32 }).notNull(),
    subjectId: text('subject_id').notNull(),
    content: text('content', { length: 32 }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('reactions_unique_key').on(t.userId, t.subjectType, t.subjectId, t.content),
    index('reactions_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

/** Vorlagen für Issues und Pull Requests, aus .forge/ im Repository gelesen. */
export const issueTemplates = sqliteTable(
  'issue_templates',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    kind: issueKindEnum('kind').notNull().default('issue'),
    name: text('name', { length: 100 }).notNull(),
    about: text('about', { length: 300 }),
    titlePrefix: text('title_prefix', { length: 100 }),
    body: text('body').notNull(),
    defaultLabels: text('default_labels', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    sourcePath: text('source_path', { length: 500 }).notNull(),
    syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('issue_templates_repo_path_key').on(t.repositoryId, t.sourcePath)],
);

// ---------------------------------------------------------------------------
// CI/CD: Workflows, Runs, Runner
// ---------------------------------------------------------------------------

export const workflows = sqliteTable(
  'workflows',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    name: text('name', { length: 255 }).notNull(),
    /** Pfad innerhalb des Repositories, z. B. .forge/workflows/build.yml */
    path: text('path', { length: 500 }).notNull(),
    isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
    /** Letzter Validierungsfehler der YAML-Datei, null wenn gültig. */
    parseError: text('parse_error'),
    /** Cron-Ausdrücke aus dem `schedule`-Trigger, für den Scheduler. */
    schedules: text('schedules', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('workflows_repo_path_key').on(t.repositoryId, t.path)],
);

export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
    /** Pro Repository fortlaufende Run-Nummer. */
    runNumber: integer('run_number').notNull(),
    /** Zählt hoch bei Wiederholung desselben Runs. */
    runAttempt: integer('run_attempt').notNull().default(1),
    /** 'push' | 'pull_request' | 'workflow_dispatch' | 'schedule' */
    event: text('event', { length: 48 }).notNull(),
    status: runStatusEnum('status').notNull().default('queued'),
    headBranch: text('head_branch', { length: 255 }),
    headSha: text('head_sha', { length: 40 }).notNull(),
    /** Snapshot der Workflow-Definition zum Zeitpunkt des Starts. */
    definition: text('definition', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    triggeredById: text('triggered_by_id').references(() => users.id, { onDelete: 'set null' }),
    /** Bei pull_request-Trigger der auslösende PR. */
    issueId: text('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('workflow_runs_repo_number_key').on(t.repositoryId, t.runNumber, t.runAttempt),
    index('workflow_runs_repo_status_idx').on(t.repositoryId, t.status, t.createdAt),
    index('workflow_runs_sha_idx').on(t.repositoryId, t.headSha),
  ],
);

export const workflowJobs = sqliteTable(
  'workflow_jobs',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    /** Schlüssel aus der YAML-Datei (jobs.<key>). */
    jobKey: text('job_key', { length: 255 }).notNull(),
    name: text('name', { length: 255 }).notNull(),
    status: runStatusEnum('status').notNull().default('queued'),
    /** Labels, die ein Runner erfüllen muss (runs-on). */
    requiredLabels: text('required_labels', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    /** jobKeys, die vorher erfolgreich sein müssen (needs). */
    dependsOn: text('depends_on', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    /** Zugewiesener Runner; null solange der Job in der Warteschlange liegt. */
    runnerId: text('runner_id').references((): any => runners.id, { onDelete: 'set null' }),
    /**
     * Wird bei Zuweisung gesetzt und vom Runner per Heartbeat verlängert.
     * Läuft die Lease ab, gilt der Job als verwaist und wird neu eingereiht.
     */
    leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp_ms' }),
    timeoutMinutes: integer('timeout_minutes').notNull().default(60),
    exitCode: integer('exit_code'),
    errorMessage: text('error_message'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('workflow_jobs_run_key').on(t.runId, t.jobKey),
    index('workflow_jobs_queue_idx').on(t.status, t.createdAt),
    index('workflow_jobs_runner_idx').on(t.runnerId),
    index('workflow_jobs_lease_idx').on(t.leaseExpiresAt),
  ],
);

export const workflowSteps = sqliteTable(
  'workflow_steps',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    jobId: text('job_id')
      .notNull()
      .references(() => workflowJobs.id, { onDelete: 'cascade' }),
    stepNumber: integer('step_number').notNull(),
    name: text('name', { length: 255 }).notNull(),
    status: runStatusEnum('status').notNull().default('queued'),
    exitCode: integer('exit_code'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [uniqueIndex('workflow_steps_job_number_key').on(t.jobId, t.stepNumber)],
);

/**
 * Log-Zeilen werden blockweise gespeichert statt einzeln, um die Zeilenanzahl
 * beherrschbar zu halten. Ein Block fasst die Ausgabe eines Zeitfensters.
 */
export const workflowLogChunks = sqliteTable(
  'workflow_log_chunks',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    jobId: text('job_id')
      .notNull()
      .references(() => workflowJobs.id, { onDelete: 'cascade' }),
    stepNumber: integer('step_number'),
    /** Fortlaufend je Job, stellt die Reihenfolge sicher. */
    sequence: integer('sequence').notNull(),
    content: text('content').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('workflow_log_chunks_job_seq_key').on(t.jobId, t.sequence)],
);

export const workflowArtifacts = sqliteTable(
  'workflow_artifacts',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    name: text('name', { length: 255 }).notNull(),
    /** Pfad im Objektspeicher. Nie direkt an den Client ausgeliefert. */
    storageKey: text('storage_key', { length: 500 }).notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    contentType: text('content_type', { length: 128 }),
    sha256: text('sha256', { length: 64 }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('workflow_artifacts_run_name_key').on(t.runId, t.name)],
);

export const runners = sqliteTable(
  'runners',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    name: text('name', { length: 255 }).notNull(),
    /**
     * Geltungsbereich. Ist beides null, handelt es sich um einen
     * plattformweiten Runner, den nur Administratoren registrieren dürfen.
     */
    repositoryId: text('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    /** SHA-256 des Registrierungstokens. */
    tokenHash: text('token_hash', { length: 64 }).notNull(),
    labels: text('labels', { mode: 'json' }).$type<string[]>().notNull().default(sql`'["self-hosted"]'`),
    status: runnerStatusEnum('status').notNull().default('offline'),
    osName: text('os_name', { length: 64 }),
    architecture: text('architecture', { length: 32 }),
    version: text('version', { length: 32 }),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
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
export const secrets = sqliteTable(
  'secrets',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    repositoryId: text('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    /** Optionale Umgebung (production, staging …). */
    environment: text('environment', { length: 64 }),
    name: text('name', { length: 128 }).notNull(),
    valueEnc: text('value_enc').notNull(),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('secrets_repo_env_name_key').on(t.repositoryId, t.environment, t.name),
    uniqueIndex('secrets_org_env_name_key').on(t.organizationId, t.environment, t.name),
  ],
);

/** Nicht-geheime Umgebungsvariablen. Im Gegensatz zu Secrets lesbar. */
export const variables = sqliteTable(
  'variables',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    repositoryId: text('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    environment: text('environment', { length: 64 }),
    name: text('name', { length: 128 }).notNull(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('variables_repo_env_name_key').on(t.repositoryId, t.environment, t.name),
    uniqueIndex('variables_org_env_name_key').on(t.organizationId, t.environment, t.name),
  ],
);

// ---------------------------------------------------------------------------
// Releases und Packages
// ---------------------------------------------------------------------------

export const releases = sqliteTable(
  'releases',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    tagName: text('tag_name', { length: 255 }).notNull(),
    /** Branch oder Commit, auf dem das Tag erzeugt wurde. */
    targetCommitish: text('target_commitish', { length: 255 }),
    name: text('name', { length: 255 }),
    body: text('body'),
    isDraft: integer('is_draft', { mode: 'boolean' }).notNull().default(false),
    isPrerelease: integer('is_prerelease', { mode: 'boolean' }).notNull().default(false),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('releases_repo_tag_key').on(t.repositoryId, t.tagName),
    index('releases_repo_published_idx').on(t.repositoryId, t.publishedAt),
  ],
);

export const releaseAssets = sqliteTable(
  'release_assets',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    releaseId: text('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    name: text('name', { length: 255 }).notNull(),
    label: text('label', { length: 255 }),
    storageKey: text('storage_key', { length: 500 }).notNull(),
    contentType: text('content_type', { length: 128 }),
    sizeBytes: integer('size_bytes').notNull().default(0),
    sha256: text('sha256', { length: 64 }),
    downloadCount: integer('download_count').notNull().default(0),
    uploadedById: text('uploaded_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('release_assets_release_name_key').on(t.releaseId, t.name)],
);

/**
 * Package-Registry. Bewusst formatneutral gehalten: `format` unterscheidet
 * npm, docker, maven usw., `metadata` nimmt formatspezifische Felder auf.
 * Dadurch lassen sich weitere Registries ergänzen, ohne das Schema zu ändern.
 */
export const packages = sqliteTable(
  'packages',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    ownerNamespaceId: text('owner_namespace_id')
      .notNull()
      .references(() => namespaces.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    format: text('format', { length: 32 }).notNull(),
    name: text('name', { length: 255 }).notNull(),
    description: text('description', { length: 500 }),
    visibility: repoVisibilityEnum('visibility').notNull().default('private'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('packages_owner_format_name_key').on(t.ownerNamespaceId, t.format, t.name)],
);

export const packageVersions = sqliteTable(
  'package_versions',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    packageId: text('package_id')
      .notNull()
      .references(() => packages.id, { onDelete: 'cascade' }),
    version: text('version', { length: 128 }).notNull(),
    storageKey: text('storage_key', { length: 500 }).notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    sha256: text('sha256', { length: 64 }),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    downloadCount: integer('download_count').notNull().default(0),
    publishedById: text('published_by_id').references(() => users.id, { onDelete: 'set null' }),
    yankedAt: integer('yanked_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('package_versions_pkg_version_key').on(t.packageId, t.version)],
);

// ---------------------------------------------------------------------------
// Benachrichtigungen, Webhooks, Audit
// ---------------------------------------------------------------------------

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    /** 'issue' | 'pull_request' | 'workflow_run' | 'release' */
    subjectType: text('subject_type', { length: 32 }).notNull(),
    subjectId: text('subject_id').notNull(),
    reason: notificationReasonEnum('reason').notNull(),
    title: text('title', { length: 500 }).notNull(),
    /** Relative URL innerhalb der Anwendung. */
    targetPath: text('target_path', { length: 1000 }).notNull(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    readAt: integer('read_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index('notifications_user_unread_idx').on(t.userId, t.readAt, t.createdAt),
    index('notifications_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

export const notificationSettings = sqliteTable(
  'notification_settings',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    emailOnMention: integer('email_on_mention', { mode: 'boolean' }).notNull().default(true),
    emailOnReviewRequest: integer('email_on_review_request', { mode: 'boolean' }).notNull().default(true),
    emailOnAssign: integer('email_on_assign', { mode: 'boolean' }).notNull().default(true),
    emailOnWorkflowFailure: integer('email_on_workflow_failure', { mode: 'boolean' }).notNull().default(true),
    /** Automatisch Repositories beobachten, zu denen man Schreibrechte erhält. */
    autoWatchOnAccess: integer('auto_watch_on_access', { mode: 'boolean' }).notNull().default(true),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
);

export const webhooks = sqliteTable(
  'webhooks',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    repositoryId: text('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    url: text('url', { length: 1000 }).notNull(),
    /** HMAC-SHA256-Schlüssel, verschlüsselt gespeichert. */
    secretEnc: text('secret_enc'),
    contentType: text('content_type', { length: 64 }).notNull().default('application/json'),
    events: text('events', { mode: 'json' }).$type<string[]>().notNull().default(sql`'["push"]'`),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    /** Anzahl aufeinanderfolgender Fehlzustellungen; deaktiviert den Hook ab einem Grenzwert. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index('webhooks_repo_idx').on(t.repositoryId), index('webhooks_org_idx').on(t.organizationId)],
);

export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    event: text('event', { length: 48 }).notNull(),
    requestBody: text('request_body').notNull(),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    attempt: integer('attempt').notNull().default(1),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index('webhook_deliveries_hook_idx').on(t.webhookId, t.createdAt)],
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    actorType: auditActorTypeEnum('actor_type').notNull().default('user'),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Maschinenlesbare Aktion, z. B. "repository.visibility_changed". */
    action: text('action', { length: 64 }).notNull(),
    /** Betroffenes Objekt. */
    targetType: text('target_type', { length: 32 }),
    targetId: text('target_id'),
    repositoryId: text('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
    ipAddress: text('ip_address', { length: 45 }),
    userAgent: text('user_agent', { length: 400 }),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index('audit_logs_actor_idx').on(t.actorId, t.createdAt),
    index('audit_logs_action_idx').on(t.action, t.createdAt),
    index('audit_logs_repo_idx').on(t.repositoryId, t.createdAt),
  ],
);

/** Plattformweite Einstellungen als Key-Value, vom Admin-Panel verwaltet. */
export const platformSettings = sqliteTable('platform_settings', {
  key: text('key', { length: 64 }).primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedById: text('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
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
export const gists = sqliteTable(
  'gists',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    description: text('description', { length: 500 }),
    /**
     * Gists kennen nur zwei Stufen: öffentlich oder nicht gelistet.
     * "Nicht gelistet" bedeutet: nicht in Listen, aber über die ID erreichbar –
     * deshalb heißt es nicht "privat", was eine Zugriffsprüfung verspräche,
     * die es hier nicht gibt.
     */
    isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
    /** Vorschau der ersten Datei, damit Listen ohne Git-Zugriff auskommen. */
    primaryFilename: text('primary_filename', { length: 255 }),
    primaryLanguage: text('primary_language', { length: 50 }),
    fileCount: integer('file_count').notNull().default(0),
    forkOfId: text('fork_of_id').references((): any => gists.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index('gists_owner_idx').on(t.ownerId, t.createdAt),
    index('gists_public_idx').on(t.isPublic, t.createdAt),
  ],
);

export const gistComments = sqliteTable(
  'gist_comments',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    gistId: text('gist_id')
      .notNull()
      .references(() => gists.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    editedAt: integer('edited_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index('gist_comments_gist_idx').on(t.gistId, t.createdAt)],
);

export const gistStars = sqliteTable(
  'gist_stars',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gistId: text('gist_id')
      .notNull()
      .references(() => gists.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.gistId] }), index('gist_stars_gist_idx').on(t.gistId)],
);

// ---------------------------------------------------------------------------
// Projektboards
// ---------------------------------------------------------------------------

export const projectBoards = sqliteTable(
  'project_boards',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    /** Ein Board gehört entweder zu einem Repository oder zu einer Organisation. */
    repositoryId: text('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    number: integer('number').notNull(),
    name: text('name', { length: 200 }).notNull(),
    description: text('description', { length: 1000 }),
    isClosed: integer('is_closed', { mode: 'boolean' }).notNull().default(false),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('project_boards_repo_number_key').on(t.repositoryId, t.number),
    index('project_boards_org_idx').on(t.organizationId),
  ],
);

export const projectColumns = sqliteTable(
  'project_columns',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    boardId: text('board_id')
      .notNull()
      .references(() => projectBoards.id, { onDelete: 'cascade' }),
    name: text('name', { length: 100 }).notNull(),
    /**
     * Sortierung als Fließkommazahl: eine Karte lässt sich zwischen zwei
     * bestehende einfügen, indem der Mittelwert genommen wird – ohne alle
     * folgenden Zeilen neu zu nummerieren.
     */
    position: integer('position').notNull().default(0),
    /** Optional: Karten hier landen automatisch bei geschlossenen Issues. */
    isDoneColumn: integer('is_done_column', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index('project_columns_board_idx').on(t.boardId, t.position)],
);

export const projectCards = sqliteTable(
  'project_cards',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    columnId: text('column_id')
      .notNull()
      .references(() => projectColumns.id, { onDelete: 'cascade' }),
    /** Entweder eine Notiz … */
    note: text('note'),
    /** … oder ein verknüpftes Issue bzw. ein Pull Request. */
    issueId: text('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
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

export const mirrorDirectionValues = ['push', 'pull'] as const;
export const mirrorDirectionEnum = (name: string) => text(name, { enum: mirrorDirectionValues });
export const mirrorStatusValues = ['idle', 'running', 'success', 'failure'] as const;
export const mirrorStatusEnum = (name: string) => text(name, { enum: mirrorStatusValues });

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
export const repositoryMirrors = sqliteTable(
  'repository_mirrors',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),

    direction: mirrorDirectionEnum('direction').notNull(),
    /** Adresse des Gegenstücks, immer https. Ohne Zugangsdaten. */
    remoteUrl: text('remote_url', { length: 1000 }).notNull(),
    /** Benutzername für die Anmeldung; bei GitHub beliebig, wenn ein Token dient. */
    remoteUsername: text('remote_username', { length: 200 }),
    /**
     * Zugangstoken, AES-256-GCM-verschlüsselt. Wird nie zurückgegeben und
     * gelangt auch nicht in die Prozessargumente – siehe services/mirrors.ts.
     */
    tokenEnc: text('token_enc'),

    isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
    /**
     * True: der Gegenstand wird zu einer exakten Kopie, auch durch Löschen
     * dortiger Branches. False: es werden nur Branches und Tags übertragen,
     * nichts entfernt.
     */
    isExactCopy: integer('is_exact_copy', { mode: 'boolean' }).notNull().default(false),

    status: mirrorStatusEnum('status').notNull().default('idle'),
    lastSyncAt: integer('last_sync_at', { mode: 'timestamp_ms' }),
    lastError: text('last_error'),
    /** Verhindert, dass zwei Läufe desselben Spiegels sich überschneiden. */
    leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp_ms' }),

    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
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
