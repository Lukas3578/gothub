/**
 * Issues und Pull Requests.
 *
 * Beide liegen in derselben Tabelle und teilen sich pro Repository einen
 * Nummernkreis – so wie es Benutzer erwarten, wenn sie "#42" schreiben, ohne
 * vorher zu wissen, ob es ein Issue oder ein Pull Request ist.
 *
 * Die Vergabe der Nummer läuft über einen Zähler auf dem Repository, der in
 * derselben Transaktion hochgezählt wird. Ein `MAX(number) + 1` wäre bei
 * gleichzeitigen Anfragen eine Wettlaufsituation.
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type {
  IssueComment as IssueCommentDto,
  IssueDetail,
  IssueEvent as IssueEventDto,
  IssueKind,
  IssueState,
  IssueSummary,
  LabelRef,
  MilestoneRef,
  ReactionSummary,
  TimelineEntry,
  UserRef,
} from '@forge/shared';
import { db } from '../db/index.js';
import {
  issueAssignees,
  issueComments,
  issueEvents,
  issueLabels,
  issueLinks,
  issues,
  labels,
  milestones,
  namespaces,
  pullRequests,
  reactions,
  repositories,
  users,
} from '../db/schema.js';
import { conflict, forbidden, isUniqueViolation, notFound, validationFailed } from '../lib/errors.js';
import { config } from '../config.js';
import { avatarUrl } from './avatars.js';

// ---------------------------------------------------------------------------
// Hilfsfunktionen für die Darstellung
// ---------------------------------------------------------------------------

export function toUserRef(row: {
  id: string;
  username: string;
  displayName: string | null;
  avatarPath: string | null;
}): UserRef {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: avatarUrl(row.avatarPath),
  };
}

/** Lädt Benutzerreferenzen zu einer Menge von IDs in einem Rutsch. */
export async function loadUserRefs(ids: (string | null)[]): Promise<Map<string, UserRef>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();

  const rows = await db
    .select({
      id: users.id,
      username: namespaces.name,
      displayName: users.displayName,
      avatarPath: users.avatarPath,
    })
    .from(users)
    .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
    .where(inArray(users.id, unique));

  return new Map(rows.map((row) => [row.id, toUserRef(row)]));
}

/** Fasst Reaktionen je Subjekt zusammen, inklusive der eigenen Beteiligung. */
export async function loadReactions(
  subjectType: string,
  subjectIds: string[],
  viewerId: string | null,
): Promise<Map<string, ReactionSummary[]>> {
  if (subjectIds.length === 0) return new Map();

  const rows = await db
    .select({
      subjectId: reactions.subjectId,
      content: reactions.content,
      userId: reactions.userId,
    })
    .from(reactions)
    .where(
      and(eq(reactions.subjectType, subjectType), inArray(reactions.subjectId, subjectIds)),
    );

  const grouped = new Map<string, Map<string, { count: number; viewerReacted: boolean }>>();

  for (const row of rows) {
    let bySubject = grouped.get(row.subjectId);
    if (!bySubject) {
      bySubject = new Map();
      grouped.set(row.subjectId, bySubject);
    }
    const entry = bySubject.get(row.content) ?? { count: 0, viewerReacted: false };
    entry.count += 1;
    if (viewerId && row.userId === viewerId) entry.viewerReacted = true;
    bySubject.set(row.content, entry);
  }

  const result = new Map<string, ReactionSummary[]>();
  for (const [subjectId, bySubject] of grouped) {
    result.set(
      subjectId,
      [...bySubject]
        .map(([content, value]) => ({ content, ...value }))
        .sort((a, b) => b.count - a.count),
    );
  }
  return result;
}

export const ALLOWED_REACTIONS = [
  '+1',
  '-1',
  'laugh',
  'hooray',
  'confused',
  'heart',
  'rocket',
  'eyes',
] as const;

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

export interface IssueListFilter {
  kind?: IssueKind;
  state?: IssueState | 'all';
  labels?: string[];
  assignee?: string;
  author?: string;
  milestone?: string;
  search?: string;
  sort?: 'newest' | 'oldest' | 'updated' | 'comments';
  page: number;
  perPage: number;
}

export async function listIssues(
  repositoryId: string,
  filter: IssueListFilter,
  viewerId: string | null,
): Promise<{ items: IssueSummary[]; totalCount: number; openCount: number; closedCount: number }> {
  const conditions: SQL[] = [eq(issues.repositoryId, repositoryId)];

  if (filter.kind) conditions.push(eq(issues.kind, filter.kind));
  if (filter.state && filter.state !== 'all') conditions.push(eq(issues.state, filter.state));

  if (filter.search) {
    // Einfache Teilstringsuche über Titel und Text. Für große Instanzen gehört
    // hier ein Volltextindex hin; das ist in der Suche separat umgesetzt.
    const pattern = `%${filter.search}%`;
    conditions.push(sql`(${issues.title} LIKE ${pattern} OR ${issues.body} LIKE ${pattern})`);
  }

  if (filter.author) {
    conditions.push(
      sql`${issues.authorId} = (
        SELECT ${users.id} FROM ${users}
        JOIN ${namespaces} ON ${namespaces.id} = ${users.namespaceId}
        WHERE ${namespaces.nameLower} = ${filter.author.toLowerCase()}
      )`,
    );
  }

  if (filter.assignee) {
    if (filter.assignee === 'none') {
      conditions.push(
        sql`NOT EXISTS (SELECT 1 FROM ${issueAssignees} WHERE ${issueAssignees.issueId} = ${issues.id})`,
      );
    } else {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${issueAssignees}
          JOIN ${users} ON ${users.id} = ${issueAssignees.userId}
          JOIN ${namespaces} ON ${namespaces.id} = ${users.namespaceId}
          WHERE ${issueAssignees.issueId} = ${issues.id}
            AND ${namespaces.nameLower} = ${filter.assignee.toLowerCase()}
        )`,
      );
    }
  }

  if (filter.milestone) {
    if (filter.milestone === 'none') {
      conditions.push(isNull(issues.milestoneId));
    } else {
      conditions.push(
        sql`${issues.milestoneId} = (
          SELECT ${milestones.id} FROM ${milestones}
          WHERE ${milestones.repositoryId} = ${repositoryId}
            AND ${milestones.number} = ${Number(filter.milestone) || 0}
        )`,
      );
    }
  }

  // Alle angegebenen Labels müssen zutreffen (UND-Verknüpfung), nicht nur eines.
  for (const labelName of filter.labels ?? []) {
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${issueLabels}
        JOIN ${labels} ON ${labels.id} = ${issueLabels.labelId}
        WHERE ${issueLabels.issueId} = ${issues.id} AND ${labels.name} = ${labelName}
      )`,
    );
  }

  const where = and(...conditions);

  const orderBy =
    filter.sort === 'oldest'
      ? asc(issues.createdAt)
      : filter.sort === 'updated'
        ? desc(issues.updatedAt)
        : filter.sort === 'comments'
          ? desc(issues.commentCount)
          : desc(issues.createdAt);

  const rows = await db
    .select()
    .from(issues)
    .where(where)
    .orderBy(orderBy)
    .limit(filter.perPage)
    .offset((filter.page - 1) * filter.perPage);

  const totalRows = await db.select({ total: sql<number>`count(*)` }).from(issues).where(where);

  // Zähler für die Umschaltung offen/geschlossen. Bewusst ohne die übrigen
  // Filter: die Umschaltung soll zeigen, wie viele Issues es insgesamt gibt,
  // nicht wie viele der aktuellen Filterung entsprechen.
  const openClosed = await db
    .select({ state: issues.state, count: sql<number>`count(*)` })
    .from(issues)
    .where(
      and(
        eq(issues.repositoryId, repositoryId),
        filter.kind ? eq(issues.kind, filter.kind) : sql`true`,
      ),
    )
    .groupBy(issues.state);

  const items = await hydrateIssues(rows, viewerId);

  return {
    items,
    totalCount: totalRows[0]?.total ?? 0,
    openCount: openClosed.find((r) => r.state === 'open')?.count ?? 0,
    closedCount: openClosed.find((r) => r.state === 'closed')?.count ?? 0,
  };
}

/** Ergänzt Issue-Zeilen um Autor, Labels, Assignees, Milestone und PR-Daten. */
export async function hydrateIssues(
  rows: (typeof issues.$inferSelect)[],
  viewerId: string | null,
): Promise<IssueSummary[]> {
  if (rows.length === 0) return [];

  const issueIds = rows.map((row) => row.id);

  const [labelRows, assigneeRows, milestoneRows, prRows, userRefs] = await Promise.all([
    db
      .select({ issueId: issueLabels.issueId, label: labels })
      .from(issueLabels)
      .innerJoin(labels, eq(labels.id, issueLabels.labelId))
      .where(inArray(issueLabels.issueId, issueIds)),
    db
      .select({ issueId: issueAssignees.issueId, userId: issueAssignees.userId })
      .from(issueAssignees)
      .where(inArray(issueAssignees.issueId, issueIds)),
    db
      .select()
      .from(milestones)
      .where(
        inArray(
          milestones.id,
          rows.map((r) => r.milestoneId).filter((id): id is string => Boolean(id)),
        ),
      ),
    db.select().from(pullRequests).where(inArray(pullRequests.issueId, issueIds)),
    loadUserRefs([
      ...rows.map((r) => r.authorId),
      ...(
        await db
          .select({ userId: issueAssignees.userId })
          .from(issueAssignees)
          .where(inArray(issueAssignees.issueId, issueIds))
      ).map((r) => r.userId),
    ]),
  ]);

  const labelsByIssue = new Map<string, LabelRef[]>();
  for (const row of labelRows) {
    const list = labelsByIssue.get(row.issueId) ?? [];
    list.push({
      id: row.label.id,
      name: row.label.name,
      color: row.label.color,
      description: row.label.description,
    });
    labelsByIssue.set(row.issueId, list);
  }

  const assigneesByIssue = new Map<string, UserRef[]>();
  for (const row of assigneeRows) {
    const ref = userRefs.get(row.userId);
    if (!ref) continue;
    const list = assigneesByIssue.get(row.issueId) ?? [];
    list.push(ref);
    assigneesByIssue.set(row.issueId, list);
  }

  const milestonesById = new Map(milestoneRows.map((m) => [m.id, m]));
  const prByIssue = new Map(prRows.map((pr) => [pr.issueId, pr]));

  return rows.map((row) => {
    const milestone = row.milestoneId ? milestonesById.get(row.milestoneId) : null;
    const pr = prByIssue.get(row.id);

    return {
      id: row.id,
      number: row.number,
      kind: row.kind,
      title: row.title,
      state: row.state,
      closeReason: row.closeReason,
      author: row.authorId ? (userRefs.get(row.authorId) ?? null) : null,
      labels: (labelsByIssue.get(row.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      assignees: assigneesByIssue.get(row.id) ?? [],
      milestone: milestone
        ? {
            id: milestone.id,
            number: milestone.number,
            title: milestone.title,
            description: milestone.description,
            dueOn: milestone.dueOn?.toISOString() ?? null,
            state: milestone.state,
            openCount: 0,
            closedCount: 0,
          }
        : null,
      commentCount: row.commentCount,
      isLocked: row.isLocked,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
      pullRequest: pr
        ? {
            isDraft: pr.isDraft,
            merged: Boolean(pr.mergedAt),
            baseBranch: pr.baseBranch,
            headBranch: pr.headBranch,
            mergeableState: pr.mergeableState,
          }
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Einzelnes Issue
// ---------------------------------------------------------------------------

export async function getIssue(
  repositoryId: string,
  number: number,
): Promise<typeof issues.$inferSelect> {
  const rows = await db
    .select()
    .from(issues)
    .where(and(eq(issues.repositoryId, repositoryId), eq(issues.number, number)))
    .limit(1);

  if (!rows[0]) throw notFound('Issue nicht gefunden.');
  return rows[0];
}

export async function toIssueDetail(
  row: typeof issues.$inferSelect,
  repositoryFullName: string,
  viewer: { id: string } | null,
  canWrite: boolean,
): Promise<IssueDetail> {
  const [summary] = await hydrateIssues([row], viewer?.id ?? null);
  const reactionMap = await loadReactions('issue', [row.id], viewer?.id ?? null);

  const isAuthor = Boolean(viewer && row.authorId === viewer.id);

  return {
    ...summary!,
    body: row.body,
    reactions: reactionMap.get(row.id) ?? [],
    // Den Text darf ändern, wer ihn geschrieben hat oder das Repository
    // verwaltet. Schließen darf zusätzlich jeder mit Schreibrecht.
    viewerCanEdit: isAuthor || canWrite,
    viewerCanClose: isAuthor || canWrite,
    repositoryFullName,
  };
}

// ---------------------------------------------------------------------------
// Anlegen und Ändern
// ---------------------------------------------------------------------------

export interface CreateIssueInput {
  title: string;
  body?: string | null;
  labelIds?: string[];
  assigneeIds?: string[];
  milestoneId?: string | null;
}

/**
 * Legt ein Issue an und vergibt die nächste Nummer.
 *
 * Der Zähler wird mit `issueCounter + 1` in derselben Anweisung hochgezählt
 * und zurückgegeben; dadurch kann keine Nummer doppelt vergeben werden, auch
 * wenn zwei Anfragen gleichzeitig eintreffen.
 */
export async function createIssue(
  repositoryId: string,
  input: CreateIssueInput,
  authorId: string,
  kind: IssueKind = 'issue',
): Promise<typeof issues.$inferSelect> {
  const title = input.title.trim();
  if (!title) {
    throw validationFailed('Der Titel darf nicht leer sein.', { title: ['Pflichtfeld.'] });
  }

  return db.transaction(async (tx) => {
    const counterRows = await tx
      .update(repositories)
      .set({ issueCounter: sql`${repositories.issueCounter} + 1` })
      .where(eq(repositories.id, repositoryId))
      .returning({ number: repositories.issueCounter });

    const number = counterRows[0]?.number;
    if (!number) throw notFound('Repository nicht gefunden.');

    const [created] = await tx
      .insert(issues)
      .values({
        repositoryId,
        number,
        kind,
        title,
        body: input.body?.trim() || null,
        authorId,
        milestoneId: input.milestoneId ?? null,
      })
      .returning();

    if (input.labelIds?.length) {
      await tx
        .insert(issueLabels)
        .values(input.labelIds.map((labelId) => ({ issueId: created!.id, labelId })))
        .onConflictDoNothing();
    }

    if (input.assigneeIds?.length) {
      await tx
        .insert(issueAssignees)
        .values(input.assigneeIds.map((userId) => ({ issueId: created!.id, userId })))
        .onConflictDoNothing();
    }

    if (kind === 'issue') {
      await tx
        .update(repositories)
        .set({ openIssueCount: sql`${repositories.openIssueCount} + 1` })
        .where(eq(repositories.id, repositoryId));
    } else {
      await tx
        .update(repositories)
        .set({ openPullRequestCount: sql`${repositories.openPullRequestCount} + 1` })
        .where(eq(repositories.id, repositoryId));
    }

    return created!;
  });
}

export async function updateIssue(
  issueId: string,
  patch: { title?: string; body?: string | null; milestoneId?: string | null },
  actorId: string,
): Promise<void> {
  const update: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw validationFailed('Der Titel darf nicht leer sein.');
    update.title = title;
  }
  if (patch.body !== undefined) update.body = patch.body?.trim() || null;
  if (patch.milestoneId !== undefined) update.milestoneId = patch.milestoneId;

  await db.update(issues).set(update).where(eq(issues.id, issueId));

  if (patch.milestoneId !== undefined) {
    await recordEvent(issueId, actorId, 'milestoned', { milestoneId: patch.milestoneId });
  }
}

/**
 * Ändert den Zustand eines Issues.
 *
 * Die Zähler auf dem Repository werden in derselben Transaktion angepasst, und
 * ein bereits geschlossenes Issue erneut zu schließen ändert nichts – sonst
 * würden die Zähler bei einem Doppelklick auseinanderlaufen.
 */
export async function setIssueState(
  issueId: string,
  state: IssueState,
  reason: IssueDetail['closeReason'],
  actorId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    const issue = rows[0];
    if (!issue) throw notFound('Issue nicht gefunden.');
    if (issue.state === state) return;

    await tx
      .update(issues)
      .set({
        state,
        closeReason: state === 'closed' ? (reason ?? 'completed') : null,
        closedAt: state === 'closed' ? new Date() : null,
        closedById: state === 'closed' ? actorId : null,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issueId));

    const delta = state === 'closed' ? -1 : 1;
    const column = issue.kind === 'issue' ? 'open_issue_count' : 'open_pull_request_count';

    // MAX statt GREATEST: SQLite nennt die Funktion mit mehreren Argumenten
    // so. Der Zähler darf nicht unter null fallen, falls er je aus dem Tritt
    // gerät – ein negativer Zähler in der Oberfläche wäre schlimmer als ein
    // zu hoher.
    await tx.run(
      sql`UPDATE repositories
          SET ${sql.raw(column)} = MAX(${sql.raw(column)} + ${delta}, 0)
          WHERE id = ${issue.repositoryId}`,
    );

    await tx.insert(issueEvents).values({
      issueId,
      actorId,
      eventType: state === 'closed' ? 'closed' : 'reopened',
      data: state === 'closed' ? { reason: reason ?? 'completed' } : {},
    });
  });
}

export async function setLabels(issueId: string, labelIds: string[], actorId: string) {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ labelId: issueLabels.labelId })
      .from(issueLabels)
      .where(eq(issueLabels.issueId, issueId));

    const before = new Set(existing.map((e) => e.labelId));
    const after = new Set(labelIds);

    const added = labelIds.filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));

    await tx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
    if (labelIds.length > 0) {
      await tx.insert(issueLabels).values(labelIds.map((labelId) => ({ issueId, labelId })));
    }
    await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issueId));

    if (added.length || removed.length) {
      await tx.insert(issueEvents).values({
        issueId,
        actorId,
        eventType: 'labeled',
        data: { added, removed },
      });
    }
  });
}

export async function setAssignees(issueId: string, userIds: string[], actorId: string) {
  await db.transaction(async (tx) => {
    await tx.delete(issueAssignees).where(eq(issueAssignees.issueId, issueId));
    if (userIds.length > 0) {
      await tx.insert(issueAssignees).values(userIds.map((userId) => ({ issueId, userId })));
    }
    await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issueId));
    await tx.insert(issueEvents).values({
      issueId,
      actorId,
      eventType: 'assigned',
      data: { assignees: userIds },
    });
  });
}

export async function setLocked(issueId: string, locked: boolean, actorId: string) {
  await db.update(issues).set({ isLocked: locked, updatedAt: new Date() }).where(eq(issues.id, issueId));
  await recordEvent(issueId, actorId, locked ? 'locked' : 'unlocked', {});
}

// ---------------------------------------------------------------------------
// Kommentare
// ---------------------------------------------------------------------------

export async function addComment(
  issueId: string,
  authorId: string,
  body: string,
): Promise<typeof issueComments.$inferSelect> {
  const text = body.trim();
  if (!text) throw validationFailed('Der Kommentar darf nicht leer sein.');

  return db.transaction(async (tx) => {
    const issueRows = await tx.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issueRows[0]) throw notFound('Issue nicht gefunden.');

    // Ob eine gesperrte Unterhaltung beschrieben werden darf, entscheidet die
    // aufrufende Route – sie kennt die Rechte des Benutzers. Hier zu sperren
    // würde auch Verwaltende aussperren, die eine Diskussion abschließen
    // wollen.

    const [created] = await tx
      .insert(issueComments)
      .values({ issueId, authorId, body: text })
      .returning();

    await tx
      .update(issues)
      .set({ commentCount: sql`${issues.commentCount} + 1`, updatedAt: new Date() })
      .where(eq(issues.id, issueId));

    return created!;
  });
}

export async function updateComment(commentId: string, body: string): Promise<void> {
  const text = body.trim();
  if (!text) throw validationFailed('Der Kommentar darf nicht leer sein.');
  await db
    .update(issueComments)
    .set({ body: text, editedAt: new Date() })
    .where(eq(issueComments.id, commentId));
}

export async function deleteComment(commentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ issueId: issueComments.issueId })
      .from(issueComments)
      .where(eq(issueComments.id, commentId))
      .limit(1);
    if (!rows[0]) return;

    await tx.delete(issueComments).where(eq(issueComments.id, commentId));
    await tx
      .update(issues)
      .set({ commentCount: sql`MAX(${issues.commentCount} - 1, 0)` })
      .where(eq(issues.id, rows[0].issueId));
  });
}

// ---------------------------------------------------------------------------
// Verlauf
// ---------------------------------------------------------------------------

export async function recordEvent(
  issueId: string,
  actorId: string | null,
  eventType: string,
  data: Record<string, unknown>,
): Promise<void> {
  await db.insert(issueEvents).values({ issueId, actorId, eventType, data });
}

/**
 * Lädt Kommentare und Ereignisse als eine zeitlich sortierte Liste.
 * Reviews kommen bei Pull Requests in der PR-Schicht dazu.
 */
export async function loadTimeline(
  issueId: string,
  viewer: { id: string } | null,
  canWrite: boolean,
): Promise<TimelineEntry[]> {
  const [commentRows, eventRows] = await Promise.all([
    db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt)),
    db
      .select()
      .from(issueEvents)
      .where(eq(issueEvents.issueId, issueId))
      .orderBy(asc(issueEvents.createdAt)),
  ]);

  const userRefs = await loadUserRefs([
    ...commentRows.map((c) => c.authorId),
    ...eventRows.map((e) => e.actorId),
  ]);

  const reactionMap = await loadReactions(
    'issue_comment',
    commentRows.map((c) => c.id),
    viewer?.id ?? null,
  );

  const entries: TimelineEntry[] = [];

  for (const row of commentRows) {
    const comment: IssueCommentDto = {
      id: row.id,
      author: row.authorId ? (userRefs.get(row.authorId) ?? null) : null,
      body: row.body,
      reactions: reactionMap.get(row.id) ?? [],
      viewerCanEdit: Boolean(viewer && (row.authorId === viewer.id || canWrite)),
      editedAt: row.editedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
    entries.push({ type: 'comment', at: comment.createdAt, comment });
  }

  for (const row of eventRows) {
    const event: IssueEventDto = {
      id: row.id,
      actor: row.actorId ? (userRefs.get(row.actorId) ?? null) : null,
      eventType: row.eventType,
      data: row.data,
      createdAt: row.createdAt.toISOString(),
    };
    entries.push({ type: 'event', at: event.createdAt, event });
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

// ---------------------------------------------------------------------------
// Reaktionen
// ---------------------------------------------------------------------------

export async function toggleReaction(
  subjectType: string,
  subjectId: string,
  userId: string,
  content: string,
): Promise<ReactionSummary[]> {
  if (!(ALLOWED_REACTIONS as readonly string[]).includes(content)) {
    throw validationFailed('Unbekannte Reaktion.');
  }

  const existing = await db
    .select({ id: reactions.id })
    .from(reactions)
    .where(
      and(
        eq(reactions.userId, userId),
        eq(reactions.subjectType, subjectType),
        eq(reactions.subjectId, subjectId),
        eq(reactions.content, content),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await db.delete(reactions).where(eq(reactions.id, existing[0].id));
  } else {
    await db
      .insert(reactions)
      .values({ userId, subjectType, subjectId, content })
      .onConflictDoNothing();
  }

  const map = await loadReactions(subjectType, [subjectId], userId);
  return map.get(subjectId) ?? [];
}

// ---------------------------------------------------------------------------
// Labels und Milestones
// ---------------------------------------------------------------------------

export async function listLabels(repositoryId: string): Promise<LabelRef[]> {
  const rows = await db
    .select()
    .from(labels)
    .where(eq(labels.repositoryId, repositoryId))
    .orderBy(asc(labels.name));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description,
  }));
}

export async function createLabel(
  repositoryId: string,
  input: { name: string; color: string; description?: string | null },
): Promise<LabelRef> {
  const name = input.name.trim();
  const color = input.color.replace(/^#/, '').toLowerCase();

  if (!name) throw validationFailed('Der Name darf nicht leer sein.', { name: ['Pflichtfeld.'] });
  if (!/^[0-9a-f]{6}$/.test(color)) {
    throw validationFailed('Die Farbe muss ein sechsstelliger Hex-Wert sein.', {
      color: ['Zum Beispiel d73a4a.'],
    });
  }

  try {
    const [created] = await db
      .insert(labels)
      .values({ repositoryId, name, color, description: input.description?.trim() || null })
      .returning();
    return {
      id: created!.id,
      name: created!.name,
      color: created!.color,
      description: created!.description,
    };
  } catch (error) {
    if (isUniqueViolation(error, 'labels_repo_name_key', 'labels.name')) {
      throw conflict('Ein Label mit diesem Namen existiert bereits.');
    }
    throw error;
  }
}

export async function updateLabel(
  labelId: string,
  input: { name?: string; color?: string; description?: string | null },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.color !== undefined) {
    const color = input.color.replace(/^#/, '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(color)) throw validationFailed('Ungültige Farbe.');
    patch.color = color;
  }
  if (input.description !== undefined) patch.description = input.description?.trim() || null;

  await db.update(labels).set(patch).where(eq(labels.id, labelId));
}

export async function deleteLabel(labelId: string): Promise<void> {
  await db.delete(labels).where(eq(labels.id, labelId));
}

export async function listMilestones(
  repositoryId: string,
  state: IssueState | 'all' = 'open',
): Promise<MilestoneRef[]> {
  const rows = await db
    .select()
    .from(milestones)
    .where(
      and(
        eq(milestones.repositoryId, repositoryId),
        state === 'all' ? sql`true` : eq(milestones.state, state),
      ),
    )
    .orderBy(asc(milestones.dueOn), asc(milestones.number));

  if (rows.length === 0) return [];

  // Fortschritt je Milestone in einer Abfrage statt je Zeile.
  const counts = await db
    .select({
      milestoneId: issues.milestoneId,
      state: issues.state,
      count: sql<number>`count(*)`,
    })
    .from(issues)
    .where(
      inArray(
        issues.milestoneId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(issues.milestoneId, issues.state);

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    description: row.description,
    dueOn: row.dueOn?.toISOString() ?? null,
    state: row.state,
    openCount: counts.find((c) => c.milestoneId === row.id && c.state === 'open')?.count ?? 0,
    closedCount: counts.find((c) => c.milestoneId === row.id && c.state === 'closed')?.count ?? 0,
  }));
}

export async function createMilestone(
  repositoryId: string,
  input: { title: string; description?: string | null; dueOn?: string | null },
): Promise<MilestoneRef> {
  const title = input.title.trim();
  if (!title) throw validationFailed('Der Titel darf nicht leer sein.');

  return db.transaction(async (tx) => {
    const maxRows = await tx
      .select({ max: sql<number>`COALESCE(MAX(${milestones.number}), 0)` })
      .from(milestones)
      .where(eq(milestones.repositoryId, repositoryId));

    const [created] = await tx
      .insert(milestones)
      .values({
        repositoryId,
        number: (maxRows[0]?.max ?? 0) + 1,
        title,
        description: input.description?.trim() || null,
        dueOn: input.dueOn ? new Date(input.dueOn) : null,
      })
      .returning();

    return {
      id: created!.id,
      number: created!.number,
      title: created!.title,
      description: created!.description,
      dueOn: created!.dueOn?.toISOString() ?? null,
      state: created!.state,
      openCount: 0,
      closedCount: 0,
    };
  });
}

export async function updateMilestone(
  milestoneId: string,
  input: { title?: string; description?: string | null; dueOn?: string | null; state?: IssueState },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.dueOn !== undefined) patch.dueOn = input.dueOn ? new Date(input.dueOn) : null;
  if (input.state !== undefined) {
    patch.state = input.state;
    patch.closedAt = input.state === 'closed' ? new Date() : null;
  }
  await db.update(milestones).set(patch).where(eq(milestones.id, milestoneId));
}

export async function deleteMilestone(milestoneId: string): Promise<void> {
  await db.delete(milestones).where(eq(milestones.id, milestoneId));
}

// ---------------------------------------------------------------------------
// Erwähnungen und Querverweise
// ---------------------------------------------------------------------------

/** Findet @benutzername-Erwähnungen in einem Text. */
export function extractMentions(text: string): string[] {
  const matches = text.matchAll(/(?:^|[^\w@])@([a-zA-Z0-9](?:[a-zA-Z0-9]|[-_](?=[a-zA-Z0-9])){0,38})/g);
  return [...new Set([...matches].map((m) => m[1]!.toLowerCase()))];
}

/** Findet #123-Verweise auf andere Issues im selben Repository. */
export function extractIssueReferences(text: string): number[] {
  const matches = text.matchAll(/(?:^|[^\w])#(\d{1,9})(?!\w)/g);
  return [...new Set([...matches].map((m) => Number(m[1])))];
}

/**
 * Findet Schlüsselwörter, die beim Mergen eines Pull Requests Issues
 * schließen sollen ("closes #12", "fixes #3").
 */
export function extractClosingReferences(text: string): number[] {
  const matches = text.matchAll(
    /\b(?:clos(?:e|es|ed)|fix(?:es|ed)?|resolv(?:e|es|ed)|schließt|behebt)\s+#(\d{1,9})\b/gi,
  );
  return [...new Set([...matches].map((m) => Number(m[1])))];
}

/** Legt Querverweise zwischen Issues an, die in einem Text erwähnt werden. */
export async function linkReferencedIssues(
  repositoryId: string,
  sourceIssueId: string,
  text: string,
  actorId: string,
): Promise<void> {
  const numbers = extractIssueReferences(text);
  if (numbers.length === 0) return;

  const targets = await db
    .select({ id: issues.id, number: issues.number })
    .from(issues)
    .where(and(eq(issues.repositoryId, repositoryId), inArray(issues.number, numbers)));

  for (const target of targets) {
    if (target.id === sourceIssueId) continue;
    await db
      .insert(issueLinks)
      .values({
        sourceIssueId,
        targetIssueId: target.id,
        linkType: 'references',
        createdById: actorId,
      })
      .onConflictDoNothing();
  }
}

/** Issues, die auf dieses hier verweisen oder von ihm referenziert werden. */
export async function loadIssueLinks(issueId: string) {
  const rows = await db
    .select({
      link: issueLinks,
      target: issues,
    })
    .from(issueLinks)
    .innerJoin(issues, eq(issues.id, issueLinks.targetIssueId))
    .where(eq(issueLinks.sourceIssueId, issueId));

  return rows.map((row) => ({
    linkType: row.link.linkType,
    number: row.target.number,
    title: row.target.title,
    state: row.target.state,
    kind: row.target.kind,
  }));
}
