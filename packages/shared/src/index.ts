/**
 * Gemeinsame Typen und Konstanten für Backend und Frontend.
 * Dieses Paket enthält bewusst keine Laufzeit-Abhängigkeiten.
 */

// ---------------------------------------------------------------------------
// Rollen und Berechtigungen
// ---------------------------------------------------------------------------

/**
 * Zugriffsstufen auf ein Repository, aufsteigend sortiert.
 * Die numerische Ordnung ist Teil des Vertrags: Vergleiche in der
 * Berechtigungsprüfung verlassen sich darauf.
 */
export const ACCESS_LEVELS = ['none', 'read', 'triage', 'write', 'maintain', 'admin'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_LEVEL_RANK: Record<AccessLevel, number> = {
  none: 0,
  read: 10,
  triage: 20,
  write: 30,
  maintain: 40,
  admin: 50,
};

/** Rollen innerhalb einer Organisation. */
export const ORG_ROLES = ['member', 'admin', 'owner'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Berechtigung, die ein Team auf ein Repository erhält. */
export const TEAM_PERMISSIONS = ['read', 'triage', 'write', 'maintain', 'admin'] as const;
export type TeamPermission = (typeof TEAM_PERMISSIONS)[number];

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const REPO_VISIBILITY = ['public', 'private', 'internal'] as const;
export type RepoVisibility = (typeof REPO_VISIBILITY)[number];

export const OWNER_TYPES = ['user', 'organization'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

export interface RepositorySummary {
  id: string;
  ownerType: OwnerType;
  ownerName: string;
  name: string;
  fullName: string;
  description: string | null;
  visibility: RepoVisibility;
  isArchived: boolean;
  isFork: boolean;
  isEmpty: boolean;
  defaultBranch: string;
  primaryLanguage: string | null;
  topics: string[];
  starCount: number;
  forkCount: number;
  watcherCount: number;
  openIssueCount: number;
  sizeBytes: number;
  pushedAt: string | null;
  updatedAt: string;
  createdAt: string;
  /** Welche Bereiche in diesem Repository aktiviert sind. */
  hasIssues: boolean;
  hasPullRequests: boolean;
  hasWiki: boolean;
  hasActions: boolean;
  hasReleases: boolean;
}

export interface RepositoryDetail extends RepositorySummary {
  /** Zugriffsstufe des anfragenden Benutzers auf dieses Repository. */
  viewerAccess: AccessLevel;
  viewerHasStarred: boolean;
  viewerIsWatching: boolean;
  parent: { fullName: string; id: string } | null;
  cloneUrlHttp: string;
}

// ---------------------------------------------------------------------------
// Git-Objekte
// ---------------------------------------------------------------------------

export type TreeEntryType = 'blob' | 'tree' | 'commit' | 'symlink';

export interface TreeEntry {
  name: string;
  path: string;
  type: TreeEntryType;
  mode: string;
  /** SHA-1 des Blobs bzw. Trees. */
  oid: string;
  size: number | null;
  /** Letzter Commit, der diesen Pfad verändert hat. Optional, da teuer. */
  lastCommit?: CommitSummary | null;
}

export interface GitSignature {
  name: string;
  email: string;
  /** ISO-8601 mit Zeitzonen-Offset. */
  date: string;
  /** Verknüpfter Plattform-Benutzer, sofern die E-Mail zugeordnet werden konnte. */
  user: UserRef | null;
}

export interface CommitSummary {
  oid: string;
  shortOid: string;
  /** Erste Zeile der Commit-Message. */
  subject: string;
  /** Rest der Commit-Message ohne Subject. */
  body: string;
  author: GitSignature;
  committer: GitSignature;
  parents: string[];
}

export interface CommitDetail extends CommitSummary {
  stats: DiffStats;
  files: DiffFile[];
}

export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';

export interface DiffFile {
  path: string;
  previousPath: string | null;
  status: DiffStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
  /** Unified-Diff-Hunks. Fehlt bei Binärdateien und zu großen Diffs. */
  hunks: DiffHunk[] | null;
  /** Gesetzt, wenn der Diff wegen Größe abgeschnitten wurde. */
  truncated: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'context' | 'addition' | 'deletion';
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface BranchInfo {
  name: string;
  oid: string;
  isDefault: boolean;
  isProtected: boolean;
  lastCommit: CommitSummary;
  /** Commits vor/hinter dem Default-Branch. Null, wenn nicht berechnet. */
  aheadBehind: { ahead: number; behind: number } | null;
}

export interface TagInfo {
  name: string;
  oid: string;
  /** Bei annotierten Tags der Commit, auf den das Tag-Objekt zeigt. */
  targetOid: string;
  isAnnotated: boolean;
  message: string | null;
  tagger: GitSignature | null;
  lastCommit: CommitSummary | null;
}

export interface BlobContent {
  path: string;
  oid: string;
  size: number;
  isBinary: boolean;
  /** UTF-8-Inhalt. Null bei Binärdateien oder wenn die Datei zu groß ist. */
  content: string | null;
  /** Gesetzt, wenn die Datei die Anzeigegrenze überschreitet. */
  tooLarge: boolean;
  encoding: 'utf-8' | 'base64' | null;
  language: string | null;
  lineCount: number | null;
}

// ---------------------------------------------------------------------------
// Benutzer
// ---------------------------------------------------------------------------

export interface UserRef {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface UserProfile extends UserRef {
  bio: string | null;
  company: string | null;
  location: string | null;
  websiteUrl: string | null;
  socialLinks: SocialLink[];
  /** Nur sichtbar, wenn der Benutzer die E-Mail öffentlich gestellt hat. */
  email: string | null;
  isAdmin: boolean;
  createdAt: string;
  repositoryCount: number;
  followerCount: number;
  followingCount: number;
}

export interface SocialLink {
  label: string;
  url: string;
}

export interface SessionInfo {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** True für die Session, mit der die Anfrage gestellt wurde. */
  isCurrent: boolean;
}

export interface Viewer extends UserRef {
  email: string;
  emailVerified: boolean;
  isAdmin: boolean;
  twoFactorEnabled: boolean;
}

// ---------------------------------------------------------------------------
// API-Konventionen
// ---------------------------------------------------------------------------

export interface Paginated<T> {
  items: T[];
  page: number;
  perPage: number;
  totalCount: number;
  hasNextPage: boolean;
}

/**
 * Einheitliches Fehlerformat aller API-Endpunkte.
 * `fieldErrors` ist gesetzt, wenn eine Validierung fehlgeschlagen ist.
 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    fieldErrors?: Record<string, string[]>;
  };
}

export const API_ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'payload_too_large',
  'maintenance',
  'two_factor_required',
  'internal_error',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Validierungsregeln (von Backend und Frontend gemeinsam genutzt)
// ---------------------------------------------------------------------------

/**
 * Benutzer- und Organisationsnamen teilen sich einen Namensraum, damit
 * /:owner eindeutig auflösbar bleibt.
 */
export const NAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|[-_](?=[a-zA-Z0-9])){0,38}$/;
export const REPO_NAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,98}[a-zA-Z0-9_-])?$/;
export const BRANCH_NAME_PATTERN = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)[^\s~^:?*[\\\x00-\x1f\x7f]+(?<!\/)(?<!\.lock)$/;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

/**
 * Namen, die nicht als Benutzer- oder Organisationsname vergeben werden dürfen,
 * weil sie mit Anwendungsrouten kollidieren würden.
 */
export const RESERVED_NAMES = new Set([
  'about', 'admin', 'api', 'assets', 'auth', 'blog', 'contact', 'dashboard',
  'docs', 'explore', 'favicon.ico', 'features', 'forge', 'help', 'home',
  'issues', 'login', 'logout', 'new', 'notifications', 'organizations',
  'orgs', 'pricing', 'privacy', 'public', 'pulls', 'register', 'repositories',
  'robots.txt', 'search', 'security', 'session', 'settings', 'signin',
  'signup', 'static', 'status', 'support', 'terms', 'user', 'users',
]);

/** Repository-Namen, die zu Pfadkonflikten führen würden. */
export const RESERVED_REPO_NAMES = new Set(['.', '..', '.git', 'new', 'settings']);

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/** Prüft, ob `actual` mindestens die Stufe `required` erreicht. */
export function hasAccess(actual: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_LEVEL_RANK[actual] >= ACCESS_LEVEL_RANK[required];
}

/** Gibt die höhere von zwei Zugriffsstufen zurück. */
export function maxAccess(a: AccessLevel, b: AccessLevel): AccessLevel {
  return ACCESS_LEVEL_RANK[a] >= ACCESS_LEVEL_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Issues und Pull Requests
// ---------------------------------------------------------------------------

export const ISSUE_KINDS = ['issue', 'pull_request'] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export const ISSUE_STATES = ['open', 'closed'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

export const ISSUE_CLOSE_REASONS = ['completed', 'not_planned', 'duplicate', 'merged'] as const;
export type IssueCloseReason = (typeof ISSUE_CLOSE_REASONS)[number];

export const MERGE_STRATEGIES = ['merge', 'squash', 'rebase'] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

export const MERGEABLE_STATES = ['unknown', 'clean', 'conflicted', 'behind', 'blocked'] as const;
export type MergeableState = (typeof MERGEABLE_STATES)[number];

export const REVIEW_STATES = [
  'pending',
  'commented',
  'approved',
  'changes_requested',
  'dismissed',
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export interface LabelRef {
  id: string;
  name: string;
  color: string;
  description: string | null;
}

export interface MilestoneRef {
  id: string;
  number: number;
  title: string;
  state: IssueState;
  dueOn: string | null;
  openIssueCount?: number;
  closedIssueCount?: number;
  description?: string | null;
}

export interface ReactionSummary {
  content: string;
  count: number;
  viewerReacted: boolean;
}

export interface IssueSummary {
  id: string;
  number: number;
  kind: IssueKind;
  title: string;
  state: IssueState;
  closeReason: IssueCloseReason | null;
  author: UserRef | null;
  labels: LabelRef[];
  assignees: UserRef[];
  milestone: MilestoneRef | null;
  commentCount: number;
  isLocked: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Nur bei Pull Requests gesetzt. */
  /**
   * Nur bei Pull Requests gesetzt. Die Zählwerte fehlen in Listenansichten,
   * weil sie dort einen Diff je Zeile erfordern würden.
   */
  pullRequest: {
    isDraft: boolean;
    merged: boolean;
    baseBranch: string;
    headBranch: string;
    mergeableState: MergeableState;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
  } | null;
}

export interface IssueDetail extends IssueSummary {
  body: string | null;
  repositoryFullName: string;
  reactions: ReactionSummary[];
  /** Rechte des Betrachters auf genau dieses Issue. */
  viewerCanEdit: boolean;
  viewerCanClose: boolean;
  viewerCanComment?: boolean;
}

export interface IssueComment {
  id: string;
  author: UserRef | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  reactions: ReactionSummary[];
  viewerCanEdit: boolean;
}

export interface IssueEvent {
  id: string;
  eventType: string;
  actor: UserRef | null;
  data: Record<string, unknown>;
  createdAt: string;
}

/** Kommentare und Ereignisse zusammengeführt und chronologisch sortiert. */
export type TimelineEntry =
  | { type: 'comment'; at: string; comment: IssueComment }
  | { type: 'event'; at: string; event: IssueEvent }
  | { type: 'review'; at: string; review: PullRequestReview };

export interface PullRequestDetail extends IssueDetail {
  base: PullRequestRef;
  head: PullRequestRef;
  isDraft: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergedBy: UserRef | null;
  mergeStrategy: MergeStrategy | null;
  mergeCommitSha: string | null;
  mergeableState: MergeableState;
  conflictingFiles: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  /** Das jeweils letzte abgegebene Review je Person. */
  reviews?: PullRequestReview[];
  /**
   * Reviewer mit ihrem aktuellen Stand. `pending` bedeutet: angefragt, aber
   * noch kein Review abgegeben.
   */
  reviewers: { user: UserRef; state: ReviewState }[];
  checks: MergeChecks;
  viewerCanMerge?: boolean;
  allowedStrategies: MergeStrategy[];
}

export interface PullRequestReview {
  id: string;
  reviewer: UserRef | null;
  state: ReviewState;
  body: string | null;
  commitSha: string | null;
  submittedAt: string | null;
  createdAt: string;
  /** True, wenn das Review auf einem überholten Commit beruht. */
  isStale?: boolean;
  comments: ReviewComment[];
}

/**
 * Ergebnis der Merge-Prüfungen eines Pull Requests.
 * Jede Prüfung wird einzeln ausgewiesen, damit die Oberfläche benennen kann,
 * was einem Merge konkret entgegensteht.
 */
export interface MergeChecks {
  items: {
    key: string;
    label: string;
    passed: boolean;
    detail?: string;
  }[];
  /** True, wenn jede einzelne Prüfung bestanden wurde. */
  canMerge: boolean;
}

/** Ein Ende eines Pull Requests (Basis oder Head). */
export interface PullRequestRef {
  branch: string;
  sha: string | null;
  repositoryFullName: string | null;
}

export interface ReviewComment {
  id: string;
  author: UserRef | null;
  body: string;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: 'left' | 'right';
  commitSha: string;
  replyToId: string | null;
  isResolved: boolean;
  createdAt: string;
  editedAt: string | null;
}

// ---------------------------------------------------------------------------
// Organisationen
// ---------------------------------------------------------------------------

export interface OrganizationSummary {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  memberCount: number;
  repositoryCount: number;
  createdAt: string;
  /** Rolle des Betrachters, null wenn er kein Mitglied ist. */
  viewerRole: OrgRole | null;
}

export interface OrganizationMember {
  user: UserRef;
  role: OrgRole;
  isPublic: boolean;
  joinedAt: string;
}

export interface TeamSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  defaultPermission: AccessLevel;
  memberCount: number;
  repositoryCount: number;
}

// ---------------------------------------------------------------------------
// Benachrichtigungen
// ---------------------------------------------------------------------------

export interface NotificationItem {
  id: string;
  subjectType: string;
  subjectId: string;
  reason: string;
  title: string;
  targetPath: string;
  repositoryFullName: string | null;
  actor: UserRef | null;
  readAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

export interface ReleaseSummary {
  id: string;
  tagName: string;
  name: string | null;
  body: string | null;
  isDraft: boolean;
  isPrerelease: boolean;
  author: UserRef | null;
  publishedAt: string | null;
  createdAt: string;
  assets: ReleaseAsset[];
}

export interface ReleaseAsset {
  id: string;
  name: string;
  label: string | null;
  contentType: string | null;
  sizeBytes: number;
  downloadCount: number;
  downloadUrl: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Workflows und CI
// ---------------------------------------------------------------------------

export const RUN_STATUSES = [
  'queued',
  'waiting',
  'running',
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'skipped',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** True, wenn der Status einen abgeschlossenen Lauf bezeichnet. */
export function isTerminalStatus(status: RunStatus): boolean {
  return ['success', 'failure', 'cancelled', 'timed_out', 'skipped'].includes(status);
}

export interface WorkflowSummary {
  id: string;
  name: string;
  path: string;
  isEnabled: boolean;
  parseError: string | null;
  schedules?: string[];
  lastRun: WorkflowRunSummary | null;
}

export interface WorkflowRunSummary {
  id: string;
  runNumber: number;
  runAttempt: number;
  event: string;
  status: RunStatus;
  workflowName: string;
  headBranch: string | null;
  headSha: string;
  triggeredBy: UserRef | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  durationMs: number | null;
}

export interface WorkflowRunDetail extends WorkflowRunSummary {
  repositoryFullName?: string;
  jobs: WorkflowJobDetail[];
  artifacts?: { id: string; name: string; sizeBytes: number; createdAt?: string }[];
  viewerCanRerun?: boolean;
  viewerCanCancel?: boolean;
}

export interface WorkflowJobDetail {
  id: string;
  jobKey: string;
  name: string;
  status: RunStatus;
  requiredLabels: string[];
  dependsOn: string[];
  runnerName: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs?: number | null;
  steps: WorkflowStepDetail[];
}

/** Alias für Listenansichten, die dieselbe Struktur verwenden. */
export type WorkflowJobSummary = WorkflowJobDetail;

export interface WorkflowStepDetail {
  id: string;
  stepNumber: number;
  name: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

export type WorkflowStepSummary = WorkflowStepDetail;

export interface RunnerSummary {
  id: string;
  name: string;
  scope: 'repository' | 'organization' | 'platform';
  labels: string[];
  status: 'offline' | 'idle' | 'busy' | 'disabled';
  osName: string | null;
  architecture: string | null;
  version: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface CollaboratorEntry {
  user: UserRef;
  permission: AccessLevel;
  /**
   * Woher die Berechtigung stammt. Für die Oberfläche wichtig, weil geerbte
   * Rechte nicht direkt entzogen werden können.
   */
  source: 'direct' | 'team' | 'organization' | 'owner' | string;
  teamName?: string | null;
  createdAt?: string;
}

export interface BranchProtectionRule {
  id: string;
  pattern: string;
  requirePullRequest: boolean;
  requiredApprovals: number;
  dismissStaleReviews: boolean;
  requireStatusChecks: boolean;
  requiredStatusChecks: string[];
  requireLinearHistory: boolean;
  blockForcePush: boolean;
  blockDeletion: boolean;
}

export interface WebhookSummary {
  id: string;
  url: string;
  events: string[];
  contentType: string;
  isActive: boolean;
  consecutiveFailures: number;
  hasSecret: boolean;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  responseStatus: number | null;
  durationMs: number | null;
  error: string | null;
  attempt: number;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  actorType: string;
  actor: UserRef | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  repositoryFullName: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface PlatformStats {
  users: { total: number; active: number; admins: number; newLast30Days: number };
  repositories: { total: number; public: number; private: number; forks: number };
  organizations: number;
  issues: { open: number; closed: number };
  pullRequests: { open: number; merged: number };
  workflowRuns: { last24h: number; failedLast24h: number };
  storageBytes: number;
}

/** Suchtreffer über verschiedene Objekttypen hinweg. */
export interface SearchResults {
  repositories: RepositorySummary[];
  code: CodeSearchHit[];
  issues: (IssueSummary & { repositoryFullName: string })[];
  commits: CommitSearchHit[];
  users: UserRef[];
  organizations: OrganizationSummary[];
  counts: Record<string, number>;
}

export interface CodeSearchHit {
  repositoryFullName: string;
  path: string;
  ref: string;
  language: string | null;
  matches: { lineNumber: number; content: string }[];
}

export interface CommitSearchHit {
  repositoryFullName: string;
  oid: string;
  shortOid: string;
  subject: string;
  authorName: string;
  author: UserRef | null;
  committedAt: string;
}
