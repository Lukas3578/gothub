/**
 * Pull Requests.
 *
 * Ein Pull Request ist ein Issue mit einer 1:1-Erweiterung. Alles, was beide
 * gemeinsam haben (Titel, Kommentare, Labels, Zustand), liegt deshalb im
 * Issue-Service; hier steht nur das, was Git betrifft: Vergleich, Merge-Checks
 * und die Durchführung des Merges.
 *
 * Forks: Basis- und Head-Repository können verschieden sein. Git kann aber
 * nicht über Repository-Grenzen hinweg vergleichen, deshalb werden die Commits
 * des Head-Repositories vor jeder Analyse in das Basis-Repository geholt und
 * dort unter einem internen Ref abgelegt (`refs/forge/pull/<nr>/head`). Dieses
 * Ref ist über das normale Git-Protokoll nicht sichtbar und dient nur der
 * Plattform.
 */

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  MergeChecks,
  MergeStrategy,
  PullRequestDetail,
  PullRequestReview as ReviewDto,
  ReviewComment as ReviewCommentDto,
  ReviewState,
  TimelineEntry,
  UserRef,
} from '@forge/shared';
import { db } from '../db/index.js';
import {
  branchProtections,
  issues,
  namespaces,
  pullRequestReviews,
  pullRequests,
  repositories,
  reviewComments,
  reviewRequests,
  users,
} from '../db/schema.js';
import { conflict, forbidden, notFound, validationFailed } from '../lib/errors.js';
import { runGit, GitError, assertNotOption } from '../git/exec.js';
import { repositoryPath } from '../git/storage.js';
import {
  checkMergeable,
  commitsBetween,
  getDiff,
  mergeBranches,
  resolveRef,
} from '../git/repository.js';
import { loadReactions, loadUserRefs, toIssueDetail, loadTimeline } from './issues.js';

/** Internes Ref, unter dem der Head eines Forks im Basis-Repository liegt. */
function pullHeadRef(number: number): string {
  return `refs/forge/pull/${number}/head`;
}

/**
 * Holt den aktuellen Stand des Head-Branches in das Basis-Repository.
 *
 * Bei einem PR innerhalb desselben Repositories ist nichts zu tun – der Branch
 * ist bereits da. Bei einem Fork wird gefetcht; das ist eine lokale Operation
 * zwischen zwei Verzeichnissen und braucht kein Netzwerk.
 */
export async function syncPullRequestHead(
  pr: typeof pullRequests.$inferSelect,
  number: number,
): Promise<string | null> {
  if (!pr.headRepositoryId) return null;

  if (pr.headRepositoryId === pr.baseRepositoryId) {
    return resolveRef(pr.baseRepositoryId, pr.headBranch);
  }

  const basePath = repositoryPath(pr.baseRepositoryId);
  const headPath = repositoryPath(pr.headRepositoryId);
  const branch = assertNotOption(pr.headBranch, 'Head-Branch');

  const result = await runGit(
    ['fetch', '--force', headPath, `refs/heads/${branch}:${pullHeadRef(number)}`],
    { cwd: basePath, allowFailure: true, timeoutMs: 300_000 },
  );

  if (result.exitCode !== 0) return null;
  return resolveRef(pr.baseRepositoryId, pullHeadRef(number));
}

/**
 * Liefert die Referenz, unter der der Head im Basis-Repository erreichbar ist.
 */
function headRefFor(pr: typeof pullRequests.$inferSelect, number: number): string {
  return pr.headRepositoryId === pr.baseRepositoryId ? pr.headBranch : pullHeadRef(number);
}

// ---------------------------------------------------------------------------
// Anlegen
// ---------------------------------------------------------------------------

export interface CreatePullRequestInput {
  title: string;
  body?: string | null;
  baseBranch: string;
  headBranch: string;
  /** Null bedeutet: derselbe Repository wie die Basis. */
  headRepositoryId?: string | null;
  isDraft?: boolean;
}

export async function createPullRequest(
  baseRepositoryId: string,
  input: CreatePullRequestInput,
  authorId: string,
): Promise<{ issue: typeof issues.$inferSelect; pr: typeof pullRequests.$inferSelect }> {
  const headRepositoryId = input.headRepositoryId ?? baseRepositoryId;

  const [baseSha, headSha] = await Promise.all([
    resolveRef(baseRepositoryId, input.baseBranch),
    resolveRef(headRepositoryId, input.headBranch),
  ]);

  if (!baseSha) throw validationFailed(`Der Basis-Branch "${input.baseBranch}" existiert nicht.`);
  if (!headSha) throw validationFailed(`Der Quell-Branch "${input.headBranch}" existiert nicht.`);

  if (headRepositoryId === baseRepositoryId && input.baseBranch === input.headBranch) {
    throw validationFailed('Basis- und Quell-Branch sind identisch.');
  }

  // Ein zweiter offener Pull Request für dieselbe Kombination wäre verwirrend
  // und führt zu widersprüchlichen Merges.
  const existing = await db
    .select({ number: issues.number })
    .from(pullRequests)
    .innerJoin(issues, eq(issues.id, pullRequests.issueId))
    .where(
      and(
        eq(pullRequests.baseRepositoryId, baseRepositoryId),
        eq(pullRequests.baseBranch, input.baseBranch),
        eq(pullRequests.headBranch, input.headBranch),
        eq(issues.state, 'open'),
      ),
    )
    .limit(1);

  if (existing[0]) {
    throw conflict(`Für diese Branches ist bereits Pull Request #${existing[0].number} offen.`);
  }

  const { createIssue } = await import('./issues.js');

  const issue = await createIssue(
    baseRepositoryId,
    { title: input.title, body: input.body ?? null },
    authorId,
    'pull_request',
  );

  const [pr] = await db
    .insert(pullRequests)
    .values({
      issueId: issue.id,
      baseRepositoryId,
      baseBranch: input.baseBranch,
      baseSha,
      headRepositoryId,
      headBranch: input.headBranch,
      headSha,
      isDraft: input.isDraft ?? false,
    })
    .returning();

  await refreshPullRequestState(pr!, issue.number);

  const [fresh] = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.issueId, issue.id))
    .limit(1);

  return { issue, pr: fresh! };
}

// ---------------------------------------------------------------------------
// Zustand neu berechnen
// ---------------------------------------------------------------------------

/**
 * Aktualisiert Head-SHA, Mergebarkeit und Änderungsstatistik.
 *
 * Wird aufgerufen, wenn der Pull Request geöffnet wird, bei jedem Aufruf der
 * Detailseite mit veraltetem Stand und nach einem Push auf den Head-Branch.
 * Die Prüfung ist nicht kostenlos, deshalb merkt sich `mergeCheckedSha`, für
 * welchen Stand das Ergebnis gilt.
 */
export async function refreshPullRequestState(
  pr: typeof pullRequests.$inferSelect,
  number: number,
  force = false,
): Promise<{ conflictingFiles: string[] }> {
  // Ein gemergter Pull Request wird nicht mehr neu bewertet.
  if (pr.mergedAt) return { conflictingFiles: [] };

  const headSha = await syncPullRequestHead(pr, number);
  const baseSha = await resolveRef(pr.baseRepositoryId, pr.baseBranch);

  if (!headSha || !baseSha) {
    await db
      .update(pullRequests)
      .set({ mergeableState: 'unknown', headSha, baseSha })
      .where(eq(pullRequests.issueId, pr.issueId));
    return { conflictingFiles: [] };
  }

  // Unverändert und schon geprüft: nichts zu tun.
  if (!force && pr.mergeCheckedSha === headSha && pr.headSha === headSha && pr.baseSha === baseSha) {
    return { conflictingFiles: [] };
  }

  const headRef = headRefFor(pr, number);

  const [merge, diff, commits] = await Promise.all([
    checkMergeable(pr.baseRepositoryId, pr.baseBranch, headRef),
    getDiff(pr.baseRepositoryId, baseSha, headSha).catch(() => ({
      files: [],
      stats: { filesChanged: 0, additions: 0, deletions: 0 },
    })),
    commitsBetween(pr.baseRepositoryId, pr.baseBranch, headRef).catch(() => []),
  ]);

  await db
    .update(pullRequests)
    .set({
      headSha,
      baseSha,
      mergeableState: merge.mergeable ? 'clean' : 'conflicted',
      mergeCheckedSha: headSha,
      additions: diff.stats.additions,
      deletions: diff.stats.deletions,
      changedFiles: diff.stats.filesChanged,
      commitCount: commits.length,
    })
    .where(eq(pullRequests.issueId, pr.issueId));

  return { conflictingFiles: merge.conflictingFiles };
}

// ---------------------------------------------------------------------------
// Merge-Voraussetzungen
// ---------------------------------------------------------------------------

/**
 * Prüft alle Bedingungen, die erfüllt sein müssen, damit gemergt werden darf:
 * Zustand, Entwurfsstatus, Konflikte, Branch-Schutzregeln und Reviews.
 *
 * Das Ergebnis ist eine Liste statt eines Wahrheitswerts, damit die Oberfläche
 * zeigen kann, *woran* es hakt.
 */
export async function computeMergeChecks(
  pr: typeof pullRequests.$inferSelect,
  issue: typeof issues.$inferSelect,
  conflictingFiles: string[],
): Promise<MergeChecks> {
  const items: MergeChecks['items'] = [];

  items.push({
    key: 'state',
    label: 'Pull Request ist offen',
    passed: issue.state === 'open' && !pr.mergedAt,
  });

  items.push({
    key: 'draft',
    label: 'Kein Entwurf',
    passed: !pr.isDraft,
    ...(pr.isDraft ? { detail: 'Entwürfe können nicht gemergt werden.' } : {}),
  });

  items.push({
    key: 'conflicts',
    label: 'Keine Merge-Konflikte',
    passed: pr.mergeableState === 'clean',
    ...(conflictingFiles.length > 0
      ? { detail: `Betroffen: ${conflictingFiles.slice(0, 5).join(', ')}` }
      : {}),
  });

  // Branch-Schutzregeln des Basis-Branches.
  const protections = await db
    .select()
    .from(branchProtections)
    .where(eq(branchProtections.repositoryId, pr.baseRepositoryId));

  const protection = protections.find((p) => matchesPattern(pr.baseBranch, p.pattern));

  if (protection) {
    const reviews = await latestReviewsByUser(pr.issueId);
    const approvals = [...reviews.values()].filter((r) => r.state === 'approved').length;
    const changesRequested = [...reviews.values()].filter(
      (r) => r.state === 'changes_requested',
    ).length;

    if (protection.requiredApprovals > 0) {
      items.push({
        key: 'approvals',
        label: `Mindestens ${protection.requiredApprovals} Zustimmung${protection.requiredApprovals === 1 ? '' : 'en'}`,
        passed: approvals >= protection.requiredApprovals,
        detail: `${approvals} von ${protection.requiredApprovals}`,
      });
    }

    items.push({
      key: 'changes_requested',
      label: 'Keine offenen Änderungswünsche',
      passed: changesRequested === 0,
      ...(changesRequested > 0
        ? { detail: `${changesRequested} Reviewer fordern Änderungen.` }
        : {}),
    });

    if (protection.requireLinearHistory) {
      items.push({
        key: 'linear',
        label: 'Lineare Historie erforderlich',
        passed: true,
        detail: 'Erlaubt sind Squash und Rebase.',
      });
    }
  }

  return { canMerge: items.every((item) => item.passed), items };
}

/** Das jeweils letzte abgegebene Review je Reviewer. */
async function latestReviewsByUser(
  issueId: string,
): Promise<Map<string, typeof pullRequestReviews.$inferSelect>> {
  const rows = await db
    .select()
    .from(pullRequestReviews)
    .where(
      and(
        eq(pullRequestReviews.issueId, issueId),
        isNull(pullRequestReviews.dismissedAt),
        sql`${pullRequestReviews.state} <> 'pending'`,
      ),
    )
    .orderBy(asc(pullRequestReviews.submittedAt));

  const byUser = new Map<string, typeof pullRequestReviews.$inferSelect>();
  for (const row of rows) {
    if (row.reviewerId) byUser.set(row.reviewerId, row);
  }
  return byUser;
}

function matchesPattern(name: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

/** Welche Merge-Strategien das Repository und die Schutzregeln zulassen. */
export async function allowedStrategies(
  repository: typeof repositories.$inferSelect,
  baseBranch: string,
): Promise<MergeStrategy[]> {
  const result: MergeStrategy[] = [];
  if (repository.allowMergeCommit) result.push('merge');
  if (repository.allowSquashMerge) result.push('squash');
  if (repository.allowRebaseMerge) result.push('rebase');

  const protections = await db
    .select()
    .from(branchProtections)
    .where(eq(branchProtections.repositoryId, repository.id));

  const protection = protections.find((p) => matchesPattern(baseBranch, p.pattern));

  // Lineare Historie schließt den Merge-Commit aus, weil er einen zweiten
  // Elternteil einführt.
  if (protection?.requireLinearHistory) {
    return result.filter((strategy) => strategy !== 'merge');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mergen
// ---------------------------------------------------------------------------

export async function mergePullRequest(options: {
  pr: typeof pullRequests.$inferSelect;
  issue: typeof issues.$inferSelect;
  repository: typeof repositories.$inferSelect;
  strategy: MergeStrategy;
  title: string;
  message: string;
  actor: { id: string; username: string; email: string };
}): Promise<string> {
  const { pr, issue, repository, strategy, actor } = options;

  const permitted = await allowedStrategies(repository, pr.baseBranch);
  if (!permitted.includes(strategy)) {
    throw validationFailed(`Die Strategie "${strategy}" ist für diesen Branch nicht erlaubt.`);
  }

  const { conflictingFiles } = await refreshPullRequestState(pr, issue.number, true);

  const [refreshed] = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.issueId, pr.issueId))
    .limit(1);

  const checks = await computeMergeChecks(refreshed!, issue, conflictingFiles);
  if (!checks.canMerge) {
    const failed = checks.items.filter((item) => !item.passed).map((item) => item.label);
    throw validationFailed(`Dieser Pull Request kann nicht gemergt werden: ${failed.join('; ')}`);
  }

  const headRef = headRefFor(refreshed!, issue.number);
  const author = { name: actor.username, email: actor.email };

  let mergeCommit: string;

  try {
    if (strategy === 'rebase') {
      mergeCommit = await rebaseMerge(
        refreshed!.baseRepositoryId,
        refreshed!.baseBranch,
        headRef,
        author,
      );
    } else {
      mergeCommit = await mergeBranches(refreshed!.baseRepositoryId, {
        baseBranch: refreshed!.baseBranch,
        headRef,
        message:
          strategy === 'squash'
            ? `${options.title}\n\n${options.message}`.trim()
            : `${options.title}\n\n${options.message}`.trim(),
        author,
        strategy: strategy === 'squash' ? 'squash' : 'merge',
      });
    }
  } catch (error) {
    if (error instanceof GitError) {
      throw validationFailed(`Der Merge ist fehlgeschlagen: ${error.message}`);
    }
    throw error;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(pullRequests)
      .set({
        mergedAt: new Date(),
        mergedById: actor.id,
        mergeStrategy: strategy,
        mergeCommitSha: mergeCommit,
        mergeableState: 'clean',
      })
      .where(eq(pullRequests.issueId, pr.issueId));

    await tx
      .update(issues)
      .set({
        state: 'closed',
        closeReason: 'merged',
        closedAt: new Date(),
        closedById: actor.id,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issue.id));

    await tx
      .update(repositories)
      .set({
        openPullRequestCount: sql`GREATEST(${repositories.openPullRequestCount} - 1, 0)`,
        pushedAt: new Date(),
      })
      .where(eq(repositories.id, repository.id));
  });

  const { recordEvent } = await import('./issues.js');
  await recordEvent(issue.id, actor.id, 'merged', { strategy, commit: mergeCommit });

  // Issues schließen, die im Text als "closes #12" genannt wurden.
  await closeReferencedIssues(repository.id, issue, actor.id);

  return mergeCommit;
}

/**
 * Setzt die Commits des Head auf die Spitze des Basis-Branches um.
 *
 * `git rebase` braucht ein Arbeitsverzeichnis. Stattdessen werden die Commits
 * einzeln mit `cherry-pick`-Semantik über `merge-tree` neu aufgebaut: für
 * jeden Commit wird der Dreiwege-Merge zwischen seinem Elternteil, dem
 * bisherigen Ergebnis und ihm selbst berechnet und daraus ein neuer Commit
 * erzeugt. Das kommt ohne Arbeitsverzeichnis aus und ist damit auch bei
 * gleichzeitigen Merges im selben Repository unbedenklich.
 */
async function rebaseMerge(
  repositoryId: string,
  baseBranch: string,
  headRef: string,
  author: { name: string; email: string },
): Promise<string> {
  const cwd = repositoryPath(repositoryId);
  const commits = await commitsBetween(repositoryId, baseBranch, headRef, 500);

  if (commits.length === 0) {
    throw validationFailed('Es gibt keine Commits zum Übernehmen.');
  }

  const baseOid = await resolveRef(repositoryId, baseBranch);
  if (!baseOid) throw validationFailed('Basis-Branch nicht gefunden.');

  // commitsBetween liefert neueste zuerst; für den Rebase wird die
  // ursprüngliche Reihenfolge gebraucht.
  const ordered = [...commits].reverse();

  let current = baseOid;

  for (const commit of ordered) {
    const parent = commit.parents[0];
    if (!parent) {
      throw validationFailed(
        'Ein Commit ohne Elternteil lässt sich nicht per Rebase übernehmen. Nutze Merge oder Squash.',
      );
    }

    const result = await runGit(
      ['merge-tree', '--write-tree', '--merge-base', parent, current, commit.oid],
      { cwd, allowFailure: true },
    );

    if (result.exitCode !== 0) {
      throw validationFailed(
        `Der Rebase ist bei Commit ${commit.shortOid} auf einen Konflikt gestoßen. Nutze Merge oder Squash.`,
      );
    }

    const treeOid = result.stdout.toString('utf8').split('\n')[0]!.trim();

    const newCommit = (
      await runGit(['commit-tree', treeOid, '-p', current, '-m', `${commit.subject}\n\n${commit.body}`.trim()], {
        cwd,
        env: {
          // Die ursprüngliche Autorschaft bleibt erhalten; der Committer ist
          // derjenige, der den Merge auslöst.
          GIT_AUTHOR_NAME: commit.author.name,
          GIT_AUTHOR_EMAIL: commit.author.email,
          GIT_AUTHOR_DATE: commit.author.date,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email,
        },
      })
    ).stdout
      .toString('utf8')
      .trim();

    current = newCommit;
  }

  await runGit(['update-ref', `refs/heads/${baseBranch}`, current, baseOid], { cwd });
  return current;
}

/** Schließt Issues, die der Pull-Request-Text mit "closes #n" nennt. */
async function closeReferencedIssues(
  repositoryId: string,
  prIssue: typeof issues.$inferSelect,
  actorId: string,
): Promise<void> {
  const { extractClosingReferences, setIssueState, recordEvent } = await import('./issues.js');
  const numbers = extractClosingReferences(prIssue.body ?? '');
  if (numbers.length === 0) return;

  const targets = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.repositoryId, repositoryId),
        inArray(issues.number, numbers),
        eq(issues.state, 'open'),
        eq(issues.kind, 'issue'),
      ),
    );

  for (const target of targets) {
    await setIssueState(target.id, 'closed', 'completed', actorId);
    await recordEvent(target.id, actorId, 'closed_by_pull_request', {
      pullRequestNumber: prIssue.number,
    });
  }
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export async function submitReview(options: {
  issueId: string;
  reviewerId: string;
  state: Exclude<ReviewState, 'pending' | 'dismissed'>;
  body: string | null;
  commitSha: string | null;
  comments: {
    path: string;
    line: number | null;
    startLine?: number | null;
    diffSide: 'left' | 'right';
    body: string;
  }[];
}): Promise<string> {
  return db.transaction(async (tx) => {
    const [review] = await tx
      .insert(pullRequestReviews)
      .values({
        issueId: options.issueId,
        reviewerId: options.reviewerId,
        state: options.state,
        body: options.body,
        commitSha: options.commitSha,
        submittedAt: new Date(),
      })
      .returning();

    if (options.comments.length > 0) {
      await tx.insert(reviewComments).values(
        options.comments.map((comment) => ({
          reviewId: review!.id,
          issueId: options.issueId,
          authorId: options.reviewerId,
          body: comment.body,
          path: comment.path,
          line: comment.line,
          startLine: comment.startLine ?? null,
          diffSide: comment.diffSide,
          commitSha: options.commitSha ?? '',
        })),
      );
    }

    // Eine erledigte Review-Anfrage wird entfernt, damit die Oberfläche nicht
    // weiterhin "Review angefordert" anzeigt.
    await tx
      .delete(reviewRequests)
      .where(
        and(
          eq(reviewRequests.issueId, options.issueId),
          eq(reviewRequests.reviewerId, options.reviewerId),
        ),
      );

    await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, options.issueId));

    return review!.id;
  });
}

export async function addReviewComment(options: {
  issueId: string;
  authorId: string;
  body: string;
  path: string;
  line: number | null;
  diffSide: 'left' | 'right';
  commitSha: string;
  replyToId?: string | null;
}): Promise<string> {
  const [created] = await db
    .insert(reviewComments)
    .values({
      issueId: options.issueId,
      authorId: options.authorId,
      body: options.body.trim(),
      path: options.path,
      line: options.line,
      diffSide: options.diffSide,
      commitSha: options.commitSha,
      replyToId: options.replyToId ?? null,
    })
    .returning();

  await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, options.issueId));
  return created!.id;
}

export async function resolveReviewComment(
  commentId: string,
  userId: string,
  resolved: boolean,
): Promise<void> {
  await db
    .update(reviewComments)
    .set({ isResolved: resolved, resolvedById: resolved ? userId : null })
    .where(eq(reviewComments.id, commentId));
}

export async function dismissReview(
  reviewId: string,
  reason: string,
): Promise<void> {
  await db
    .update(pullRequestReviews)
    .set({ state: 'dismissed', dismissedAt: new Date(), dismissedReason: reason })
    .where(eq(pullRequestReviews.id, reviewId));
}

export async function requestReview(
  issueId: string,
  reviewerId: string,
  requestedById: string,
): Promise<void> {
  await db
    .insert(reviewRequests)
    .values({ issueId, reviewerId, requestedById })
    .onConflictDoNothing();
}

export async function removeReviewRequest(issueId: string, reviewerId: string): Promise<void> {
  await db
    .delete(reviewRequests)
    .where(and(eq(reviewRequests.issueId, issueId), eq(reviewRequests.reviewerId, reviewerId)));
}

/** Lädt alle Reviews samt ihrer zeilengenauen Anmerkungen. */
export async function loadReviews(issueId: string): Promise<ReviewDto[]> {
  const [reviewRows, commentRows] = await Promise.all([
    db
      .select()
      .from(pullRequestReviews)
      .where(eq(pullRequestReviews.issueId, issueId))
      .orderBy(asc(pullRequestReviews.createdAt)),
    db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.issueId, issueId))
      .orderBy(asc(reviewComments.createdAt)),
  ]);

  const userRefs = await loadUserRefs([
    ...reviewRows.map((r) => r.reviewerId),
    ...commentRows.map((c) => c.authorId),
  ]);

  const commentsByReview = new Map<string, ReviewCommentDto[]>();
  const standalone: ReviewCommentDto[] = [];

  for (const row of commentRows) {
    const dto: ReviewCommentDto = {
      id: row.id,
      author: row.authorId ? (userRefs.get(row.authorId) ?? null) : null,
      body: row.body,
      path: row.path,
      line: row.line,
      startLine: row.startLine,
      diffSide: row.diffSide as 'left' | 'right',
      commitSha: row.commitSha,
      replyToId: row.replyToId,
      isResolved: row.isResolved,
      editedAt: row.editedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };

    if (row.reviewId) {
      const list = commentsByReview.get(row.reviewId) ?? [];
      list.push(dto);
      commentsByReview.set(row.reviewId, list);
    } else {
      standalone.push(dto);
    }
  }

  const reviews: ReviewDto[] = reviewRows.map((row) => ({
    id: row.id,
    reviewer: row.reviewerId ? (userRefs.get(row.reviewerId) ?? null) : null,
    state: row.state,
    body: row.body,
    commitSha: row.commitSha,
    comments: commentsByReview.get(row.id) ?? [],
    submittedAt: row.submittedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));

  // Kommentare ohne Review (direkt am Diff) bilden einen eigenen Eintrag,
  // damit sie in der Zeitleiste nicht verloren gehen.
  if (standalone.length > 0) {
    reviews.push({
      id: 'standalone',
      reviewer: standalone[0]!.author,
      state: 'commented',
      body: null,
      commitSha: standalone[0]!.commitSha,
      comments: standalone,
      submittedAt: standalone[0]!.createdAt,
      createdAt: standalone[0]!.createdAt,
    });
  }

  return reviews;
}

/** Angeforderte Reviewer mit ihrem aktuellen Review-Zustand. */
export async function loadReviewers(
  issueId: string,
): Promise<{ user: UserRef; state: ReviewState }[]> {
  const requests = await db
    .select({ reviewerId: reviewRequests.reviewerId })
    .from(reviewRequests)
    .where(eq(reviewRequests.issueId, issueId));

  const latest = await latestReviewsByUser(issueId);

  const ids = [
    ...new Set([
      ...requests.map((r) => r.reviewerId).filter((id): id is string => Boolean(id)),
      ...latest.keys(),
    ]),
  ];

  const refs = await loadUserRefs(ids);

  return ids
    .map((id) => {
      const user = refs.get(id);
      if (!user) return null;
      return { user, state: latest.get(id)?.state ?? ('pending' as ReviewState) };
    })
    .filter((entry): entry is { user: UserRef; state: ReviewState } => entry !== null);
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export async function toPullRequestDetail(options: {
  issue: typeof issues.$inferSelect;
  pr: typeof pullRequests.$inferSelect;
  repository: typeof repositories.$inferSelect;
  repositoryFullName: string;
  conflictingFiles: string[];
  viewer: { id: string } | null;
  canWrite: boolean;
}): Promise<PullRequestDetail> {
  const base = await toIssueDetail(
    options.issue,
    options.repositoryFullName,
    options.viewer,
    options.canWrite,
  );

  const [checks, reviewers, strategies, headFullName, mergedByRefs] = await Promise.all([
    computeMergeChecks(options.pr, options.issue, options.conflictingFiles),
    loadReviewers(options.issue.id),
    allowedStrategies(options.repository, options.pr.baseBranch),
    options.pr.headRepositoryId
      ? repositoryFullName(options.pr.headRepositoryId)
      : Promise.resolve(null),
    loadUserRefs([options.pr.mergedById]),
  ]);

  return {
    ...base,
    base: {
      branch: options.pr.baseBranch,
      sha: options.pr.baseSha,
      repositoryFullName: options.repositoryFullName,
    },
    head: {
      branch: options.pr.headBranch,
      sha: options.pr.headSha,
      repositoryFullName: headFullName,
    },
    isDraft: options.pr.isDraft,
    merged: Boolean(options.pr.mergedAt),
    mergedAt: options.pr.mergedAt?.toISOString() ?? null,
    mergedBy: options.pr.mergedById ? (mergedByRefs.get(options.pr.mergedById) ?? null) : null,
    mergeStrategy: options.pr.mergeStrategy,
    mergeCommitSha: options.pr.mergeCommitSha,
    mergeableState: options.pr.mergeableState,
    conflictingFiles: options.conflictingFiles,
    additions: options.pr.additions,
    deletions: options.pr.deletions,
    changedFiles: options.pr.changedFiles,
    commitCount: options.pr.commitCount,
    checks,
    reviewers,
    allowedStrategies: strategies,
  };
}

async function repositoryFullName(repositoryId: string): Promise<string | null> {
  const rows = await db
    .select({ name: repositories.name, ownerName: namespaces.name })
    .from(repositories)
    .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  return rows[0] ? `${rows[0].ownerName}/${rows[0].name}` : null;
}

/** Zeitleiste eines Pull Requests: Kommentare, Ereignisse und Reviews. */
export async function loadPullRequestTimeline(
  issueId: string,
  viewer: { id: string } | null,
  canWrite: boolean,
): Promise<TimelineEntry[]> {
  const [base, reviews] = await Promise.all([
    loadTimeline(issueId, viewer, canWrite),
    loadReviews(issueId),
  ]);

  const entries: TimelineEntry[] = [...base];
  for (const review of reviews) {
    if (review.state === 'pending') continue;
    entries.push({ type: 'review', at: review.submittedAt ?? review.createdAt, review });
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

/** Der Diff eines Pull Requests, berechnet im Basis-Repository. */
export async function loadPullRequestDiff(
  pr: typeof pullRequests.$inferSelect,
  number: number,
) {
  const headRef = headRefFor(pr, number);
  const baseSha = pr.baseSha ?? (await resolveRef(pr.baseRepositoryId, pr.baseBranch));
  const headSha = await resolveRef(pr.baseRepositoryId, headRef);

  if (!baseSha || !headSha) {
    return { files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 }, commits: [] };
  }

  // Der Vergleich geht gegen die gemeinsame Basis, nicht gegen die Spitze des
  // Basis-Branches: sonst erschienen fremde Commits als Änderungen des PRs.
  const mergeBase = await runGit(['merge-base', baseSha, headSha], {
    cwd: repositoryPath(pr.baseRepositoryId),
    allowFailure: true,
  });

  const from = mergeBase.exitCode === 0 ? mergeBase.stdout.toString('utf8').trim() : baseSha;

  const [diff, commits] = await Promise.all([
    getDiff(pr.baseRepositoryId, from, headSha),
    commitsBetween(pr.baseRepositoryId, from, headSha),
  ]);

  return { ...diff, commits };
}
