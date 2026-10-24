/**
 * Pull-Request-Endpunkte.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { hasAccess } from '@forge/shared';
import { db } from '../db/index.js';
import {
  issues,
  namespaces,
  pullRequests,
  repositories,
  reviewComments,
  users,
} from '../db/schema.js';
import { forbidden, notFound, validationFailed } from '../lib/errors.js';
import { requireRepositoryAccess, resolveRepositoryAccess, loadRepository } from '../services/permissions.js';
import { getIssue, listIssues, recordEvent } from '../services/issues.js';
import { notifyIssueActivity } from '../services/notifications.js';
import {
  addReviewComment,
  createPullRequest,
  dismissReview,
  loadPullRequestDiff,
  loadPullRequestTimeline,
  mergePullRequest,
  refreshPullRequestState,
  removeReviewRequest,
  requestReview,
  resolveReviewComment,
  submitReview,
  toPullRequestDetail,
} from '../services/pull-requests.js';

export async function registerPullRequestRoutes(app: FastifyInstance): Promise<void> {
  /** Lädt Issue und PR-Erweiterung zusammen und prüft, dass es ein PR ist. */
  async function loadPr(repositoryId: string, number: number) {
    const issue = await getIssue(repositoryId, number);
    if (issue.kind !== 'pull_request') throw notFound('Pull Request nicht gefunden.');

    const rows = await db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.issueId, issue.id))
      .limit(1);

    if (!rows[0]) throw notFound('Pull Request nicht gefunden.');
    return { issue, pr: rows[0] };
  }

  // -------------------------------------------------------------------------
  // Liste
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/pulls',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const query = z
        .object({
          state: z.enum(['open', 'closed', 'all']).default('open'),
          labels: z.string().optional(),
          author: z.string().max(39).optional(),
          assignee: z.string().max(39).optional(),
          search: z.string().max(200).optional(),
          sort: z.enum(['newest', 'oldest', 'updated', 'comments']).default('newest'),
          page: z.coerce.number().int().min(1).default(1),
          perPage: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(request.query);

      return listIssues(
        access.repository.id,
        {
          kind: 'pull_request',
          state: query.state,
          labels: query.labels ? query.labels.split(',').filter(Boolean) : [],
          author: query.author,
          assignee: query.assignee,
          search: query.search,
          sort: query.sort,
          page: query.page,
          perPage: query.perPage,
        },
        request.viewer?.id ?? null,
      );
    },
  );

  // -------------------------------------------------------------------------
  // Anlegen
  // -------------------------------------------------------------------------
  app.post<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/pulls',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({
          title: z.string().min(1).max(500),
          body: z.string().max(100_000).nullish(),
          base: z.string().min(1).max(255),
          /**
           * Entweder "branch" (gleiches Repository) oder "besitzer:branch"
           * für einen Branch aus einem Fork.
           */
          head: z.string().min(1).max(300),
          draft: z.boolean().optional(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      if (!access.repository.hasPullRequests) {
        throw notFound('Pull Requests sind in diesem Repository deaktiviert.');
      }
      if (access.repository.isArchived) {
        throw forbidden('Dieses Repository ist archiviert.');
      }

      let headRepositoryId = access.repository.id;
      let headBranch = input.head;

      if (input.head.includes(':')) {
        const [ownerName, ...rest] = input.head.split(':');
        headBranch = rest.join(':');

        const headContext = await loadRepository(ownerName!, access.repository.name);
        if (!headContext) throw validationFailed('Das Quell-Repository wurde nicht gefunden.');

        // Auch aus einem Fork darf nur vorschlagen, wer den Fork lesen darf.
        const headAccess = await resolveRepositoryAccess(headContext, request.viewer);
        if (!hasAccess(headAccess.level, 'read')) {
          throw validationFailed('Das Quell-Repository wurde nicht gefunden.');
        }
        headRepositoryId = headContext.repository.id;
      } else {
        // Im selben Repository braucht es Schreibrecht, um einen Branch
        // vorzuschlagen – sonst könnte jeder beliebige fremde Branches
        // gegeneinander stellen.
        if (!hasAccess(access.level, 'write')) {
          throw forbidden(
            'Forke das Repository und eröffne den Pull Request aus deinem Fork heraus.',
          );
        }
      }

      const { issue, pr } = await createPullRequest(
        access.repository.id,
        {
          title: input.title,
          body: input.body ?? null,
          baseBranch: input.base,
          headBranch,
          headRepositoryId,
          isDraft: input.draft ?? false,
        },
        request.viewer!.id,
      );

      const fullName = `${access.ownerName}/${access.repository.name}`;

      await notifyIssueActivity({
        issueId: issue.id,
        repositoryId: access.repository.id,
        repositoryFullName: fullName,
        actorId: request.viewer!.id,
        title: `${fullName}#${issue.number}: ${issue.title}`,
        kind: 'opened',
        mentionSource: input.body ?? undefined,
      }).catch(() => {});

      reply.code(201);
      return toPullRequestDetail({
        issue,
        pr,
        repository: access.repository,
        repositoryFullName: fullName,
        conflictingFiles: [],
        viewer: request.viewer,
        canWrite: hasAccess(access.level, 'write'),
      });
    },
  );

  // -------------------------------------------------------------------------
  // Detail
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/pulls/:number',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const { issue, pr } = await loadPr(access.repository.id, Number(request.params.number));

      // Der Zustand wird beim Aufruf aufgefrischt, falls sich seit der letzten
      // Prüfung etwas geändert hat. Die Funktion erkennt selbst, ob Arbeit
      // nötig ist.
      const { conflictingFiles } = await refreshPullRequestState(pr, issue.number);

      const [fresh] = await db
        .select()
        .from(pullRequests)
        .where(eq(pullRequests.issueId, issue.id))
        .limit(1);

      const fullName = `${access.ownerName}/${access.repository.name}`;
      const canWrite = hasAccess(access.level, 'write');

      const [detail, timeline] = await Promise.all([
        toPullRequestDetail({
          issue,
          pr: fresh!,
          repository: access.repository,
          repositoryFullName: fullName,
          conflictingFiles,
          viewer: request.viewer,
          canWrite,
        }),
        loadPullRequestTimeline(issue.id, request.viewer, canWrite),
      ]);

      return { pullRequest: detail, timeline };
    },
  );

  // -------------------------------------------------------------------------
  // Änderungen (Diff und Commits)
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/pulls/:number/files',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const { issue, pr } = await loadPr(access.repository.id, Number(request.params.number));

      await refreshPullRequestState(pr, issue.number);
      const [fresh] = await db
        .select()
        .from(pullRequests)
        .where(eq(pullRequests.issueId, issue.id))
        .limit(1);

      const diff = await loadPullRequestDiff(fresh!, issue.number);

      // Zeilengenaue Anmerkungen zu diesem Diff mitliefern, damit die
      // Oberfläche sie direkt an den Zeilen anzeigen kann.
      const commentRows = await db
        .select()
        .from(reviewComments)
        .where(eq(reviewComments.issueId, issue.id));

      const { loadUserRefs } = await import('../services/issues.js');
      const refs = await loadUserRefs(commentRows.map((c) => c.authorId));

      return {
        ...diff,
        comments: commentRows.map((row) => ({
          id: row.id,
          author: row.authorId ? (refs.get(row.authorId) ?? null) : null,
          body: row.body,
          path: row.path,
          line: row.line,
          startLine: row.startLine,
          diffSide: row.diffSide,
          commitSha: row.commitSha,
          replyToId: row.replyToId,
          isResolved: row.isResolved,
          editedAt: row.editedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    },
  );

  // -------------------------------------------------------------------------
  // Entwurfsstatus
  // -------------------------------------------------------------------------
  app.patch<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/pulls/:number',
    async (request) => {
      app.requireAuth(request);
      const input = z
        .object({
          draft: z.boolean().optional(),
          base: z.string().min(1).max(255).optional(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const { issue, pr } = await loadPr(access.repository.id, Number(request.params.number));

      const isAuthor = issue.authorId === request.viewer!.id;
      if (!isAuthor && !hasAccess(access.level, 'write')) {
        throw forbidden('Du darfst diesen Pull Request nicht bearbeiten.');
      }
      if (pr.mergedAt) throw validationFailed('Dieser Pull Request ist bereits gemergt.');

      const patch: Record<string, unknown> = {};
      if (input.draft !== undefined) patch.isDraft = input.draft;
      if (input.base !== undefined) {
        const { resolveRef } = await import('../git/repository.js');
        const baseSha = await resolveRef(access.repository.id, input.base);
        if (!baseSha) throw validationFailed(`Der Branch "${input.base}" existiert nicht.`);
        patch.baseBranch = input.base;
        patch.baseSha = baseSha;
        // Der Vergleich muss neu berechnet werden.
        patch.mergeCheckedSha = null;
      }

      if (Object.keys(patch).length > 0) {
        await db.update(pullRequests).set(patch).where(eq(pullRequests.issueId, issue.id));
      }

      if (input.draft !== undefined) {
        await recordEvent(
          issue.id,
          request.viewer!.id,
          input.draft ? 'marked_draft' : 'ready_for_review',
          {},
        );
      }

      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Mergen
  // -------------------------------------------------------------------------
  app.post<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/pulls/:number/merge',
    async (request) => {
      app.requireAuth(request);
      const input = z
        .object({
          strategy: z.enum(['merge', 'squash', 'rebase']).default('merge'),
          title: z.string().max(500).optional(),
          message: z.string().max(10_000).optional(),
          deleteBranch: z.boolean().optional(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );
      const { issue, pr } = await loadPr(access.repository.id, Number(request.params.number));

      const commitSha = await mergePullRequest({
        pr,
        issue,
        repository: access.repository,
        strategy: input.strategy,
        title: input.title ?? `${issue.title} (#${issue.number})`,
        message: input.message ?? '',
        actor: {
          id: request.viewer!.id,
          username: request.viewer!.username,
          email: request.viewer!.email,
        },
      });

      // Den Quell-Branch aufräumen, wenn gewünscht und er im selben
      // Repository liegt. Fremde Forks werden nie angefasst.
      const shouldDelete = input.deleteBranch ?? access.repository.deleteBranchOnMerge;
      if (shouldDelete && pr.headRepositoryId === access.repository.id) {
        if (pr.headBranch !== access.repository.defaultBranch) {
          const { deleteBranch } = await import('../git/repository.js');
          await deleteBranch(access.repository.id, pr.headBranch).catch(() => {});
        }
      }

      const fullName = `${access.ownerName}/${access.repository.name}`;
      await notifyIssueActivity({
        issueId: issue.id,
        repositoryId: access.repository.id,
        repositoryFullName: fullName,
        actorId: request.viewer!.id,
        title: `${fullName}#${issue.number} wurde gemergt: ${issue.title}`,
        kind: 'state_change',
      }).catch(() => {});

      return { ok: true, mergeCommitSha: commitSha };
    },
  );

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------
  app.post<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/pulls/:number/reviews',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({
          state: z.enum(['approved', 'changes_requested', 'commented']),
          body: z.string().max(100_000).nullish(),
          comments: z
            .array(
              z.object({
                path: z.string().max(1000),
                line: z.number().int().nullable(),
                startLine: z.number().int().nullish(),
                diffSide: z.enum(['left', 'right']).default('right'),
                body: z.string().min(1).max(100_000),
              }),
            )
            .max(200)
            .default([]),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const { issue, pr } = await loadPr(access.repository.id, Number(request.params.number));

      // Der Autor darf seinen eigenen Pull Request kommentieren, aber nicht
      // formal zustimmen – sonst wäre die Freigabepflicht wirkungslos.
      if (issue.authorId === request.viewer!.id && input.state === 'approved') {
        throw validationFailed('Du kannst deinen eigenen Pull Request nicht freigeben.');
      }
      if (pr.mergedAt) throw validationFailed('Dieser Pull Request ist bereits gemergt.');

      await submitReview({
        issueId: issue.id,
        reviewerId: request.viewer!.id,
        state: input.state,
        body: input.body?.trim() || null,
        commitSha: pr.headSha,
        comments: input.comments,
      });

      const fullName = `${access.ownerName}/${access.repository.name}`;
      const label =
        input.state === 'approved'
          ? 'hat zugestimmt'
          : input.state === 'changes_requested'
            ? 'fordert Änderungen'
            : 'hat kommentiert';

      await notifyIssueActivity({
        issueId: issue.id,
        repositoryId: access.repository.id,
        repositoryFullName: fullName,
        actorId: request.viewer!.id,
        title: `${fullName}#${issue.number}: ${request.viewer!.username} ${label}`,
        kind: 'review',
        mentionSource: input.body ?? undefined,
      }).catch(() => {});

      reply.code(201);
      return { ok: true };
    },
  );

  app.post<{ Params: { owner: string; repo: string; number: string; reviewId: string } }>(
    '/api/v1/repos/:owner/:repo/pulls/:number/reviews/:reviewId/dismiss',
    async (request) => {
      app.requireAuth(request);
      const { reason } = z.object({ reason: z.string().max(500) }).parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'maintain',
      );
      const { issue } = await loadPr(access.repository.id, Number(request.params.number));

      await dismissReview(request.params.reviewId, reason);
      await recordEvent(issue.id, request.viewer!.id, 'review_dismissed', { reason });
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Review-Anfragen
  // -------------------------------------------------------------------------
  app.post<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/pulls/:number/requested-reviewers',
    async (request) => {
      app.requireAuth(request);
      const input = z
        .object({ reviewers: z.array(z.string().max(39)).min(1).max(10) })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const { issue } = await loadPr(access.repository.id, Number(request.params.number));

      const isAuthor = issue.authorId === request.viewer!.id;
      if (!isAuthor && !hasAccess(access.level, 'triage')) {
        throw forbidden('Du darfst keine Reviews anfordern.');
      }

      const reviewerIds: string[] = [];
      for (const username of input.reviewers) {
        const found = await db
          .select({ id: users.id })
          .from(users)
          .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
          .where(eq(namespaces.nameLower, username.toLowerCase()))
          .limit(1);
        if (!found[0]) throw validationFailed(`Unbekannter Benutzer: ${username}`);
        // Der Autor kann sich nicht selbst zum Reviewer machen.
        if (found[0].id === issue.authorId) continue;
        reviewerIds.push(found[0].id);
      }

      for (const reviewerId of reviewerIds) {
        await requestReview(issue.id, reviewerId, request.viewer!.id);
      }

      const fullName = `${access.ownerName}/${access.repository.name}`;
      await notifyIssueActivity({
        issueId: issue.id,
        repositoryId: access.repository.id,
        repositoryFullName: fullName,
        actorId: request.viewer!.id,
        title: `${fullName}#${issue.number}: Review angefordert`,
        kind: 'review_requested',
        extraRecipients: reviewerIds.map((userId) => ({
          userId,
          reason: 'review_requested' as const,
        })),
      }).catch(() => {});

      return { ok: true };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/pulls/:number/requested-reviewers',
    async (request) => {
      app.requireAuth(request);
      const input = z.object({ reviewer: z.string().max(39) }).parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const { issue } = await loadPr(access.repository.id, Number(request.params.number));

      const found = await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
        .where(eq(namespaces.nameLower, input.reviewer.toLowerCase()))
        .limit(1);

      if (found[0]) await removeReviewRequest(issue.id, found[0].id);
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Zeilengenaue Kommentare am Diff
  // -------------------------------------------------------------------------
  app.post<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/pulls/:number/comments',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({
          body: z.string().min(1).max(100_000),
          path: z.string().min(1).max(1000),
          line: z.number().int().nullable(),
          diffSide: z.enum(['left', 'right']).default('right'),
          replyToId: z.string().uuid().nullish(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const { issue, pr } = await loadPr(access.repository.id, Number(request.params.number));

      if (issue.isLocked && !hasAccess(access.level, 'write')) {
        throw forbidden('Diese Unterhaltung ist gesperrt.');
      }

      const id = await addReviewComment({
        issueId: issue.id,
        authorId: request.viewer!.id,
        body: input.body,
        path: input.path,
        line: input.line,
        diffSide: input.diffSide,
        commitSha: pr.headSha ?? '',
        replyToId: input.replyToId ?? null,
      });

      const fullName = `${access.ownerName}/${access.repository.name}`;
      await notifyIssueActivity({
        issueId: issue.id,
        repositoryId: access.repository.id,
        repositoryFullName: fullName,
        actorId: request.viewer!.id,
        title: `${fullName}#${issue.number}: Anmerkung zu ${input.path}`,
        kind: 'commented',
        mentionSource: input.body,
      }).catch(() => {});

      reply.code(201);
      return { id };
    },
  );

  app.post<{ Params: { owner: string; repo: string; commentId: string } }>(
    '/api/v1/repos/:owner/:repo/review-comments/:commentId/resolve',
    async (request) => {
      app.requireAuth(request);
      const { resolved } = z.object({ resolved: z.boolean() }).parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      // Der Kommentar muss zu diesem Repository gehören.
      const rows = await db
        .select({ repositoryId: issues.repositoryId, authorId: reviewComments.authorId })
        .from(reviewComments)
        .innerJoin(issues, eq(issues.id, reviewComments.issueId))
        .where(eq(reviewComments.id, request.params.commentId))
        .limit(1);

      if (!rows[0] || rows[0].repositoryId !== access.repository.id) {
        throw notFound('Kommentar nicht gefunden.');
      }
      if (rows[0].authorId !== request.viewer!.id && !hasAccess(access.level, 'write')) {
        throw forbidden('Du darfst diesen Kommentar nicht als erledigt markieren.');
      }

      await resolveReviewComment(request.params.commentId, request.viewer!.id, resolved);
      return { ok: true };
    },
  );
}
