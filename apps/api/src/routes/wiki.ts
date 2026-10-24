/**
 * Wiki-Endpunkte.
 *
 * Lesen folgt der Sichtbarkeit des Repositories, Schreiben verlangt
 * Schreibrecht. Ist das Wiki in den Repository-Einstellungen abgeschaltet,
 * sind alle Endpunkte stumm – sonst bliebe der Inhalt über die API erreichbar,
 * obwohl die Oberfläche ihn nicht mehr anbietet.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { auditLogs } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { requireRepositoryAccess, type ResolvedAccess } from '../services/permissions.js';
import {
  currentWikiOid,
  deletePage,
  listPages,
  pageHistory,
  readPage,
  writePage,
} from '../services/wiki.js';

export async function registerWikiRoutes(app: FastifyInstance): Promise<void> {
  function assertWikiEnabled(access: ResolvedAccess): void {
    if (!access.repository.hasWiki) {
      throw notFound('Für dieses Repository ist kein Wiki aktiviert.');
    }
  }

  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/wiki/pages',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      assertWikiEnabled(access);

      return {
        items: await listPages(access.repository.id),
        currentOid: await currentWikiOid(access.repository.id),
        viewerCanEdit: ['write', 'maintain', 'admin'].includes(access.level),
      };
    },
  );

  app.get<{ Params: { owner: string; repo: string; slug: string } }>(
    '/api/v1/repos/:owner/:repo/wiki/pages/:slug',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      assertWikiEnabled(access);

      const page = await readPage(access.repository.id, request.params.slug);

      return {
        ...page,
        currentOid: await currentWikiOid(access.repository.id),
        viewerCanEdit: ['write', 'maintain', 'admin'].includes(access.level),
      };
    },
  );

  app.put<{ Params: { owner: string; repo: string; slug: string } }>(
    '/api/v1/repos/:owner/:repo/wiki/pages/:slug',
    async (request) => {
      app.requireAuth(request);
      const input = z
        .object({
          content: z.string().max(1024 * 1024),
          message: z.string().max(500).optional(),
          expectedOid: z.string().length(40).nullish(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );
      assertWikiEnabled(access);

      const commitOid = await writePage(access.repository.id, {
        slug: request.params.slug,
        content: input.content,
        message: input.message,
        author: { name: request.viewer!.username, email: request.viewer!.email },
        expectedOid: input.expectedOid ?? undefined,
      });

      await db.insert(auditLogs).values({
        actorId: request.viewer!.id,
        action: 'wiki.page_updated',
        targetType: 'repository',
        targetId: access.repository.id,
        repositoryId: access.repository.id,
        metadata: { slug: request.params.slug },
      });

      return { ok: true, commitOid, currentOid: commitOid };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; slug: string } }>(
    '/api/v1/repos/:owner/:repo/wiki/pages/:slug',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );
      assertWikiEnabled(access);

      const commitOid = await deletePage(access.repository.id, request.params.slug, {
        name: request.viewer!.username,
        email: request.viewer!.email,
      });

      await db.insert(auditLogs).values({
        actorId: request.viewer!.id,
        action: 'wiki.page_deleted',
        targetType: 'repository',
        targetId: access.repository.id,
        repositoryId: access.repository.id,
        metadata: { slug: request.params.slug },
      });

      return { ok: true, commitOid };
    },
  );

  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/wiki/history',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      assertWikiEnabled(access);

      const query = z
        .object({ slug: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) })
        .parse(request.query);

      return { items: await pageHistory(access.repository.id, query.slug ?? null, query.limit) };
    },
  );
}
