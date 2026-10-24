/**
 * Branch-Schutzregeln.
 *
 * Die Regeln werden an drei Stellen durchgesetzt, nicht nur hier:
 *  - beim Bearbeiten einer Datei über die Oberfläche (routes/git-data.ts)
 *  - beim Löschen eines Branches (routes/git-data.ts)
 *  - bei den Merge-Voraussetzungen eines Pull Requests (services/pull-requests.ts)
 *  - beim Push über Git (git/hooks.ts)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLogs, branchProtections } from '../db/schema.js';
import { notFound, validationFailed } from '../lib/errors.js';
import { requireRepositoryAccess } from '../services/permissions.js';

const protectionSchema = z.object({
  pattern: z.string().min(1).max(255),
  requirePullRequest: z.boolean().default(true),
  requiredApprovals: z.number().int().min(0).max(10).default(1),
  dismissStaleReviews: z.boolean().default(false),
  requireStatusChecks: z.boolean().default(false),
  requiredStatusChecks: z.array(z.string().max(255)).max(20).default([]),
  requireLinearHistory: z.boolean().default(false),
  blockForcePush: z.boolean().default(true),
  blockDeletion: z.boolean().default(true),
});

export async function registerBranchProtectionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/branch-protections',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      const items = await db
        .select()
        .from(branchProtections)
        .where(eq(branchProtections.repositoryId, access.repository.id));

      return { items };
    },
  );

  app.put<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/branch-protections',
    async (request) => {
      app.requireAuth(request);
      const input = protectionSchema.parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      // Ein Muster, das auf nichts passt, ist fast immer ein Tippfehler und
      // wiegt den Benutzer in falscher Sicherheit. Ein Hinweis genügt aber –
      // Muster für künftige Branches sind legitim.
      if (input.pattern.includes(' ')) {
        throw validationFailed('Das Muster darf keine Leerzeichen enthalten.');
      }

      const [saved] = await db
        .insert(branchProtections)
        .values({ repositoryId: access.repository.id, ...input })
        .onConflictDoUpdate({
          target: [branchProtections.repositoryId, branchProtections.pattern],
          set: {
            requirePullRequest: input.requirePullRequest,
            requiredApprovals: input.requiredApprovals,
            dismissStaleReviews: input.dismissStaleReviews,
            requireStatusChecks: input.requireStatusChecks,
            requiredStatusChecks: input.requiredStatusChecks,
            requireLinearHistory: input.requireLinearHistory,
            blockForcePush: input.blockForcePush,
            blockDeletion: input.blockDeletion,
          },
        })
        .returning();

      await db.insert(auditLogs).values({
        actorId: request.viewer!.id,
        action: 'branch_protection.saved',
        targetType: 'repository',
        targetId: access.repository.id,
        repositoryId: access.repository.id,
        metadata: { pattern: input.pattern },
      });

      return saved;
    },
  );

  app.delete<{ Params: { owner: string; repo: string; id: string } }>(
    '/api/v1/repos/:owner/:repo/branch-protections/:id',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      const deleted = await db
        .delete(branchProtections)
        .where(
          and(
            eq(branchProtections.id, request.params.id),
            // Die Zugehörigkeit zum Repository gehört in die Bedingung, nicht
            // in eine vorgelagerte Prüfung: sonst ließe sich über ein eigenes
            // Repository eine fremde Regel löschen.
            eq(branchProtections.repositoryId, access.repository.id),
          ),
        )
        .returning();

      if (deleted.length === 0) throw notFound('Regel nicht gefunden.');

      await db.insert(auditLogs).values({
        actorId: request.viewer!.id,
        action: 'branch_protection.deleted',
        targetType: 'repository',
        targetId: access.repository.id,
        repositoryId: access.repository.id,
        metadata: { pattern: deleted[0]!.pattern },
      });

      return { ok: true };
    },
  );
}
