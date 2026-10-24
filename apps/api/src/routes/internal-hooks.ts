/**
 * Interner Endpunkt für den pre-receive-Hook.
 *
 * Nur aus dem Hook-Prozess erreichbar: die Anfrage muss das bei jedem Start
 * neu erzeugte Hook-Geheimnis tragen. Der Endpunkt steht bewusst nicht unter
 * /api/v1, damit er nicht versehentlich als öffentliche API gilt.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { branchProtections, issues, pullRequests, pushEvents, repositories } from '../db/schema.js';
import { verifyHookSecret } from '../git/hooks.js';

const ZERO_OID = '0'.repeat(40);

const payloadSchema = z.object({
  repositoryId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  updates: z
    .array(
      z.object({
        oldOid: z.string().length(40),
        newOid: z.string().length(40),
        refName: z.string().min(1).max(500),
        // Vom Hook berechnet, weil nur dort die neuen Objekte sichtbar sind.
        isCreation: z.boolean(),
        isDeletion: z.boolean(),
        isForcePush: z.boolean(),
        commitCount: z.number().int().min(0),
      }),
    )
    .max(200),
});

function matchesPattern(name: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

export async function registerInternalHookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/internal/git/pre-receive', async (request, reply) => {
    if (!verifyHookSecret(request.headers['x-forge-hook-secret'] as string | undefined)) {
      reply.code(403);
      return { allowed: false, reasons: ['Ungültige Hook-Authentifizierung.'] };
    }

    const payload = payloadSchema.parse(request.body);

    const repoRows = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, payload.repositoryId))
      .limit(1);

    const repository = repoRows[0];
    if (!repository) {
      return { allowed: false, reasons: ['Repository nicht gefunden.'] };
    }

    if (repository.isArchived) {
      return { allowed: false, reasons: ['Dieses Repository ist archiviert.'] };
    }

    const protections = await db
      .select()
      .from(branchProtections)
      .where(eq(branchProtections.repositoryId, repository.id));

    const reasons: string[] = [];

    for (const update of payload.updates) {
      if (!update.refName.startsWith('refs/heads/')) continue;

      const branch = update.refName.slice('refs/heads/'.length);
      const protection = protections.find((p) => matchesPattern(branch, p.pattern));
      if (!protection) continue;

      if (update.isDeletion && protection.blockDeletion) {
        reasons.push(`Der Branch "${branch}" ist geschützt und darf nicht gelöscht werden.`);
        continue;
      }

      if (update.isForcePush && protection.blockForcePush) {
        reasons.push(`Force-Push auf den geschützten Branch "${branch}" ist nicht erlaubt.`);
        continue;
      }

      if (!update.isDeletion && protection.requirePullRequest) {
        // Ein direkter Push ist nur erlaubt, wenn er das Ergebnis eines
        // Merges über die Plattform ist. Das erkennt man daran, dass der neue
        // Commit als Merge-Commit eines Pull Requests eingetragen wurde.
        const merged = await db
          .select({ issueId: pullRequests.issueId })
          .from(pullRequests)
          .where(
            and(
              eq(pullRequests.baseRepositoryId, repository.id),
              eq(pullRequests.mergeCommitSha, update.newOid),
            ),
          )
          .limit(1);

        if (merged.length === 0) {
          reasons.push(
            `Der Branch "${branch}" ist geschützt. Änderungen müssen über einen Pull Request erfolgen.`,
          );
        }
      }
    }

    if (reasons.length > 0) {
      return { allowed: false, reasons };
    }

    // Der Push ist erlaubt. Die Ereignisse werden hier protokolliert, weil
    // hier die alten und neuen Commits bekannt sind – nach dem Push ließe sich
    // der vorherige Stand nicht mehr feststellen.
    await db.insert(pushEvents).values(
      payload.updates.map((update) => ({
        repositoryId: repository.id,
        pusherId: payload.userId,
        refName: update.refName,
        oldOid: update.oldOid,
        newOid: update.newOid,
        isForcePush: update.isForcePush,
        commitCount: update.commitCount,
      })),
    );

    return { allowed: true };
  });
}
