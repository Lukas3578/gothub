/**
 * Endpunkte für die Spiegelung auf andere Git-Hoster.
 *
 * Einrichten und Auslösen setzt `admin` auf dem Repository voraus: wer einen
 * Spiegel anlegt, bestimmt, wohin der gesamte Quelltext fließt.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { auditLogs } from '../db/schema.js';
import { requireRepositoryAccess } from '../services/permissions.js';
import {
  deleteMirror,
  listMirrors,
  runMirror,
  testRemote,
  upsertMirror,
} from '../services/mirrors.js';

const mirrorSchema = z.object({
  direction: z.enum(['push', 'pull']),
  remoteUrl: z.string().min(1).max(1000),
  remoteUsername: z.string().max(200).nullish(),
  /**
   * Nicht angegeben: vorhandenes Token bleibt. Leerer String: Token wird
   * entfernt. So lässt sich die Adresse ändern, ohne das Token erneut
   * eintippen zu müssen.
   */
  token: z.string().max(500).nullish(),
  isEnabled: z.boolean().optional(),
  isExactCopy: z.boolean().optional(),
});

export async function registerMirrorRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/mirrors',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );
      return { items: await listMirrors(access.repository.id) };
    },
  );

  app.put<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/mirrors',
    async (request) => {
      app.requireAuth(request);
      const input = mirrorSchema.parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      const saved = await upsertMirror({
        repositoryId: access.repository.id,
        direction: input.direction,
        remoteUrl: input.remoteUrl,
        remoteUsername: input.remoteUsername ?? null,
        token: input.token ?? null,
        isEnabled: input.isEnabled,
        isExactCopy: input.isExactCopy,
        actorId: request.viewer!.id,
      });

      await db.insert(auditLogs).values({
        actorId: request.viewer!.id,
        action: 'repository.mirror_configured',
        targetType: 'repository',
        targetId: access.repository.id,
        repositoryId: access.repository.id,
        // Die Adresse wird protokolliert, das Token selbstverständlich nicht.
        metadata: { direction: input.direction, remoteUrl: saved.remoteUrl },
      });

      return saved;
    },
  );

  /**
   * Prüft Adresse und Token, ohne etwas zu übertragen.
   * Gedacht für das Einrichten: Fehler fallen sofort auf.
   */
  app.post<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/mirrors/test',
    async (request) => {
      app.requireAuth(request);
      const input = z
        .object({
          direction: z.enum(['push', 'pull']).default('push'),
          remoteUrl: z.string().min(1).max(1000),
          remoteUsername: z.string().max(200).nullish(),
          token: z.string().max(500).nullish(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      return testRemote({
        remoteUrl: input.remoteUrl,
        remoteUsername: input.remoteUsername ?? null,
        token: input.token ?? null,
        repositoryId: access.repository.id,
        direction: input.direction,
      });
    },
  );

  app.post<{ Params: { owner: string; repo: string; id: string } }>(
    '/api/v1/repos/:owner/:repo/mirrors/:id/sync',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      const mirrors = await listMirrors(access.repository.id);
      const target = mirrors.find((entry) => entry.id === request.params.id);
      if (!target) {
        return { ok: false, error: 'Spiegelung nicht gefunden.' };
      }

      const result = await runMirror(target.id);
      const refreshed = await listMirrors(access.repository.id);

      return {
        ...result,
        mirror: refreshed.find((entry) => entry.id === target.id) ?? null,
      };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; id: string } }>(
    '/api/v1/repos/:owner/:repo/mirrors/:id',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      await deleteMirror(access.repository.id, request.params.id);

      await db.insert(auditLogs).values({
        actorId: request.viewer!.id,
        action: 'repository.mirror_removed',
        targetType: 'repository',
        targetId: access.repository.id,
        repositoryId: access.repository.id,
      });

      return { ok: true };
    },
  );
}
