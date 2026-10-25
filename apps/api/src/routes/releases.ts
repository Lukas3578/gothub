/**
 * Releases, Release-Dateien und Webhooks.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { ReleaseAsset, ReleaseSummary } from '@forge/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import {
  auditLogs,
  releaseAssets,
  releases,
  webhookDeliveries,
  webhooks,
} from '../db/schema.js';
import { conflict, isUniqueViolation, notFound, validationFailed } from '../lib/errors.js';
import { encryptSecret, generateToken } from '../lib/crypto.js';
import { requireRepositoryAccess } from '../services/permissions.js';
import { loadUserRefs } from '../services/issues.js';
import {
  deleteObject,
  objectPath,
  safeFilename,
  storeStream,
} from '../services/storage-objects.js';
import { assertDeliverableUrl, dispatchWebhook } from '../services/webhooks.js';
import { resolveRef } from '../git/repository.js';
import { runGit } from '../git/exec.js';
import { repositoryPath } from '../git/storage.js';

/** Obergrenze je Release-Datei. */
const MAX_ASSET_BYTES = 500 * 1024 * 1024;

export async function registerReleaseRoutes(app: FastifyInstance): Promise<void> {
  async function toSummary(
    row: typeof releases.$inferSelect,
    assets: (typeof releaseAssets.$inferSelect)[],
    ownerName: string,
    repoName: string,
  ): Promise<ReleaseSummary> {
    const refs = await loadUserRefs([row.authorId]);

    return {
      id: row.id,
      tagName: row.tagName,
      name: row.name,
      body: row.body,
      isDraft: row.isDraft,
      isPrerelease: row.isPrerelease,
      author: row.authorId ? (refs.get(row.authorId) ?? null) : null,
      assets: assets.map(
        (asset): ReleaseAsset => ({
          id: asset.id,
          name: asset.name,
          label: asset.label,
          contentType: asset.contentType,
          sizeBytes: asset.sizeBytes,
          downloadCount: asset.downloadCount,
          downloadUrl: `${config.server.publicApiUrl}/api/v1/repos/${ownerName}/${repoName}/releases/assets/${asset.id}`,
          createdAt: asset.createdAt.toISOString(),
        }),
      ),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Liste
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/releases',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      const canWrite = ['write', 'maintain', 'admin'].includes(access.level);

      const rows = await db
        .select()
        .from(releases)
        .where(
          and(
            eq(releases.repositoryId, access.repository.id),
            // Entwürfe sieht nur, wer schreiben darf.
            canWrite ? sql`true` : eq(releases.isDraft, false),
          ),
        )
        .orderBy(desc(releases.publishedAt), desc(releases.createdAt))
        .limit(50);

      const items = await Promise.all(
        rows.map(async (row) => {
          const assets = await db
            .select()
            .from(releaseAssets)
            .where(eq(releaseAssets.releaseId, row.id));
          return toSummary(row, assets, access.ownerName, access.repository.name);
        }),
      );

      return { items };
    },
  );

  // -------------------------------------------------------------------------
  // Anlegen
  // -------------------------------------------------------------------------
  app.post<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/releases',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({
          tagName: z.string().min(1).max(255),
          target: z.string().max(255).optional(),
          name: z.string().max(255).nullish(),
          body: z.string().max(100_000).nullish(),
          draft: z.boolean().default(false),
          prerelease: z.boolean().default(false),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );

      if (!access.repository.hasReleases) {
        throw notFound('Releases sind in diesem Repository deaktiviert.');
      }

      const cwd = repositoryPath(access.repository.id);
      const existingTag = await resolveRef(access.repository.id, input.tagName);

      // Existiert das Tag noch nicht, wird es angelegt – sonst zeigt das
      // Release auf nichts und der Download eines Quellarchivs scheitert.
      if (!existingTag) {
        const target = input.target ?? access.repository.defaultBranch;
        const targetOid = await resolveRef(access.repository.id, target);
        if (!targetOid) {
          throw validationFailed(`Das Ziel "${target}" existiert nicht.`);
        }

        const result = await runGit(['tag', '--', input.tagName, targetOid], {
          cwd,
          allowFailure: true,
        });
        if (result.exitCode !== 0) {
          throw validationFailed(`Das Tag konnte nicht angelegt werden: ${result.stderr}`);
        }
      }

      try {
        const [created] = await db
          .insert(releases)
          .values({
            repositoryId: access.repository.id,
            tagName: input.tagName,
            targetCommitish: input.target ?? access.repository.defaultBranch,
            name: input.name?.trim() || null,
            body: input.body?.trim() || null,
            isDraft: input.draft,
            isPrerelease: input.prerelease,
            authorId: request.viewer!.id,
            publishedAt: input.draft ? null : new Date(),
          })
          .returning();

        await db.insert(auditLogs).values({
          actorId: request.viewer!.id,
          action: 'release.created',
          targetType: 'release',
          targetId: created!.id,
          repositoryId: access.repository.id,
          metadata: { tagName: input.tagName },
        });

        if (!input.draft) {
          void dispatchWebhook({
            event: 'release',
            repositoryId: access.repository.id,
            payload: {
              action: 'published',
              release: { tagName: created!.tagName, name: created!.name },
            },
          });
        }

        reply.code(201);
        return toSummary(created!, [], access.ownerName, access.repository.name);
      } catch (error) {
        if (isUniqueViolation(error, 'releases_repo_tag_key', 'releases.tag_name')) {
          throw conflict('Für dieses Tag existiert bereits ein Release.');
        }
        throw error;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Ändern und Löschen
  // -------------------------------------------------------------------------
  app.patch<{ Params: { owner: string; repo: string; tag: string } }>(
    '/api/v1/repos/:owner/:repo/releases/:tag',
    async (request) => {
      app.requireAuth(request);
      const input = z
        .object({
          name: z.string().max(255).nullish(),
          body: z.string().max(100_000).nullish(),
          draft: z.boolean().optional(),
          prerelease: z.boolean().optional(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );
      const release = await findRelease(access.repository.id, request.params.tag);

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name?.trim() || null;
      if (input.body !== undefined) patch.body = input.body?.trim() || null;
      if (input.prerelease !== undefined) patch.isPrerelease = input.prerelease;
      if (input.draft !== undefined) {
        patch.isDraft = input.draft;
        // Beim Veröffentlichen eines Entwurfs wird der Zeitpunkt gesetzt.
        if (!input.draft && !release.publishedAt) patch.publishedAt = new Date();
      }

      await db.update(releases).set(patch).where(eq(releases.id, release.id));
      return { ok: true };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; tag: string } }>(
    '/api/v1/repos/:owner/:repo/releases/:tag',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );
      const release = await findRelease(access.repository.id, request.params.tag);

      // Die Dateien werden vor dem Datensatz entfernt: andernfalls bliebe bei
      // einem Fehler eine verwaiste Datei ohne Verweis zurück.
      const assets = await db
        .select()
        .from(releaseAssets)
        .where(eq(releaseAssets.releaseId, release.id));

      for (const asset of assets) {
        await deleteObject(asset.storageKey);
      }

      await db.delete(releases).where(eq(releases.id, release.id));
      return { ok: true };
    },
  );

  async function findRelease(repositoryId: string, tagName: string) {
    const rows = await db
      .select()
      .from(releases)
      .where(and(eq(releases.repositoryId, repositoryId), eq(releases.tagName, tagName)))
      .limit(1);
    if (!rows[0]) throw notFound('Release nicht gefunden.');
    return rows[0];
  }

  // -------------------------------------------------------------------------
  // Dateien
  // -------------------------------------------------------------------------
  app.post<{ Params: { owner: string; repo: string; tag: string } }>(
    '/api/v1/repos/:owner/:repo/releases/:tag/assets',
    async (request, reply) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );
      const release = await findRelease(access.repository.id, request.params.tag);

      const filename = safeFilename(
        (request.headers['x-forge-filename'] as string | undefined) ?? 'download',
      );
      const contentType =
        (request.headers['content-type'] as string | undefined) ?? 'application/octet-stream';

      const stored = await storeStream('release-assets', request.raw, MAX_ASSET_BYTES);

      try {
        const [asset] = await db
          .insert(releaseAssets)
          .values({
            releaseId: release.id,
            name: filename,
            storageKey: stored.storageKey,
            contentType,
            sizeBytes: stored.sizeBytes,
            sha256: stored.sha256,
            uploadedById: request.viewer!.id,
          })
          .returning();

        reply.code(201);
        return { id: asset!.id, name: asset!.name, sizeBytes: asset!.sizeBytes, sha256: stored.sha256 };
      } catch (error) {
        await deleteObject(stored.storageKey);
        if (isUniqueViolation(error, 'release_assets_release_name_key', 'release_assets.name')) {
          throw conflict('Eine Datei mit diesem Namen hängt bereits an diesem Release.');
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { owner: string; repo: string; assetId: string } }>(
    '/api/v1/repos/:owner/:repo/releases/assets/:assetId',
    async (request, reply) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      const rows = await db
        .select({ asset: releaseAssets, repositoryId: releases.repositoryId, isDraft: releases.isDraft })
        .from(releaseAssets)
        .innerJoin(releases, eq(releases.id, releaseAssets.releaseId))
        .where(eq(releaseAssets.id, request.params.assetId))
        .limit(1);

      const row = rows[0];
      // Die Zugehörigkeit muss geprüft werden: sonst ließe sich über ein
      // öffentliches Repository eine Datei aus einem privaten herunterladen.
      if (!row || row.repositoryId !== access.repository.id) {
        throw notFound('Datei nicht gefunden.');
      }
      if (row.isDraft && !['write', 'maintain', 'admin'].includes(access.level)) {
        throw notFound('Datei nicht gefunden.');
      }

      await db
        .update(releaseAssets)
        .set({ downloadCount: sql`${releaseAssets.downloadCount} + 1` })
        .where(eq(releaseAssets.id, row.asset.id));

      const { createReadStream } = await import('node:fs');

      reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Length', String(row.asset.sizeBytes))
        .header('Content-Disposition', `attachment; filename="${safeFilename(row.asset.name)}"`)
        .header('X-Content-Type-Options', 'nosniff');

      return reply.send(createReadStream(objectPath(row.asset.storageKey)));
    },
  );

  app.delete<{ Params: { owner: string; repo: string; assetId: string } }>(
    '/api/v1/repos/:owner/:repo/releases/assets/:assetId',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );

      const rows = await db
        .select({ asset: releaseAssets, repositoryId: releases.repositoryId })
        .from(releaseAssets)
        .innerJoin(releases, eq(releases.id, releaseAssets.releaseId))
        .where(eq(releaseAssets.id, request.params.assetId))
        .limit(1);

      const row = rows[0];
      if (!row || row.repositoryId !== access.repository.id) {
        throw notFound('Datei nicht gefunden.');
      }

      await deleteObject(row.asset.storageKey);
      await db.delete(releaseAssets).where(eq(releaseAssets.id, row.asset.id));
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Quellarchiv
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string; ref: string } }>(
    '/api/v1/repos/:owner/:repo/archive/:ref',
    async (request, reply) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      const { format } = z
        .object({ format: z.enum(['tar.gz', 'zip']).default('tar.gz') })
        .parse(request.query);

      const oid = await resolveRef(access.repository.id, request.params.ref);
      if (!oid) throw notFound('Referenz nicht gefunden.');

      const prefix = `${access.repository.name}-${request.params.ref.replace(/\//g, '-')}`;
      const gitFormat = format === 'zip' ? 'zip' : 'tar.gz';

      // git archive schreibt direkt in den Stream; das Archiv wird nie
      // vollständig im Speicher gehalten.
      const { spawnGit } = await import('../git/exec.js');
      const child = spawnGit(
        ['archive', `--format=${gitFormat}`, `--prefix=${prefix}/`, oid],
        { cwd: repositoryPath(access.repository.id) },
      );

      reply.raw.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safeFilename(`${prefix}.${format}`)}"`,
        'X-Content-Type-Options': 'nosniff',
      });

      child.stdout.pipe(reply.raw);
      child.on('close', () => reply.raw.end());

      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded && !child.killed) child.kill('SIGKILL');
      });

      return reply;
    },
  );

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/webhooks',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      const rows = await db
        .select({
          id: webhooks.id,
          url: webhooks.url,
          events: webhooks.events,
          isActive: webhooks.isActive,
          contentType: webhooks.contentType,
          consecutiveFailures: webhooks.consecutiveFailures,
          // mapWith(Boolean): SQLite liefert für einen Vergleich 0 oder 1,
          // PostgreSQL false oder true. Ohne die Umwandlung stünde in der
          // Antwort eine Zahl, wo die Oberfläche einen Wahrheitswert erwartet.
          hasSecret: sql<boolean>`${webhooks.secretEnc} IS NOT NULL`.mapWith(Boolean),
          createdAt: webhooks.createdAt,
        })
        .from(webhooks)
        .where(eq(webhooks.repositoryId, access.repository.id))
        .orderBy(desc(webhooks.createdAt));

      // Das Geheimnis selbst wird nie zurückgegeben, nur ob eines gesetzt ist.
      return { items: rows };
    },
  );

  app.post<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/webhooks',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({
          url: z.string().url().max(1000),
          events: z
            .array(
              z.enum([
                'push',
                'issues',
                'issue_comment',
                'pull_request',
                'pull_request_review',
                'release',
                'workflow_run',
              ]),
            )
            .min(1)
            .max(10),
          secret: z.string().max(200).nullish(),
          contentType: z.enum(['application/json']).default('application/json'),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      await assertDeliverableUrl(input.url);

      // Ohne Geheimnis kann der Empfänger die Herkunft nicht prüfen, deshalb
      // wird eines erzeugt, wenn keines angegeben wurde.
      const secret = input.secret?.trim() || generateToken(24);

      const [created] = await db
        .insert(webhooks)
        .values({
          repositoryId: access.repository.id,
          url: input.url,
          events: input.events,
          secretEnc: encryptSecret(secret),
          contentType: input.contentType,
          createdById: request.viewer!.id,
        })
        .returning();

      reply.code(201);
      // Das Geheimnis wird genau einmal ausgegeben.
      return { id: created!.id, secret };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; id: string } }>(
    '/api/v1/repos/:owner/:repo/webhooks/:id',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      const deleted = await db
        .delete(webhooks)
        .where(
          and(eq(webhooks.id, request.params.id), eq(webhooks.repositoryId, access.repository.id)),
        )
        .returning();

      if (deleted.length === 0) throw notFound('Webhook nicht gefunden.');
      return { ok: true };
    },
  );

  app.get<{ Params: { owner: string; repo: string; id: string } }>(
    '/api/v1/repos/:owner/:repo/webhooks/:id/deliveries',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );

      const hookRows = await db
        .select({ id: webhooks.id })
        .from(webhooks)
        .where(
          and(eq(webhooks.id, request.params.id), eq(webhooks.repositoryId, access.repository.id)),
        )
        .limit(1);

      if (!hookRows[0]) throw notFound('Webhook nicht gefunden.');

      const items = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, request.params.id))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(30);

      return { items };
    },
  );
}
