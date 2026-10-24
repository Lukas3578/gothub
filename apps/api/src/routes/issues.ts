/**
 * Endpunkte für Issues, Labels, Milestones und Kommentare.
 *
 * Pull Requests teilen sich diese Routen für alles, was beiden gemeinsam ist
 * (Kommentare, Labels, Assignees, Zustand); PR-spezifisches steht in
 * routes/pull-requests.ts.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { hasAccess } from '@forge/shared';
import { db } from '../db/index.js';
import { auditLogs, issueComments, issues, labels, milestones, namespaces, users } from '../db/schema.js';
import { forbidden, notFound, validationFailed } from '../lib/errors.js';
import { requireRepositoryAccess, type ResolvedAccess } from '../services/permissions.js';
import {
  addComment,
  createIssue,
  createLabel,
  createMilestone,
  deleteComment,
  deleteLabel,
  deleteMilestone,
  getIssue,
  linkReferencedIssues,
  listLabels,
  listIssues,
  listMilestones,
  loadIssueLinks,
  loadTimeline,
  recordEvent,
  setAssignees,
  setIssueState,
  setLabels,
  setLocked,
  toIssueDetail,
  toggleReaction,
  updateComment,
  updateIssue,
  updateLabel,
  updateMilestone,
} from '../services/issues.js';
import { notifyIssueActivity } from '../services/notifications.js';

const listQuery = z.object({
  state: z.enum(['open', 'closed', 'all']).default('open'),
  labels: z.string().optional(),
  assignee: z.string().max(39).optional(),
  author: z.string().max(39).optional(),
  milestone: z.string().max(20).optional(),
  search: z.string().max(200).optional(),
  sort: z.enum(['newest', 'oldest', 'updated', 'comments']).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

export async function registerIssueRoutes(app: FastifyInstance): Promise<void> {
  /** Löst Benutzernamen in IDs auf und weist unbekannte Namen zurück. */
  async function resolveUserIds(usernames: string[]): Promise<string[]> {
    if (usernames.length === 0) return [];
    const rows = await db
      .select({ id: users.id, name: namespaces.nameLower })
      .from(users)
      .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
      .where(inArray(namespaces.nameLower, usernames.map((u) => u.toLowerCase())));

    if (rows.length !== usernames.length) {
      const found = new Set(rows.map((r) => r.name));
      const missing = usernames.filter((u) => !found.has(u.toLowerCase()));
      throw validationFailed(`Unbekannte Benutzer: ${missing.join(', ')}`);
    }
    return rows.map((r) => r.id);
  }

  /** Prüft, dass die angegebenen Labels zu diesem Repository gehören. */
  async function resolveLabelIds(repositoryId: string, names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const rows = await db
      .select({ id: labels.id, name: labels.name })
      .from(labels)
      .where(and(eq(labels.repositoryId, repositoryId), inArray(labels.name, names)));
    return rows.map((r) => r.id);
  }

  // -------------------------------------------------------------------------
  // Liste
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/issues',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      if (!access.repository.hasIssues) {
        throw notFound('Issues sind in diesem Repository deaktiviert.');
      }

      const query = listQuery.parse(request.query);

      return listIssues(
        access.repository.id,
        {
          kind: 'issue',
          state: query.state,
          labels: query.labels ? query.labels.split(',').filter(Boolean) : [],
          assignee: query.assignee,
          author: query.author,
          milestone: query.milestone,
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
    '/api/v1/repos/:owner/:repo/issues',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({
          title: z.string().min(1).max(500),
          body: z.string().max(100_000).nullish(),
          labels: z.array(z.string().max(64)).max(20).optional(),
          assignees: z.array(z.string().max(39)).max(10).optional(),
          milestone: z.number().int().positive().nullish(),
        })
        .parse(request.body);

      // Ein Issue darf jeder mit Lesezugriff anlegen – das ist der Sinn eines
      // öffentlichen Bugtrackers. Labels und Assignees setzen darf nur, wer
      // Schreibrechte hat.
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      if (!access.repository.hasIssues) {
        throw notFound('Issues sind in diesem Repository deaktiviert.');
      }
      if (access.repository.isArchived) {
        throw forbidden('Dieses Repository ist archiviert.');
      }

      const canTriage = hasAccess(access.level, 'triage');

      const labelIds = canTriage
        ? await resolveLabelIds(access.repository.id, input.labels ?? [])
        : [];
      const assigneeIds = canTriage ? await resolveUserIds(input.assignees ?? []) : [];

      let milestoneId: string | null = null;
      if (canTriage && input.milestone) {
        const rows = await db
          .select({ id: milestones.id })
          .from(milestones)
          .where(
            and(
              eq(milestones.repositoryId, access.repository.id),
              eq(milestones.number, input.milestone),
            ),
          )
          .limit(1);
        milestoneId = rows[0]?.id ?? null;
      }

      const created = await createIssue(
        access.repository.id,
        {
          title: input.title,
          body: input.body ?? null,
          labelIds,
          assigneeIds,
          milestoneId,
        },
        request.viewer!.id,
        'issue',
      );

      const fullName = `${access.ownerName}/${access.repository.name}`;

      if (input.body) {
        await linkReferencedIssues(
          access.repository.id,
          created.id,
          input.body,
          request.viewer!.id,
        );
      }

      await notifyIssueActivity({
        issueId: created.id,
        repositoryId: access.repository.id,
        repositoryFullName: fullName,
        actorId: request.viewer!.id,
        title: `${fullName}#${created.number}: ${created.title}`,
        kind: 'opened',
        mentionSource: input.body ?? undefined,
      }).catch((error) => request.log.error({ err: error }, 'Benachrichtigung fehlgeschlagen'));

      reply.code(201);
      return toIssueDetail(created, fullName, request.viewer, hasAccess(access.level, 'write'));
    },
  );

  // -------------------------------------------------------------------------
  // Detail und Verlauf
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/issues/:number',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const issue = await getIssue(access.repository.id, Number(request.params.number));
      const fullName = `${access.ownerName}/${access.repository.name}`;

      const [detail, timeline, links] = await Promise.all([
        toIssueDetail(issue, fullName, request.viewer, hasAccess(access.level, 'write')),
        loadTimeline(issue.id, request.viewer, hasAccess(access.level, 'write')),
        loadIssueLinks(issue.id),
      ]);

      return { issue: detail, timeline, links };
    },
  );

  // -------------------------------------------------------------------------
  // Ändern
  // -------------------------------------------------------------------------
  app.patch<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/issues/:number',
    async (request) => {
      app.requireAuth(request);
      const input = z
        .object({
          title: z.string().min(1).max(500).optional(),
          body: z.string().max(100_000).nullish(),
          state: z.enum(['open', 'closed']).optional(),
          closeReason: z.enum(['completed', 'not_planned', 'duplicate']).optional(),
          labels: z.array(z.string().max(64)).max(20).optional(),
          assignees: z.array(z.string().max(39)).max(10).optional(),
          milestone: z.number().int().positive().nullish(),
          locked: z.boolean().optional(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const issue = await getIssue(access.repository.id, Number(request.params.number));

      const isAuthor = issue.authorId === request.viewer!.id;
      const canWrite = hasAccess(access.level, 'write');
      const canTriage = hasAccess(access.level, 'triage');

      // Text und Titel: Autor oder Schreibberechtigte.
      if ((input.title !== undefined || input.body !== undefined) && !isAuthor && !canWrite) {
        throw forbidden('Du darfst diesen Beitrag nicht bearbeiten.');
      }
      // Labels, Assignees, Milestone, Sperre: mindestens Triage-Recht.
      if (
        (input.labels !== undefined ||
          input.assignees !== undefined ||
          input.milestone !== undefined ||
          input.locked !== undefined) &&
        !canTriage
      ) {
        throw forbidden('Dafür fehlen dir die nötigen Rechte in diesem Repository.');
      }
      // Schließen und wieder öffnen: Autor oder Schreibberechtigte.
      if (input.state !== undefined && !isAuthor && !canWrite) {
        throw forbidden('Du darfst den Zustand dieses Issues nicht ändern.');
      }

      if (input.title !== undefined || input.body !== undefined || input.milestone !== undefined) {
        let milestoneId: string | null | undefined;
        if (input.milestone !== undefined) {
          if (input.milestone === null) {
            milestoneId = null;
          } else {
            const rows = await db
              .select({ id: milestones.id })
              .from(milestones)
              .where(
                and(
                  eq(milestones.repositoryId, access.repository.id),
                  eq(milestones.number, input.milestone),
                ),
              )
              .limit(1);
            milestoneId = rows[0]?.id ?? null;
          }
        }

        await updateIssue(
          issue.id,
          {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(milestoneId !== undefined ? { milestoneId } : {}),
          },
          request.viewer!.id,
        );
      }

      if (input.labels !== undefined) {
        const labelIds = await resolveLabelIds(access.repository.id, input.labels);
        await setLabels(issue.id, labelIds, request.viewer!.id);
      }

      if (input.assignees !== undefined) {
        const assigneeIds = await resolveUserIds(input.assignees);
        await setAssignees(issue.id, assigneeIds, request.viewer!.id);
      }

      if (input.locked !== undefined) {
        await setLocked(issue.id, input.locked, request.viewer!.id);
      }

      if (input.state !== undefined) {
        await setIssueState(
          issue.id,
          input.state,
          input.closeReason ?? 'completed',
          request.viewer!.id,
        );

        const fullName = `${access.ownerName}/${access.repository.name}`;
        await notifyIssueActivity({
          issueId: issue.id,
          repositoryId: access.repository.id,
          repositoryFullName: fullName,
          actorId: request.viewer!.id,
          title: `${fullName}#${issue.number} ${input.state === 'closed' ? 'geschlossen' : 'wieder geöffnet'}: ${issue.title}`,
          kind: 'state_change',
        }).catch(() => {});
      }

      const fresh = await getIssue(access.repository.id, issue.number);
      return toIssueDetail(
        fresh,
        `${access.ownerName}/${access.repository.name}`,
        request.viewer,
        canWrite,
      );
    },
  );

  // -------------------------------------------------------------------------
  // Kommentare
  // -------------------------------------------------------------------------
  app.post<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/issues/:number/comments',
    async (request, reply) => {
      app.requireAuth(request);
      const { body } = z.object({ body: z.string().min(1).max(100_000) }).parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const issue = await getIssue(access.repository.id, Number(request.params.number));

      // Eine gesperrte Unterhaltung lässt nur noch Schreibberechtigte zu.
      if (issue.isLocked && !hasAccess(access.level, 'write')) {
        throw forbidden('Diese Unterhaltung ist gesperrt.');
      }

      const comment = await addComment(issue.id, request.viewer!.id, body);
      await linkReferencedIssues(access.repository.id, issue.id, body, request.viewer!.id);

      const fullName = `${access.ownerName}/${access.repository.name}`;
      await notifyIssueActivity({
        issueId: issue.id,
        repositoryId: access.repository.id,
        repositoryFullName: fullName,
        actorId: request.viewer!.id,
        title: `${fullName}#${issue.number}: neuer Kommentar`,
        kind: 'commented',
        mentionSource: body,
      }).catch(() => {});

      reply.code(201);
      return { id: comment.id };
    },
  );

  app.patch<{ Params: { owner: string; repo: string; commentId: string } }>(
    '/api/v1/repos/:owner/:repo/issue-comments/:commentId',
    async (request) => {
      app.requireAuth(request);
      const { body } = z.object({ body: z.string().min(1).max(100_000) }).parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      await assertCommentPermission(request, access, request.params.commentId);

      await updateComment(request.params.commentId, body);
      return { ok: true };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; commentId: string } }>(
    '/api/v1/repos/:owner/:repo/issue-comments/:commentId',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      await assertCommentPermission(request, access, request.params.commentId);

      await deleteComment(request.params.commentId);
      return { ok: true };
    },
  );

  /**
   * Stellt sicher, dass der Kommentar zu diesem Repository gehört und der
   * Benutzer ihn bearbeiten darf. Die Zugehörigkeitsprüfung ist wichtig: sonst
   * ließe sich über ein Repository mit Schreibrecht ein fremder Kommentar
   * ändern, indem man dessen ID einsetzt.
   */
  async function assertCommentPermission(
    request: FastifyRequest,
    access: ResolvedAccess,
    commentId: string,
  ): Promise<void> {
    const rows = await db
      .select({ authorId: issueComments.authorId, repositoryId: issues.repositoryId })
      .from(issueComments)
      .innerJoin(issues, eq(issues.id, issueComments.issueId))
      .where(eq(issueComments.id, commentId))
      .limit(1);

    const row = rows[0];
    if (!row || row.repositoryId !== access.repository.id) {
      throw notFound('Kommentar nicht gefunden.');
    }
    if (row.authorId !== request.viewer!.id && !hasAccess(access.level, 'maintain')) {
      throw forbidden('Du darfst diesen Kommentar nicht bearbeiten.');
    }
  }

  // -------------------------------------------------------------------------
  // Reaktionen
  // -------------------------------------------------------------------------
  app.post<{ Params: { owner: string; repo: string; subjectType: string; subjectId: string } }>(
    '/api/v1/repos/:owner/:repo/reactions/:subjectType/:subjectId',
    async (request) => {
      app.requireAuth(request);
      const { content } = z.object({ content: z.string().max(32) }).parse(request.body);

      const subjectType = z
        .enum(['issue', 'issue_comment', 'review_comment'])
        .parse(request.params.subjectType);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      // Auch hier: das Subjekt muss zu diesem Repository gehören.
      await assertSubjectBelongsToRepository(subjectType, request.params.subjectId, access.repository.id);

      const reactions = await toggleReaction(
        subjectType,
        request.params.subjectId,
        request.viewer!.id,
        content,
      );
      return { reactions };
    },
  );

  async function assertSubjectBelongsToRepository(
    subjectType: string,
    subjectId: string,
    repositoryId: string,
  ): Promise<void> {
    if (subjectType === 'issue') {
      const rows = await db
        .select({ repositoryId: issues.repositoryId })
        .from(issues)
        .where(eq(issues.id, subjectId))
        .limit(1);
      if (rows[0]?.repositoryId !== repositoryId) throw notFound('Nicht gefunden.');
      return;
    }
    if (subjectType === 'issue_comment') {
      const rows = await db
        .select({ repositoryId: issues.repositoryId })
        .from(issueComments)
        .innerJoin(issues, eq(issues.id, issueComments.issueId))
        .where(eq(issueComments.id, subjectId))
        .limit(1);
      if (rows[0]?.repositoryId !== repositoryId) throw notFound('Nicht gefunden.');
      return;
    }
    // review_comment wird in der PR-Schicht geprüft, dort ist der Kontext da.
  }

  // -------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/labels',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      return { items: await listLabels(access.repository.id) };
    },
  );

  app.post<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/labels',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({
          name: z.string().min(1).max(64),
          color: z.string().max(7),
          description: z.string().max(200).nullish(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'triage',
      );
      reply.code(201);
      return createLabel(access.repository.id, input);
    },
  );

  app.patch<{ Params: { owner: string; repo: string; labelId: string } }>(
    '/api/v1/repos/:owner/:repo/labels/:labelId',
    async (request) => {
      app.requireAuth(request);
      const input = z
        .object({
          name: z.string().min(1).max(64).optional(),
          color: z.string().max(7).optional(),
          description: z.string().max(200).nullish(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'triage',
      );
      await assertLabelBelongs(request.params.labelId, access.repository.id);

      await updateLabel(request.params.labelId, input);
      return { ok: true };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; labelId: string } }>(
    '/api/v1/repos/:owner/:repo/labels/:labelId',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'triage',
      );
      await assertLabelBelongs(request.params.labelId, access.repository.id);

      await deleteLabel(request.params.labelId);
      return { ok: true };
    },
  );

  async function assertLabelBelongs(labelId: string, repositoryId: string): Promise<void> {
    const rows = await db
      .select({ repositoryId: labels.repositoryId })
      .from(labels)
      .where(eq(labels.id, labelId))
      .limit(1);
    if (rows[0]?.repositoryId !== repositoryId) throw notFound('Label nicht gefunden.');
  }

  // -------------------------------------------------------------------------
  // Milestones
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/milestones',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const { state } = z
        .object({ state: z.enum(['open', 'closed', 'all']).default('open') })
        .parse(request.query);

      return { items: await listMilestones(access.repository.id, state) };
    },
  );

  app.post<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/milestones',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({
          title: z.string().min(1).max(255),
          description: z.string().max(10_000).nullish(),
          dueOn: z.string().datetime().nullish(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'triage',
      );
      reply.code(201);
      return createMilestone(access.repository.id, input);
    },
  );

  app.patch<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/milestones/:number',
    async (request) => {
      app.requireAuth(request);
      const input = z
        .object({
          title: z.string().min(1).max(255).optional(),
          description: z.string().max(10_000).nullish(),
          dueOn: z.string().datetime().nullish(),
          state: z.enum(['open', 'closed']).optional(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'triage',
      );
      const milestone = await findMilestone(access.repository.id, Number(request.params.number));

      await updateMilestone(milestone.id, input);
      return { ok: true };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/milestones/:number',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'triage',
      );
      const milestone = await findMilestone(access.repository.id, Number(request.params.number));

      await deleteMilestone(milestone.id);
      return { ok: true };
    },
  );

  async function findMilestone(repositoryId: string, number: number) {
    const rows = await db
      .select()
      .from(milestones)
      .where(and(eq(milestones.repositoryId, repositoryId), eq(milestones.number, number)))
      .limit(1);
    if (!rows[0]) throw notFound('Milestone nicht gefunden.');
    return rows[0];
  }
}
