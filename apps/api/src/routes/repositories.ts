/**
 * Repository-Endpunkte: Anlegen, Auflisten, Ändern, Forken, Star/Watch.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { REPO_VISIBILITY, type Paginated, type RepositorySummary } from '@forge/shared';
import { db } from '../db/index.js';
import { namespaces, organizations, repositories, stars, users } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import {
  requireRepositoryAccess,
  visibleRepositoriesFilter,
} from '../services/permissions.js';
import {
  createRepository,
  deleteRepository,
  forkRepository,
  setStar,
  setWatch,
  toDetail,
  toSummary,
  transferRepository,
  updateRepository,
} from '../services/repositories.js';

const createSchema = z.object({
  ownerName: z.string().min(1).max(39).optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullish(),
  visibility: z.enum(REPO_VISIBILITY).default('private'),
  defaultBranch: z.string().min(1).max(255).optional(),
  initializeWithReadme: z.boolean().optional(),
  gitignoreTemplate: z.string().max(50).nullish(),
  licenseTemplate: z.string().max(50).nullish(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullish(),
  websiteUrl: z.string().max(500).nullish(),
  visibility: z.enum(REPO_VISIBILITY).optional(),
  defaultBranch: z.string().min(1).max(255).optional(),
  topics: z.array(z.string().max(50)).max(20).optional(),
  isArchived: z.boolean().optional(),
  isTemplate: z.boolean().optional(),
  hasIssues: z.boolean().optional(),
  hasPullRequests: z.boolean().optional(),
  hasWiki: z.boolean().optional(),
  hasActions: z.boolean().optional(),
  allowMergeCommit: z.boolean().optional(),
  allowSquashMerge: z.boolean().optional(),
  allowRebaseMerge: z.boolean().optional(),
  deleteBranchOnMerge: z.boolean().optional(),
});

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  language: z.string().max(50).optional(),
  owner: z.string().max(39).optional(),
  sort: z.enum(['updated', 'created', 'stars', 'name']).default('updated'),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(30),
});

export async function registerRepositoryRoutes(app: FastifyInstance): Promise<void> {
  // -- Auflisten und Suchen -------------------------------------------------
  app.get('/api/v1/repositories', async (request) => {
    const query = listQuerySchema.parse(request.query);
    const viewer = request.viewer;

    // Die Sichtbarkeitsbedingung kommt aus einer einzigen Stelle; dadurch
    // kann diese Route private Repositories nicht versehentlich preisgeben.
    const conditions = [visibleRepositoriesFilter(viewer)];

    if (query.q) {
      conditions.push(
        or(
          ilike(repositories.name, `%${query.q}%`),
          ilike(repositories.description, `%${query.q}%`),
        )!,
      );
    }
    if (query.language) {
      conditions.push(eq(repositories.primaryLanguage, query.language));
    }
    if (query.owner) {
      conditions.push(eq(namespaces.nameLower, query.owner.toLowerCase()));
    }

    const where = and(...conditions);

    const orderBy =
      query.sort === 'stars'
        ? desc(repositories.starCount)
        : query.sort === 'created'
          ? desc(repositories.createdAt)
          : query.sort === 'name'
            ? repositories.nameLower
            : desc(repositories.updatedAt);

    const offset = (query.page - 1) * query.perPage;

    const rows = await db
      .select({ repository: repositories, ownerName: namespaces.name, ownerKind: namespaces.kind })
      .from(repositories)
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(where)
      .orderBy(orderBy)
      .limit(query.perPage + 1)
      .offset(offset);

    const totalRows = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(repositories)
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(where);

    const hasNextPage = rows.length > query.perPage;
    const items = rows
      .slice(0, query.perPage)
      .map((row) => toSummary(row.repository, row.ownerName, row.ownerKind));

    const result: Paginated<RepositorySummary> = {
      items,
      page: query.page,
      perPage: query.perPage,
      totalCount: totalRows[0]?.total ?? 0,
      hasNextPage,
    };
    return result;
  });

  // -- Anlegen --------------------------------------------------------------
  app.post('/api/v1/repositories', async (request, reply) => {
    app.requireAuth(request);
    const input = createSchema.parse(request.body);

    const created = await createRepository(
      {
        ownerName: input.ownerName ?? request.viewer!.username,
        name: input.name,
        description: input.description ?? null,
        visibility: input.visibility,
        defaultBranch: input.defaultBranch,
        initializeWithReadme: input.initializeWithReadme,
        gitignoreTemplate: input.gitignoreTemplate ?? null,
        licenseTemplate: input.licenseTemplate ?? null,
      },
      {
        id: request.viewer!.id,
        username: request.viewer!.username,
        email: request.viewer!.email,
        isAdmin: request.viewer!.isAdmin,
      },
    );

    reply.code(201);
    return created;
  });

  // -- Detail ---------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      return toDetail(
        access.repository,
        access.ownerName,
        access.ownerKind,
        access.level,
        request.viewer?.id ?? null,
      );
    },
  );

  // -- Ändern ---------------------------------------------------------------
  app.patch<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo',
    async (request) => {
      app.requireAuth(request);
      const input = updateSchema.parse(request.body);

      // Sichtbarkeit und Archivierung sind Admin-Aktionen; alles andere
      // genügt "maintain".
      const needsAdmin =
        input.visibility !== undefined ||
        input.isArchived !== undefined ||
        input.name !== undefined;

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        needsAdmin ? 'admin' : 'maintain',
      );

      await updateRepository(access.repository.id, input, request.viewer!.id);

      const [fresh] = await db
        .select()
        .from(repositories)
        .where(eq(repositories.id, access.repository.id));

      return toDetail(
        fresh!,
        access.ownerName,
        access.ownerKind,
        access.level,
        request.viewer!.id,
      );
    },
  );

  // -- Löschen --------------------------------------------------------------
  app.delete<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );
      await deleteRepository(access.repository.id, request.viewer!.id);
      return { ok: true };
    },
  );

  // -- Übertragen -----------------------------------------------------------
  app.post<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/transfer',
    async (request) => {
      app.requireAuth(request);
      const { newOwner } = z.object({ newOwner: z.string().min(1).max(39) }).parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      await transferRepository(access.repository.id, newOwner, request.viewer!);
      return { ok: true };
    },
  );

  // -- Forken ---------------------------------------------------------------
  app.post<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/fork',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({
          ownerName: z.string().min(1).max(39).optional(),
          name: z.string().min(1).max(100).optional(),
        })
        .parse(request.body ?? {});

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      const fork = await forkRepository(
        access.repository.id,
        input.ownerName ?? request.viewer!.username,
        input.name ?? null,
        request.viewer!,
      );

      reply.code(201);
      return fork;
    },
  );

  // -- Star und Watch -------------------------------------------------------
  app.put<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/star',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const count = await setStar(access.repository.id, request.viewer!.id, true);
      return { starred: true, starCount: count };
    },
  );

  app.delete<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/star',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const count = await setStar(access.repository.id, request.viewer!.id, false);
      return { starred: false, starCount: count };
    },
  );

  app.put<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/watch',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const count = await setWatch(access.repository.id, request.viewer!.id, true);
      return { watching: true, watcherCount: count };
    },
  );

  app.delete<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/watch',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const count = await setWatch(access.repository.id, request.viewer!.id, false);
      return { watching: false, watcherCount: count };
    },
  );

  // -- Repositories eines Besitzers ----------------------------------------
  app.get<{ Params: { owner: string } }>('/api/v1/users/:owner/repositories', async (request) => {
    const query = listQuerySchema.parse(request.query);

    const [namespace] = await db
      .select()
      .from(namespaces)
      .where(eq(namespaces.nameLower, request.params.owner.toLowerCase()))
      .limit(1);

    if (!namespace) throw notFound('Besitzer nicht gefunden.');

    const where = and(
      eq(repositories.ownerNamespaceId, namespace.id),
      visibleRepositoriesFilter(request.viewer),
    );

    const rows = await db
      .select({ repository: repositories })
      .from(repositories)
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(where)
      .orderBy(query.sort === 'stars' ? desc(repositories.starCount) : desc(repositories.updatedAt))
      .limit(query.perPage)
      .offset((query.page - 1) * query.perPage);

    const totalRows = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(repositories)
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(where);

    const result: Paginated<RepositorySummary> = {
      items: rows.map((row) => toSummary(row.repository, namespace.name, namespace.kind)),
      page: query.page,
      perPage: query.perPage,
      totalCount: totalRows[0]?.total ?? 0,
      hasNextPage: (query.page - 1) * query.perPage + rows.length < (totalRows[0]?.total ?? 0),
    };
    return result;
  });

  // -- Mit Stern versehene Repositories ------------------------------------
  app.get<{ Params: { owner: string } }>('/api/v1/users/:owner/starred', async (request) => {
    const [namespace] = await db
      .select()
      .from(namespaces)
      .where(eq(namespaces.nameLower, request.params.owner.toLowerCase()))
      .limit(1);
    if (!namespace) throw notFound('Benutzer nicht gefunden.');

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.namespaceId, namespace.id))
      .limit(1);
    if (!user) throw notFound('Benutzer nicht gefunden.');

    const ownerNs = db.$with('x');
    const rows = await db
      .select({
        repository: repositories,
        ownerName: namespaces.name,
        ownerKind: namespaces.kind,
      })
      .from(stars)
      .innerJoin(repositories, eq(repositories.id, stars.repositoryId))
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(and(eq(stars.userId, user.id), visibleRepositoriesFilter(request.viewer)))
      .orderBy(desc(stars.createdAt))
      .limit(50);

    return {
      items: rows.map((row) => toSummary(row.repository, row.ownerName, row.ownerKind)),
    };
  });
}
