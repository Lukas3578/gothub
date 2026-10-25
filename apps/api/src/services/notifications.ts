/**
 * Benachrichtigungen.
 *
 * Zwei Einstiegspunkte:
 *  - `notify` mit ausdrücklicher Empfängerliste, für Ereignisse ohne Issue
 *    (etwa ein fehlgeschlagener Workflow-Lauf).
 *  - `notifyIssueActivity` für Issues und Pull Requests; die Empfänger werden
 *    aus Autor, Zugewiesenen, Reviewern, Beobachtern und Erwähnungen abgeleitet.
 *
 * Zwei Regeln werden hier durchgesetzt und dürfen nirgends umgangen werden:
 *  - Niemand wird über die eigene Handlung benachrichtigt.
 *  - Niemand bekommt eine Benachrichtigung zu einem Repository, das er nicht
 *    lesen darf. Der Titel enthält den Issue-Titel und würde sonst Inhalte
 *    privater Repositories preisgeben.
 */

import { EventEmitter } from 'node:events';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { NotificationItem } from '@forge/shared';
import { hasAccess } from '@forge/shared';
import { db } from '../db/index.js';
import {
  issueAssignees,
  issues,
  namespaces,
  notifications,
  repositories,
  reviewRequests,
  users,
  watches,
} from '../db/schema.js';
import { loadRepository, resolveRepositoryAccess } from './permissions.js';

export type NotificationReason =
  | 'assign'
  | 'author'
  | 'comment'
  | 'mention'
  | 'review_requested'
  | 'state_change'
  | 'subscribed'
  | 'workflow_failure';

/**
 * Kanal für den SSE-Stream. Pro Prozess eine Instanz.
 *
 * Bei mehreren API-Instanzen hinter einem Load Balancer erreicht ein Ereignis
 * nur die Instanz, die es erzeugt hat. Für den Mehrprozessbetrieb müsste hier
 * Redis Pub/Sub eingehängt werden; die Schnittstelle ist bewusst so schmal,
 * dass dieser Austausch nur diese Datei betrifft.
 */
export const notificationBus = new EventEmitter();
// Viele gleichzeitig offene SSE-Verbindungen sind der Normalfall, keine Leckage.
notificationBus.setMaxListeners(0);

export interface NotifyRecipient {
  userId: string | null;
  reason: NotificationReason;
}

export interface NotifyInput {
  repositoryId: string;
  subjectType: 'issue' | 'pull_request' | 'workflow_run' | 'release';
  subjectId: string;
  title: string;
  targetPath: string;
  actorId: string | null;
  recipients: NotifyRecipient[];
}

/**
 * Legt Benachrichtigungen an und stößt den Echtzeit-Stream an.
 *
 * Fehler werden nicht nach oben gereicht; die Aufrufer hängen ein `.catch()`
 * an, weil eine nicht zugestellte Benachrichtigung niemals dazu führen darf,
 * dass das Anlegen eines Issues oder ein Merge fehlschlägt.
 */
export async function notify(input: NotifyInput): Promise<void> {
  // Je Benutzer nur eine Benachrichtigung; der erste Grund gewinnt, weil die
  // Liste von der spezifischsten zur allgemeinsten Quelle aufgebaut wird.
  const byUser = new Map<string, NotificationReason>();
  for (const recipient of input.recipients) {
    if (!recipient.userId) continue;
    if (recipient.userId === input.actorId) continue;
    if (!byUser.has(recipient.userId)) byUser.set(recipient.userId, recipient.reason);
  }

  if (byUser.size === 0) return;

  const permitted = await filterByReadAccess(input.repositoryId, [...byUser.keys()]);
  if (permitted.length === 0) return;

  const rows = permitted.map((userId) => ({
    userId,
    repositoryId: input.repositoryId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    reason: byUser.get(userId)!,
    title: input.title.slice(0, 500),
    targetPath: input.targetPath.slice(0, 1000),
    actorId: input.actorId,
  }));

  const created = await db.insert(notifications).values(rows).returning();

  for (const row of created) {
    notificationBus.emit(`user:${row.userId}`, {
      id: row.id,
      title: row.title,
      targetPath: row.targetPath,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    });
  }
}

export type IssueActivityKind =
  | 'opened'
  | 'commented'
  | 'state_change'
  | 'review'
  | 'review_requested'
  | 'assigned';

export interface IssueActivityInput {
  issueId: string;
  repositoryId: string;
  repositoryFullName: string;
  actorId: string | null;
  title: string;
  kind: IssueActivityKind;
  /** Text, aus dem @-Erwähnungen gelesen werden (Issue-Text oder Kommentar). */
  mentionSource?: string;
  /** Ausdrücklich zusätzlich zu benachrichtigende Benutzer. */
  extraUserIds?: string[];
  /** Wie `extraUserIds`, aber mit eigenem Grund je Empfänger. */
  extraRecipients?: NotifyRecipient[];
}

/**
 * Benachrichtigt die an einem Issue oder Pull Request Beteiligten.
 *
 * Die Reihenfolge der Quellen bestimmt, welcher Grund angezeigt wird:
 * eine Erwähnung ist aussagekräftiger als "beobachtet dieses Repository".
 */
export async function notifyIssueActivity(input: IssueActivityInput): Promise<void> {
  const [issue] = await db
    .select({
      authorId: issues.authorId,
      number: issues.number,
      kind: issues.kind,
    })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .limit(1);

  if (!issue) return;

  const recipients: NotifyRecipient[] = [];

  // 1. Erwähnungen – der spezifischste Grund.
  if (input.mentionSource) {
    const mentioned = await resolveMentions(extractMentions(input.mentionSource));
    for (const userId of mentioned) recipients.push({ userId, reason: 'mention' });
  }

  // 2. Ausdrücklich angegebene Empfänger (etwa ein angefragter Reviewer).
  for (const userId of input.extraUserIds ?? []) {
    recipients.push({
      userId,
      reason: input.kind === 'review_requested' ? 'review_requested' : 'assign',
    });
  }
  for (const recipient of input.extraRecipients ?? []) recipients.push(recipient);

  // 3. Zugewiesene.
  const assignees = await db
    .select({ userId: issueAssignees.userId })
    .from(issueAssignees)
    .where(eq(issueAssignees.issueId, input.issueId));
  for (const row of assignees) recipients.push({ userId: row.userId, reason: 'assign' });

  // 4. Angefragte Reviewer.
  const reviewers = await db
    .select({ userId: reviewRequests.reviewerId })
    .from(reviewRequests)
    .where(eq(reviewRequests.issueId, input.issueId));
  for (const row of reviewers) {
    recipients.push({ userId: row.userId, reason: 'review_requested' });
  }

  // 5. Autor – bekommt alles außer dem eigenen Anlegen.
  if (issue.authorId && input.kind !== 'opened') {
    recipients.push({ userId: issue.authorId, reason: 'author' });
  }

  // 6. Beobachter des Repositories.
  const watchers = await db
    .select({ userId: watches.userId })
    .from(watches)
    .where(and(eq(watches.repositoryId, input.repositoryId), eq(watches.level, 'all')));
  for (const row of watchers) {
    recipients.push({
      userId: row.userId,
      reason: input.kind === 'commented' ? 'comment' : 'subscribed',
    });
  }

  const subjectType = issue.kind === 'pull_request' ? 'pull_request' : 'issue';
  const section = issue.kind === 'pull_request' ? 'pulls' : 'issues';

  await notify({
    repositoryId: input.repositoryId,
    subjectType,
    subjectId: input.issueId,
    title: input.title,
    targetPath: `/${input.repositoryFullName}/${section}/${issue.number}`,
    actorId: input.actorId,
    recipients,
  });
}

/**
 * Entfernt Empfänger ohne Leserecht.
 *
 * Für öffentliche Repositories genügt ein einziger Test; nur bei privaten und
 * internen wird je Benutzer geprüft.
 */
async function filterByReadAccess(repositoryId: string, userIds: string[]): Promise<string[]> {
  const rows = await db
    .select({
      name: repositories.name,
      visibility: repositories.visibility,
      ownerName: namespaces.name,
    })
    .from(repositories)
    .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
    .where(eq(repositories.id, repositoryId))
    .limit(1);

  const row = rows[0];
  if (!row) return [];
  if (row.visibility === 'public') return userIds;

  const context = await loadRepository(row.ownerName, row.name);
  if (!context) return [];

  const allowed: string[] = [];
  for (const userId of userIds) {
    const access = await resolveRepositoryAccess(context, { id: userId, isAdmin: false });
    if (hasAccess(access.level, 'read')) allowed.push(userId);
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// Erwähnungen
// ---------------------------------------------------------------------------

/**
 * Findet @benutzername-Erwähnungen.
 *
 * Code-Blöcke und Inline-Code werden vorher entfernt: ein Decorator oder eine
 * E-Mail-Adresse in einem Beispiel soll niemanden benachrichtigen.
 */
export function extractMentions(text: string | null | undefined): string[] {
  if (!text) return [];

  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

  const found = new Set<string>();
  // Vor dem @ darf kein Wortzeichen stehen, sonst trifft das Muster den Teil
  // hinter einer E-Mail-Adresse.
  const pattern = /(?:^|[^\w@/])@([a-zA-Z0-9](?:[a-zA-Z0-9]|[-_](?=[a-zA-Z0-9])){0,38})/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutCode)) !== null) {
    found.add(match[1]!.toLowerCase());
  }
  return [...found];
}

/** Löst Erwähnungen in Benutzer-IDs auf; unbekannte Namen werden ignoriert. */
export async function resolveMentions(usernames: string[]): Promise<string[]> {
  if (usernames.length === 0) return [];

  const rows = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
    .where(inArray(namespaces.nameLower, usernames));

  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Abfrage
// ---------------------------------------------------------------------------

export async function listNotifications(
  userId: string,
  options: { unreadOnly?: boolean; page?: number; perPage?: number } = {},
): Promise<{ items: NotificationItem[]; unreadCount: number; hasNextPage: boolean }> {
  const perPage = Math.min(options.perPage ?? 30, 100);
  const page = Math.max(options.page ?? 1, 1);

  const conditions = [eq(notifications.userId, userId)];
  if (options.unreadOnly) conditions.push(isNull(notifications.readAt));

  const actorNamespaces = sql`actor_ns`;

  const rows = await db
    .select({
      notification: notifications,
      repoName: repositories.name,
      ownerName: namespaces.name,
      actorId: users.id,
      actorUsername: sql<string | null>`actor_ns.name`,
      actorDisplayName: users.displayName,
    })
    .from(notifications)
    .leftJoin(repositories, eq(repositories.id, notifications.repositoryId))
    .leftJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
    .leftJoin(users, eq(users.id, notifications.actorId))
    .leftJoin(sql`namespaces AS ${actorNamespaces}`, sql`actor_ns.id = ${users.namespaceId}`)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(perPage + 1)
    .offset((page - 1) * perPage);

  const hasNextPage = rows.length > perPage;

  const items: NotificationItem[] = rows.slice(0, perPage).map((row) => ({
    id: row.notification.id,
    subjectType: row.notification.subjectType,
    subjectId: row.notification.subjectId,
    reason: row.notification.reason,
    title: row.notification.title,
    targetPath: row.notification.targetPath,
    repositoryFullName: row.ownerName && row.repoName ? `${row.ownerName}/${row.repoName}` : null,
    actor: row.actorId
      ? {
          id: row.actorId,
          username: row.actorUsername ?? '',
          displayName: row.actorDisplayName,
          avatarUrl: null,
        }
      : null,
    readAt: row.notification.readAt?.toISOString() ?? null,
    createdAt: row.notification.createdAt.toISOString(),
  }));

  return { items, unreadCount: await unreadCount(userId), hasNextPage };
}

export async function markRead(userId: string, notificationIds: string[]): Promise<void> {
  if (notificationIds.length === 0) return;
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        inArray(notifications.id, notificationIds),
        isNull(notifications.readAt),
      ),
    );
  notificationBus.emit(`user:${userId}`, { type: 'read' });
}

export async function markAllRead(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  notificationBus.emit(`user:${userId}`, { type: 'read_all' });
}

export async function unreadCount(userId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return rows[0]?.count ?? 0;
}
