/**
 * Workflow-Endpunkte für die Oberfläche: Läufe anzeigen, auslösen,
 * wiederholen, abbrechen, Logs und Artefakte abrufen.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { hasAccess } from '@forge/shared';
import { db } from '../db/index.js';
import { auditLogs, workflowArtifacts, workflowJobs, workflowRuns, workflows } from '../db/schema.js';
import { forbidden, notFound, validationFailed } from '../lib/errors.js';
import { requireRepositoryAccess } from '../services/permissions.js';
import {
  cancelRun,
  getJobLog,
  getRunDetail,
  listRuns,
  listWorkflows,
  retryRun,
  syncWorkflows,
  triggerWorkflows,
} from '../services/workflows.js';
import { objectPath, safeFilename } from '../services/storage-objects.js';
import { resolveRef } from '../git/repository.js';

export async function registerWorkflowRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Workflows
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/workflows',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      if (!access.repository.hasActions) {
        throw notFound('Actions sind in diesem Repository deaktiviert.');
      }

      return { items: await listWorkflows(access.repository.id) };
    },
  );

  /** Liest die Workflow-Dateien neu ein – nützlich nach einem Import. */
  app.post<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/workflows/sync',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );

      if (access.repository.isEmpty) return { ok: true, items: [] };

      await syncWorkflows(access.repository.id, access.repository.defaultBranch);
      return { ok: true, items: await listWorkflows(access.repository.id) };
    },
  );

  // -------------------------------------------------------------------------
  // Läufe
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/actions/runs',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      const query = z
        .object({
          status: z
            .enum(['queued', 'waiting', 'running', 'success', 'failure', 'cancelled', 'timed_out', 'skipped'])
            .optional(),
          branch: z.string().max(255).optional(),
          workflowId: z.string().uuid().optional(),
          page: z.coerce.number().int().min(1).default(1),
          perPage: z.coerce.number().int().min(1).max(50).default(20),
        })
        .parse(request.query);

      return listRuns(access.repository.id, query);
    },
  );

  app.get<{ Params: { owner: string; repo: string; runId: string } }>(
    '/api/v1/repos/:owner/:repo/actions/runs/:runId',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      const detail = await getRunDetail(request.params.runId);
      // Die Zugehörigkeit zum Repository muss geprüft werden – sonst ließe
      // sich über ein öffentliches Repository ein fremder Lauf abrufen.
      if (!detail) throw notFound('Lauf nicht gefunden.');

      const owner = await db
        .select({ repositoryId: workflowRuns.repositoryId })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, request.params.runId))
        .limit(1);

      if (owner[0]?.repositoryId !== access.repository.id) {
        throw notFound('Lauf nicht gefunden.');
      }

      const artifacts = await db
        .select({
          id: workflowArtifacts.id,
          name: workflowArtifacts.name,
          sizeBytes: workflowArtifacts.sizeBytes,
          createdAt: workflowArtifacts.createdAt,
          expiresAt: workflowArtifacts.expiresAt,
        })
        .from(workflowArtifacts)
        .where(eq(workflowArtifacts.runId, request.params.runId));

      return { run: detail, artifacts };
    },
  );

  // -------------------------------------------------------------------------
  // Logs
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string; jobId: string } }>(
    '/api/v1/repos/:owner/:repo/actions/jobs/:jobId/logs',
    async (request, reply) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      const rows = await db
        .select({ repositoryId: workflowRuns.repositoryId })
        .from(workflowJobs)
        .innerJoin(workflowRuns, eq(workflowRuns.id, workflowJobs.runId))
        .where(eq(workflowJobs.id, request.params.jobId))
        .limit(1);

      if (rows[0]?.repositoryId !== access.repository.id) {
        throw notFound('Job nicht gefunden.');
      }

      const log = await getJobLog(request.params.jobId);

      reply.header('Content-Type', 'text/plain; charset=utf-8');
      return reply.send(log);
    },
  );

  // -------------------------------------------------------------------------
  // Auslösen
  // -------------------------------------------------------------------------
  app.post<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/actions/dispatch',
    async (request) => {
      app.requireAuth(request);
      const input = z
        .object({
          workflowPath: z.string().min(1).max(500),
          ref: z.string().min(1).max(255),
          inputs: z.record(z.string().max(1000)).optional(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );

      const sha = await resolveRef(access.repository.id, input.ref);
      if (!sha) throw validationFailed(`Die Referenz "${input.ref}" existiert nicht.`);

      const runIds = await triggerWorkflows({
        repositoryId: access.repository.id,
        event: 'workflow_dispatch',
        headSha: sha,
        headBranch: input.ref,
        triggeredById: request.viewer!.id,
        workflowPath: input.workflowPath,
        inputs: input.inputs ?? {},
      });

      if (runIds.length === 0) {
        throw validationFailed(
          'Für diesen Workflow ist kein manueller Start vorgesehen. Ergänze "workflow_dispatch" bei den Triggern.',
        );
      }

      return { runIds };
    },
  );

  app.post<{ Params: { owner: string; repo: string; runId: string } }>(
    '/api/v1/repos/:owner/:repo/actions/runs/:runId/retry',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );

      const rows = await db
        .select({ repositoryId: workflowRuns.repositoryId })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, request.params.runId))
        .limit(1);

      if (rows[0]?.repositoryId !== access.repository.id) throw notFound('Lauf nicht gefunden.');

      const runId = await retryRun(request.params.runId, request.viewer!.id);
      return { runId };
    },
  );

  app.post<{ Params: { owner: string; repo: string; runId: string } }>(
    '/api/v1/repos/:owner/:repo/actions/runs/:runId/cancel',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );

      const rows = await db
        .select({ repositoryId: workflowRuns.repositoryId, status: workflowRuns.status })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, request.params.runId))
        .limit(1);

      if (rows[0]?.repositoryId !== access.repository.id) throw notFound('Lauf nicht gefunden.');
      if (!['queued', 'running'].includes(rows[0].status)) {
        throw validationFailed('Dieser Lauf ist bereits abgeschlossen.');
      }

      await cancelRun(request.params.runId);
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Artefakte
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string; artifactId: string } }>(
    '/api/v1/repos/:owner/:repo/actions/artifacts/:artifactId',
    async (request, reply) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      const rows = await db
        .select({ artifact: workflowArtifacts, repositoryId: workflowRuns.repositoryId })
        .from(workflowArtifacts)
        .innerJoin(workflowRuns, eq(workflowRuns.id, workflowArtifacts.runId))
        .where(eq(workflowArtifacts.id, request.params.artifactId))
        .limit(1);

      const row = rows[0];
      if (!row || row.repositoryId !== access.repository.id) {
        throw notFound('Artefakt nicht gefunden.');
      }
      if (row.artifact.expiresAt && row.artifact.expiresAt < new Date()) {
        throw notFound('Dieses Artefakt ist abgelaufen.');
      }

      const { createReadStream } = await import('node:fs');

      reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Length', String(row.artifact.sizeBytes))
        .header('Content-Disposition', `attachment; filename="${safeFilename(row.artifact.name)}"`)
        .header('X-Content-Type-Options', 'nosniff');

      return reply.send(createReadStream(objectPath(row.artifact.storageKey)));
    },
  );
}
