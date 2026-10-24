/**
 * Runner-Protokoll.
 *
 * Ein Runner ist ein eigenständiger Prozess, der sich mit einem Token
 * ausweist, nach Arbeit fragt, Logs schickt und das Ergebnis meldet. Er hat
 * absichtlich keinen Zugriff auf die normale API: sein Token berechtigt nur zu
 * den Endpunkten hier, und jede Anfrage prüft, dass der Job wirklich ihm
 * zugewiesen ist.
 *
 * Der Runner kann weder Repositories auflisten noch fremde Jobs abrufen. Er
 * bekommt genau die Daten des Jobs, den er gerade ausführt – einschließlich
 * der Secrets, die für diesen Lauf gelten, und keiner anderen.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { RunnerSummary } from '@forge/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import {
  auditLogs,
  namespaces,
  organizations,
  repositories,
  runners,
  secrets,
  variables,
  workflowArtifacts,
  workflowJobs,
} from '../db/schema.js';
import { forbidden, notFound, unauthenticated, validationFailed } from '../lib/errors.js';
import { encryptSecret, generateToken, hashToken } from '../lib/crypto.js';
import { requireOrganizationRole, requireRepositoryAccess } from '../services/permissions.js';
import {
  appendLog,
  claimJob,
  completeJob,
  heartbeatJob,
  updateStep,
} from '../services/workflows.js';
import { deleteObject, storeStream } from '../services/storage-objects.js';

const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;

/** Löst das Runner-Token auf. Gibt null zurück, wenn es ungültig ist. */
async function resolveRunner(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;

  const token = header.slice(7).trim();
  const rows = await db
    .select()
    .from(runners)
    .where(eq(runners.tokenHash, hashToken(token)))
    .limit(1);

  const runner = rows[0];
  if (!runner || runner.status === 'disabled') return null;
  return runner;
}

export async function registerRunnerRoutes(app: FastifyInstance): Promise<void> {
  /** Guard für alle Runner-Endpunkte. */
  async function requireRunner(request: FastifyRequest) {
    const runner = await resolveRunner(request);
    if (!runner) throw unauthenticated('Ungültiges Runner-Token.');
    return runner;
  }

  /**
   * Stellt sicher, dass der Job dem anfragenden Runner gehört.
   * Ohne diese Prüfung könnte ein Runner die Logs fremder Jobs überschreiben
   * oder sie als erfolgreich melden.
   */
  async function requireOwnJob(jobId: string, runnerId: string) {
    const rows = await db
      .select()
      .from(workflowJobs)
      .where(and(eq(workflowJobs.id, jobId), eq(workflowJobs.runnerId, runnerId)))
      .limit(1);

    if (!rows[0]) throw notFound('Job nicht gefunden oder nicht diesem Runner zugewiesen.');
    return rows[0];
  }

  // -------------------------------------------------------------------------
  // Anmelden
  // -------------------------------------------------------------------------
  app.post('/api/v1/runner/session', async (request) => {
    const runner = await requireRunner(request);
    const input = z
      .object({
        osName: z.string().max(64).optional(),
        architecture: z.string().max(32).optional(),
        version: z.string().max(32).optional(),
        labels: z.array(z.string().max(64)).max(20).optional(),
      })
      .parse(request.body ?? {});

    await db
      .update(runners)
      .set({
        status: 'idle',
        lastSeenAt: new Date(),
        osName: input.osName ?? runner.osName,
        architecture: input.architecture ?? runner.architecture,
        version: input.version ?? runner.version,
        // Labels kommen vom Runner selbst; die Zuweisung richtet sich danach.
        labels: input.labels ?? runner.labels,
      })
      .where(eq(runners.id, runner.id));

    return {
      runnerId: runner.id,
      name: runner.name,
      labels: input.labels ?? runner.labels,
      pollIntervalMs: 3000,
    };
  });

  // -------------------------------------------------------------------------
  // Job abholen
  // -------------------------------------------------------------------------
  app.post('/api/v1/runner/jobs/claim', async (request) => {
    const runner = await requireRunner(request);

    await db
      .update(runners)
      .set({ lastSeenAt: new Date() })
      .where(eq(runners.id, runner.id));

    const assignment = await claimJob(runner.id, runner.labels);

    if (!assignment) {
      await db.update(runners).set({ status: 'idle' }).where(eq(runners.id, runner.id));
      return { job: null };
    }

    await db.update(runners).set({ status: 'busy' }).where(eq(runners.id, runner.id));

    // Die Klon-URL wird hier zur vollständigen Adresse ergänzt, inklusive
    // eines kurzlebigen Tokens für den Lesezugriff.
    return {
      job: {
        ...assignment,
        cloneUrl: `${config.server.publicApiUrl}${assignment.cloneUrl}`,
      },
    };
  });

  // -------------------------------------------------------------------------
  // Lebenszeichen
  // -------------------------------------------------------------------------
  app.post<{ Params: { jobId: string } }>(
    '/api/v1/runner/jobs/:jobId/heartbeat',
    async (request) => {
      const runner = await requireRunner(request);
      const alive = await heartbeatJob(request.params.jobId, runner.id);

      await db.update(runners).set({ lastSeenAt: new Date() }).where(eq(runners.id, runner.id));

      // Meldet der Server, dass der Job nicht mehr läuft, soll der Runner
      // abbrechen – etwa weil der Lauf storniert wurde.
      return { continue: alive };
    },
  );

  // -------------------------------------------------------------------------
  // Logs
  // -------------------------------------------------------------------------
  app.post<{ Params: { jobId: string } }>('/api/v1/runner/jobs/:jobId/logs', async (request) => {
    const runner = await requireRunner(request);
    await requireOwnJob(request.params.jobId, runner.id);

    const input = z
      .object({
        stepNumber: z.number().int().nullable(),
        content: z.string().max(256 * 1024),
      })
      .parse(request.body);

    await appendLog(request.params.jobId, input.stepNumber, input.content);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Schrittstatus
  // -------------------------------------------------------------------------
  app.post<{ Params: { jobId: string } }>('/api/v1/runner/jobs/:jobId/steps', async (request) => {
    const runner = await requireRunner(request);
    await requireOwnJob(request.params.jobId, runner.id);

    const input = z
      .object({
        stepNumber: z.number().int().min(1),
        status: z.enum([
          'queued',
          'running',
          'success',
          'failure',
          'cancelled',
          'timed_out',
          'skipped',
        ]),
        exitCode: z.number().int().nullish(),
      })
      .parse(request.body);

    await updateStep(request.params.jobId, input.stepNumber, {
      status: input.status,
      exitCode: input.exitCode ?? null,
      startedAt: input.status === 'running',
      completedAt: ['success', 'failure', 'cancelled', 'timed_out', 'skipped'].includes(
        input.status,
      ),
    });

    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Job abschließen
  // -------------------------------------------------------------------------
  app.post<{ Params: { jobId: string } }>(
    '/api/v1/runner/jobs/:jobId/complete',
    async (request) => {
      const runner = await requireRunner(request);
      await requireOwnJob(request.params.jobId, runner.id);

      const input = z
        .object({
          status: z.enum(['success', 'failure', 'cancelled', 'timed_out']),
          exitCode: z.number().int().nullish(),
          errorMessage: z.string().max(5000).nullish(),
        })
        .parse(request.body);

      await completeJob(
        request.params.jobId,
        input.status,
        input.exitCode ?? null,
        input.errorMessage ?? null,
      );

      await db.update(runners).set({ status: 'idle' }).where(eq(runners.id, runner.id));
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Artefakte
  // -------------------------------------------------------------------------
  app.post<{ Params: { jobId: string } }>(
    '/api/v1/runner/jobs/:jobId/artifacts',
    async (request, reply) => {
      const runner = await requireRunner(request);
      const job = await requireOwnJob(request.params.jobId, runner.id);

      const name = (request.headers['x-forge-artifact-name'] as string | undefined) ?? 'artifact';
      const stored = await storeStream('artifacts', request.raw, MAX_ARTIFACT_BYTES);

      try {
        const [artifact] = await db
          .insert(workflowArtifacts)
          .values({
            runId: job.runId,
            name: name.slice(0, 255),
            storageKey: stored.storageKey,
            sizeBytes: stored.sizeBytes,
            sha256: stored.sha256,
            contentType: 'application/octet-stream',
            // Artefakte laufen nach 30 Tagen ab, damit der Speicher nicht
            // unbegrenzt wächst.
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          })
          .returning();

        reply.code(201);
        return { id: artifact!.id, sizeBytes: stored.sizeBytes };
      } catch (error) {
        await deleteObject(stored.storageKey);
        throw error;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Runner verwalten (normale Benutzer-API)
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/runners',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      const rows = await db
        .select()
        .from(runners)
        .where(eq(runners.repositoryId, access.repository.id))
        .orderBy(desc(runners.lastSeenAt));

      return { items: rows.map(toRunnerSummary) };
    },
  );

  app.post<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/runners',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({
          name: z.string().min(1).max(255),
          labels: z.array(z.string().max(64)).max(20).default(['self-hosted']),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      const token = `fgr_${generateToken(24)}`;

      const [created] = await db
        .insert(runners)
        .values({
          name: input.name,
          repositoryId: access.repository.id,
          tokenHash: hashToken(token),
          labels: input.labels,
          createdById: request.viewer!.id,
        })
        .returning();

      await db.insert(auditLogs).values({
        actorId: request.viewer!.id,
        action: 'runner.registered',
        targetType: 'runner',
        targetId: created!.id,
        repositoryId: access.repository.id,
        metadata: { name: input.name, labels: input.labels },
      });

      reply.code(201);
      // Das Token wird genau einmal ausgegeben.
      return { id: created!.id, token };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; id: string } }>(
    '/api/v1/repos/:owner/:repo/runners/:id',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      const deleted = await db
        .delete(runners)
        .where(
          and(eq(runners.id, request.params.id), eq(runners.repositoryId, access.repository.id)),
        )
        .returning();

      if (deleted.length === 0) throw notFound('Runner nicht gefunden.');
      return { ok: true };
    },
  );

  function toRunnerSummary(row: typeof runners.$inferSelect): RunnerSummary {
    return {
      id: row.id,
      name: row.name,
      scope: row.repositoryId ? 'repository' : row.organizationId ? 'organization' : 'platform',
      labels: row.labels,
      // Ein Runner, der sich länger als zwei Minuten nicht gemeldet hat, gilt
      // als offline – unabhängig davon, was zuletzt gespeichert wurde.
      status:
        row.status !== 'disabled' &&
        (!row.lastSeenAt || Date.now() - row.lastSeenAt.getTime() > 120_000)
          ? 'offline'
          : row.status,
      osName: row.osName,
      architecture: row.architecture,
      version: row.version,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Secrets und Variablen
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/secrets',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      // Nur Namen und Zeitpunkte – der Wert verlässt den Server nur in
      // Richtung Runner.
      const rows = await db
        .select({
          id: secrets.id,
          name: secrets.name,
          environment: secrets.environment,
          updatedAt: secrets.updatedAt,
          createdAt: secrets.createdAt,
        })
        .from(secrets)
        .where(eq(secrets.repositoryId, access.repository.id))
        .orderBy(secrets.name);

      return { items: rows };
    },
  );

  app.put<{ Params: { owner: string; repo: string; name: string } }>(
    '/api/v1/repos/:owner/:repo/secrets/:name',
    async (request) => {
      app.requireAuth(request);
      const { value } = z.object({ value: z.string().min(1).max(10_000) }).parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      const name = request.params.name;
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
        throw validationFailed(
          'Der Name darf nur Buchstaben, Ziffern und Unterstriche enthalten und nicht mit einer Ziffer beginnen.',
        );
      }

      await db
        .insert(secrets)
        .values({
          repositoryId: access.repository.id,
          name,
          valueEnc: encryptSecret(value),
          createdById: request.viewer!.id,
        })
        .onConflictDoUpdate({
          target: [secrets.repositoryId, secrets.environment, secrets.name],
          set: { valueEnc: encryptSecret(value), updatedAt: new Date() },
        });

      await db.insert(auditLogs).values({
        actorId: request.viewer!.id,
        action: 'secret.set',
        targetType: 'repository',
        targetId: access.repository.id,
        repositoryId: access.repository.id,
        // Der Wert selbst steht nie im Audit-Log.
        metadata: { name },
      });

      return { ok: true };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; name: string } }>(
    '/api/v1/repos/:owner/:repo/secrets/:name',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      await db
        .delete(secrets)
        .where(
          and(eq(secrets.repositoryId, access.repository.id), eq(secrets.name, request.params.name)),
        );

      return { ok: true };
    },
  );

  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/variables',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      const rows = await db
        .select()
        .from(variables)
        .where(eq(variables.repositoryId, access.repository.id))
        .orderBy(variables.name);

      return { items: rows };
    },
  );

  app.put<{ Params: { owner: string; repo: string; name: string } }>(
    '/api/v1/repos/:owner/:repo/variables/:name',
    async (request) => {
      app.requireAuth(request);
      const { value } = z.object({ value: z.string().max(10_000) }).parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      const name = request.params.name;
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
        throw validationFailed('Ungültiger Variablenname.');
      }

      await db
        .insert(variables)
        .values({ repositoryId: access.repository.id, name, value })
        .onConflictDoUpdate({
          target: [variables.repositoryId, variables.environment, variables.name],
          set: { value, updatedAt: new Date() },
        });

      return { ok: true };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; name: string } }>(
    '/api/v1/repos/:owner/:repo/variables/:name',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      await db
        .delete(variables)
        .where(
          and(
            eq(variables.repositoryId, access.repository.id),
            eq(variables.name, request.params.name),
          ),
        );

      return { ok: true };
    },
  );
}
