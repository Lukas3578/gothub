/**
 * GitHub-kompatible Schnittstelle (Ausschnitt).
 *
 * Programme, die mit GitHub Releases arbeiten, laufen damit unverändert gegen
 * Forge – man ändert nur die Adresse. Das Schema entspricht GitHub Enterprise:
 *
 *   REST     <forge>/api/v3/...            (statt https://api.github.com/...)
 *   Uploads  <forge>/api/uploads/...       (statt https://uploads.github.com/...)
 *   Dateien  <forge>/<owner>/<repo>/releases/download/<tag>/<datei>
 *            <forge>/<owner>/<repo>/releases/latest/download/<datei>
 *   Feed     <forge>/<owner>/<repo>/releases.atom
 *
 * Damit funktionieren unter anderem:
 *  - electron-updater mit `provider: github, host: <forge>` (Atom-Feed,
 *    /api/v3/.../releases/latest, Download-URLs)
 *  - Skripte, die Releases anlegen, Dateien hochladen und löschen
 *  - "Neueste Version"-Links wie auf GitHub
 *
 * Bewusst NICHT nachgebaut: GraphQL, Checks, Pages und alles, was ohne
 * Gegenstück in Forge wäre. Unbekannte Pfade unter /api/v3 antworten mit 404
 * im GitHub-Format, damit Clients sauber scheitern statt zu raten.
 *
 * Authentifizierung wie bei GitHub: `Authorization: Bearer <token>`,
 * `Authorization: token <token>` oder Basic mit dem Token als Passwort. Es
 * gelten die persönlichen Zugriffstokens von Forge (fgp_...).
 */

import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { auditLogs, issues, releaseAssets, releases } from '../db/schema.js';
import { createIssue } from '../services/issues.js';
import { notifyIssueActivity } from '../services/notifications.js';
import { ApiError, isUniqueViolation, notFound, validationFailed } from '../lib/errors.js';
import { requireRepositoryAccess, type ResolvedAccess } from '../services/permissions.js';
import { deleteObject, objectPath, safeFilename, storeStream } from '../services/storage-objects.js';
import { dispatchWebhook } from '../services/webhooks.js';
import { readBlobRaw, resolveRef } from '../git/repository.js';
import { runGit } from '../git/exec.js';
import { repositoryPath } from '../git/storage.js';

/** Obergrenze je Release-Datei (wie in routes/releases.ts). */
const MAX_ASSET_BYTES = 500 * 1024 * 1024;

type ReleaseRow = typeof releases.$inferSelect;
type AssetRow = typeof releaseAssets.$inferSelect;
type RepoParams = { owner: string; repo: string };

const WRITE_LEVELS = ['write', 'maintain', 'admin'];
const canWrite = (access: ResolvedAccess) => WRITE_LEVELS.includes(access.level);

/** Basisadresse für Links in den Antworten (Web und Downloads laufen über dieselbe Adresse wie die API). */
const base = () => config.server.publicApiUrl.replace(/\/$/, '');
const apiBase = () => `${base()}/api/v3`;

/** Fehler im GitHub-Format: { message, documentation_url }. */
function ghError(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).send({ message, documentation_url: `${base()}/api/v3` });
}

function repoJson(access: ResolvedAccess) {
  const r = access.repository;
  const full = `${access.ownerName}/${r.name}`;
  return {
    id: r.id,
    name: r.name,
    full_name: full,
    private: r.visibility !== 'public',
    visibility: r.visibility,
    owner: { login: access.ownerName, type: access.ownerKind === 'organization' ? 'Organization' : 'User' },
    html_url: `${base()}/${full}`,
    description: r.description,
    default_branch: r.defaultBranch,
    archived: r.isArchived,
    clone_url: `${base()}/${full}.git`,
    url: `${apiBase()}/repos/${full}`,
    permissions: {
      admin: access.level === 'admin',
      maintain: ['maintain', 'admin'].includes(access.level),
      push: canWrite(access),
      triage: canWrite(access),
      pull: true,
    },
  };
}

function assetJson(access: ResolvedAccess, release: ReleaseRow, asset: AssetRow) {
  const full = `${access.ownerName}/${access.repository.name}`;
  return {
    id: asset.id,
    name: asset.name,
    label: asset.label ?? '',
    content_type: asset.contentType ?? 'application/octet-stream',
    state: 'uploaded',
    size: asset.sizeBytes,
    download_count: asset.downloadCount,
    created_at: asset.createdAt.toISOString(),
    updated_at: asset.createdAt.toISOString(),
    url: `${apiBase()}/repos/${full}/releases/assets/${asset.id}`,
    browser_download_url: `${base()}/${full}/releases/download/${encodeURIComponent(release.tagName)}/${encodeURIComponent(asset.name)}`,
  };
}

function releaseJson(access: ResolvedAccess, release: ReleaseRow, assets: AssetRow[]) {
  const full = `${access.ownerName}/${access.repository.name}`;
  return {
    id: release.id,
    tag_name: release.tagName,
    target_commitish: release.targetCommitish ?? access.repository.defaultBranch,
    name: release.name ?? release.tagName,
    body: release.body ?? '',
    draft: release.isDraft,
    prerelease: release.isPrerelease,
    created_at: release.createdAt.toISOString(),
    published_at: release.publishedAt?.toISOString() ?? null,
    html_url: `${base()}/${full}/releases#${encodeURIComponent(release.tagName)}`,
    url: `${apiBase()}/repos/${full}/releases/${release.id}`,
    assets_url: `${apiBase()}/repos/${full}/releases/${release.id}/assets`,
    upload_url: `${base()}/api/uploads/repos/${full}/releases/${release.id}/assets{?name,label}`,
    tarball_url: `${base()}/api/v1/repos/${full}/archive/${encodeURIComponent(release.tagName)}?format=tar.gz`,
    zipball_url: `${base()}/api/v1/repos/${full}/archive/${encodeURIComponent(release.tagName)}?format=zip`,
    assets: assets.map((a) => assetJson(access, release, a)),
  };
}

async function assetsOf(releaseId: string) {
  return db.select().from(releaseAssets).where(eq(releaseAssets.releaseId, releaseId)).orderBy(releaseAssets.createdAt);
}

/** Alle sichtbaren Releases, neueste zuerst (wie GitHub). */
async function listReleases(access: ResolvedAccess, limit: number, offset = 0) {
  return db
    .select()
    .from(releases)
    .where(and(eq(releases.repositoryId, access.repository.id), canWrite(access) ? sql`1 = 1` : eq(releases.isDraft, false)))
    .orderBy(desc(sql`coalesce(${releases.publishedAt}, ${releases.createdAt})`))
    .limit(limit)
    .offset(offset);
}

/** "Latest" wie bei GitHub: das zuletzt veröffentlichte Release, das weder Entwurf noch Vorabversion ist. */
async function latestRelease(access: ResolvedAccess) {
  const rows = await db
    .select()
    .from(releases)
    .where(and(eq(releases.repositoryId, access.repository.id), eq(releases.isDraft, false), eq(releases.isPrerelease, false)))
    .orderBy(desc(releases.publishedAt), desc(releases.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

async function releaseByTag(access: ResolvedAccess, tag: string) {
  const rows = await db
    .select()
    .from(releases)
    .where(and(eq(releases.repositoryId, access.repository.id), eq(releases.tagName, tag)))
    .limit(1);
  const r = rows[0];
  if (!r || (r.isDraft && !canWrite(access))) return null;
  return r;
}

async function releaseById(access: ResolvedAccess, id: string) {
  const rows = await db
    .select()
    .from(releases)
    .where(and(eq(releases.repositoryId, access.repository.id), eq(releases.id, id)))
    .limit(1);
  const r = rows[0];
  if (!r || (r.isDraft && !canWrite(access))) return null;
  return r;
}

/** Lädt das Repository; private Repositories erscheinen für Unberechtigte als 404 (wie bei GitHub). */
async function access(request: FastifyRequest<{ Params: RepoParams }>, level: 'read' | 'write' = 'read') {
  return requireRepositoryAccess(request.params.owner, request.params.repo.replace(/\.git$/, ''), request.viewer, level);
}

/** Datei ausliefern und den Zähler erhöhen. */
async function sendAsset(reply: FastifyReply, asset: AssetRow, head = false) {
  if (!head) {
    await db
      .update(releaseAssets)
      .set({ downloadCount: sql`${releaseAssets.downloadCount} + 1` })
      .where(eq(releaseAssets.id, asset.id));
  }
  reply
    .header('Content-Type', 'application/octet-stream')
    .header('Content-Length', String(asset.sizeBytes))
    .header('Content-Disposition', `attachment; filename="${safeFilename(asset.name)}"`)
    .header('Cache-Control', 'no-cache')
    .header('X-Content-Type-Options', 'nosniff')
    // Downloads dürfen von überall eingebunden werden (Website, Launcher).
    .header('Cross-Origin-Resource-Policy', 'cross-origin');
  if (head) return reply.send();
  return reply.send(createReadStream(objectPath(asset.storageKey)));
}

function escXml(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/** Version-Tags wie v1.2.3 oder 1.2.3-beta.1 – nur die stehen im Feed (siehe releasesAtom). */
const VERSION_TAG = /^v?\d+\.\d+(\.\d+)?([-+].*)?$/;

export async function registerGithubCompatRoutes(parent: FastifyInstance): Promise<void> {
  // Eigener Kontext: Fehler erscheinen hier im GitHub-Format ({ message }), damit
  // GitHub-Clients sie verstehen. Der Rest der API behält sein eigenes Format.
  await parent.register(async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return ghError(reply, error.statusCode, error.message);
    if (error instanceof z.ZodError) return ghError(reply, 422, 'Validation Failed');
    if ((error as { statusCode?: number }).statusCode === 429) return ghError(reply, 429, 'API rate limit exceeded');
    _request.log.error({ err: error }, 'Fehler in der GitHub-kompatiblen API');
    return ghError(reply, 500, 'Server Error');
  });

  const requireUser = (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.viewer) {
      ghError(reply, 401, 'Requires authentication');
      return false;
    }
    return true;
  };

  // -------------------------------------------------------------------------
  // Konto und Repository
  // -------------------------------------------------------------------------
  app.get('/api/v3', async () => ({
    current_user_url: `${apiBase()}/user`,
    repository_url: `${apiBase()}/repos/{owner}/{repo}`,
  }));

  app.get('/api/v3/user', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const v = request.viewer!;
    return { login: v.username, id: v.id, name: v.displayName ?? v.username, email: v.email, type: 'User', site_admin: v.isAdmin, html_url: `${base()}/${v.username}` };
  });

  app.get<{ Params: RepoParams }>('/api/v3/repos/:owner/:repo', async (request) => repoJson(await access(request)));

  // -------------------------------------------------------------------------
  // Releases lesen
  // -------------------------------------------------------------------------
  app.get<{ Params: RepoParams; Querystring: { per_page?: string; page?: string } }>(
    '/api/v3/repos/:owner/:repo/releases',
    async (request) => {
      const a = await access(request);
      const perPage = Math.min(Math.max(Number(request.query.per_page) || 30, 1), 100);
      const page = Math.max(Number(request.query.page) || 1, 1);
      const rows = await listReleases(a, perPage, (page - 1) * perPage);
      return Promise.all(rows.map(async (r) => releaseJson(a, r, await assetsOf(r.id))));
    },
  );

  app.get<{ Params: RepoParams }>(
    '/api/v3/repos/:owner/:repo/releases/latest',
    async (request, reply) => {
      const a = await access(request);
      const r = await latestRelease(a);
      if (!r) return ghError(reply, 404, 'Not Found');
      return releaseJson(a, r, await assetsOf(r.id));
    },
  );

  app.get<{ Params: RepoParams & { tag: string } }>(
    '/api/v3/repos/:owner/:repo/releases/tags/:tag',
    async (request, reply) => {
      const a = await access(request);
      const r = await releaseByTag(a, request.params.tag);
      if (!r) return ghError(reply, 404, 'Not Found');
      return releaseJson(a, r, await assetsOf(r.id));
    },
  );

  app.get<{ Params: RepoParams & { id: string } }>(
    '/api/v3/repos/:owner/:repo/releases/:id',
    async (request, reply) => {
      const a = await access(request);
      const r = await releaseById(a, request.params.id);
      if (!r) return ghError(reply, 404, 'Not Found');
      return releaseJson(a, r, await assetsOf(r.id));
    },
  );

  app.get<{ Params: RepoParams & { id: string } }>(
    '/api/v3/repos/:owner/:repo/releases/:id/assets',
    async (request, reply) => {
      const a = await access(request);
      const r = await releaseById(a, request.params.id);
      if (!r) return ghError(reply, 404, 'Not Found');
      return (await assetsOf(r.id)).map((x) => assetJson(a, r, x));
    },
  );

  // -------------------------------------------------------------------------
  // Releases anlegen, ändern, löschen
  // -------------------------------------------------------------------------
  app.post<{ Params: RepoParams }>(
    '/api/v3/repos/:owner/:repo/releases',
    async (request, reply) => {
      if (!requireUser(request, reply)) return reply;
      const input = z
        .object({
          tag_name: z.string().min(1).max(255),
          target_commitish: z.string().max(255).nullish(),
          name: z.string().max(255).nullish(),
          body: z.string().max(100_000).nullish(),
          draft: z.boolean().default(false),
          prerelease: z.boolean().default(false),
          make_latest: z.union([z.string(), z.boolean()]).nullish(),
        })
        .parse(request.body ?? {});
      const a = await access(request, 'write');
      if (!a.repository.hasReleases) throw notFound('Releases sind in diesem Repository deaktiviert.');

      // Wie GitHub: Gibt es das Tag noch nicht, wird es auf target_commitish (Standard: Hauptzweig) gesetzt.
      const target = input.target_commitish || a.repository.defaultBranch;
      if (!(await resolveRef(a.repository.id, input.tag_name))) {
        const oid = await resolveRef(a.repository.id, target);
        if (!oid) throw validationFailed(`Das Ziel "${target}" existiert nicht (leeres Repository?).`);
        const res = await runGit(['tag', '--', input.tag_name, oid], { cwd: repositoryPath(a.repository.id), allowFailure: true });
        if (res.exitCode !== 0) throw validationFailed(`Das Tag konnte nicht angelegt werden: ${res.stderr}`);
      }

      try {
        const [created] = await db
          .insert(releases)
          .values({
            repositoryId: a.repository.id,
            tagName: input.tag_name,
            targetCommitish: target,
            name: input.name?.trim() || null,
            body: input.body ?? null,
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
          repositoryId: a.repository.id,
          metadata: { tagName: input.tag_name, via: 'github-compat' },
        });
        if (!input.draft) {
          void dispatchWebhook({
            event: 'release',
            repositoryId: a.repository.id,
            payload: { action: 'published', release: { tagName: created!.tagName, name: created!.name } },
          });
        }
        reply.code(201);
        return releaseJson(a, created!, []);
      } catch (error) {
        if (isUniqueViolation(error, 'releases_repo_tag_key', 'releases.tag_name')) {
          return reply.code(422).send({ message: 'Validation Failed', errors: [{ resource: 'Release', code: 'already_exists', field: 'tag_name' }] });
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: RepoParams & { id: string } }>(
    '/api/v3/repos/:owner/:repo/releases/:id',
    async (request, reply) => {
      if (!requireUser(request, reply)) return reply;
      const input = z
        .object({
          tag_name: z.string().min(1).max(255).optional(),
          name: z.string().max(255).nullish(),
          body: z.string().max(100_000).nullish(),
          draft: z.boolean().optional(),
          prerelease: z.boolean().optional(),
          make_latest: z.union([z.string(), z.boolean()]).nullish(),
        })
        .parse(request.body ?? {});
      const a = await access(request, 'write');
      const r = await releaseById(a, request.params.id);
      if (!r) return ghError(reply, 404, 'Not Found');

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name?.trim() || null;
      if (input.body !== undefined) patch.body = input.body ?? null;
      if (input.prerelease !== undefined) patch.isPrerelease = input.prerelease;
      if (input.draft !== undefined) patch.isDraft = input.draft;
      if (input.tag_name && input.tag_name !== r.tagName) throw validationFailed('Das Tag eines Releases lässt sich hier nicht umbenennen.');
      const wirdOeffentlich = (input.draft === false && r.isDraft) || (input.prerelease === false && r.isPrerelease);
      // "Latest" ist bei Forge das zuletzt veröffentlichte stabile Release. Freigeben oder
      // make_latest=true setzt deshalb den Zeitpunkt neu, damit es danach wirklich "latest" ist.
      if (wirdOeffentlich || String(input.make_latest) === 'true' || !r.publishedAt) {
        if ((input.draft ?? r.isDraft) === false) patch.publishedAt = new Date();
      }
      await db.update(releases).set(patch).where(eq(releases.id, r.id));
      const fresh = (await releaseById(a, r.id))!;
      return releaseJson(a, fresh, await assetsOf(r.id));
    },
  );

  app.delete<{ Params: RepoParams & { id: string } }>(
    '/api/v3/repos/:owner/:repo/releases/:id',
    async (request, reply) => {
      if (!requireUser(request, reply)) return reply;
      const a = await access(request, 'write');
      const r = await releaseById(a, request.params.id);
      if (!r) return ghError(reply, 404, 'Not Found');
      for (const asset of await assetsOf(r.id)) await deleteObject(asset.storageKey);
      await db.delete(releases).where(eq(releases.id, r.id));
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Dateien (Assets)
  // -------------------------------------------------------------------------
  async function assetWithRelease(a: ResolvedAccess, assetId: string) {
    const rows = await db
      .select({ asset: releaseAssets, release: releases })
      .from(releaseAssets)
      .innerJoin(releases, eq(releases.id, releaseAssets.releaseId))
      .where(and(eq(releaseAssets.id, assetId), eq(releases.repositoryId, a.repository.id)))
      .limit(1);
    const row = rows[0];
    if (!row || (row.release.isDraft && !canWrite(a))) return null;
    return row;
  }

  app.get<{ Params: RepoParams & { assetId: string } }>(
    '/api/v3/repos/:owner/:repo/releases/assets/:assetId',
    async (request, reply) => {
      const a = await access(request);
      const row = await assetWithRelease(a, request.params.assetId);
      if (!row) return ghError(reply, 404, 'Not Found');
      // Wie GitHub: mit "Accept: application/octet-stream" kommt die Datei, sonst die Beschreibung.
      if (String(request.headers.accept ?? '').includes('application/octet-stream')) return sendAsset(reply, row.asset);
      return assetJson(a, row.release, row.asset);
    },
  );

  app.delete<{ Params: RepoParams & { assetId: string } }>(
    '/api/v3/repos/:owner/:repo/releases/assets/:assetId',
    async (request, reply) => {
      if (!requireUser(request, reply)) return reply;
      const a = await access(request, 'write');
      const row = await assetWithRelease(a, request.params.assetId);
      if (!row) return ghError(reply, 404, 'Not Found');
      await deleteObject(row.asset.storageKey);
      await db.delete(releaseAssets).where(eq(releaseAssets.id, row.asset.id));
      return reply.code(204).send();
    },
  );

  // Hochladen: der Body ist die rohe Datei (beliebiger Content-Type). In einem eigenen
  // Kontext, damit kein Parser (z. B. JSON für manifest.json) den Strom vorher liest.
  await app.register(async (upload) => {
    upload.removeAllContentTypeParsers();
    upload.addContentTypeParser('*', (_request, payload, done) => done(null, payload));

    const handler = async (
      request: FastifyRequest<{ Params: RepoParams & { id: string }; Querystring: { name?: string; label?: string } }>,
      reply: FastifyReply,
    ) => {
        if (!requireUser(request, reply)) return reply;
        const a = await access(request, 'write');
        const r = await releaseById(a, request.params.id);
        if (!r) return ghError(reply, 404, 'Not Found');
        const name = safeFilename(String(request.query.name ?? '').trim());
        if (!name || name === 'download') return reply.code(422).send({ message: 'Validation Failed', errors: [{ field: 'name', code: 'missing' }] });

        const stored = await storeStream('release-assets', request.raw, MAX_ASSET_BYTES);
        try {
          const [asset] = await db
            .insert(releaseAssets)
            .values({
              releaseId: r.id,
              name,
              label: request.query.label ? String(request.query.label).slice(0, 255) : null,
              storageKey: stored.storageKey,
              contentType: String(request.headers['content-type'] ?? 'application/octet-stream').slice(0, 128),
              sizeBytes: stored.sizeBytes,
              sha256: stored.sha256,
              uploadedById: request.viewer!.id,
            })
            .returning();
          reply.code(201);
          return assetJson(a, r, asset!);
        } catch (error) {
          await deleteObject(stored.storageKey);
          if (isUniqueViolation(error, 'release_assets_release_name_key', 'release_assets.name')) {
            return reply.code(422).send({ message: 'Validation Failed', errors: [{ resource: 'ReleaseAsset', code: 'already_exists', field: 'name' }] });
          }
          throw error;
        }
    };
    upload.post<{ Params: RepoParams & { id: string }; Querystring: { name?: string; label?: string } }>('/api/uploads/repos/:owner/:repo/releases/:id/assets', handler);
    upload.post<{ Params: RepoParams & { id: string }; Querystring: { name?: string; label?: string } }>('/api/v3/repos/:owner/:repo/releases/:id/assets', handler);
  });

  // -------------------------------------------------------------------------
  // Öffentliche Download-Adressen wie auf github.com
  // -------------------------------------------------------------------------
  const download = async (
    request: FastifyRequest<{ Params: RepoParams & { tag?: string; file: string } }>,
    reply: FastifyReply,
  ) => {
    const a = await access(request).catch(() => null);
    if (!a) return reply.code(404).send('Not Found');
    const r = request.params.tag ? await releaseByTag(a, request.params.tag) : await latestRelease(a);
    if (!r) return reply.code(404).send('Not Found');
    const asset = (await assetsOf(r.id)).find((x) => x.name === request.params.file);
    if (!asset) return reply.code(404).send('Not Found');
    return sendAsset(reply, asset, request.method === 'HEAD');
  };
  type DL = { Params: RepoParams & { tag?: string; file: string } };
  // HEAD legt Fastify zu jeder GET-Route selbst an (exposeHeadRoutes).
  app.get<DL>('/:owner/:repo/releases/download/:tag/:file', download);
  app.get<DL>('/:owner/:repo/releases/latest/download/:file', download);

  // Atom-Feed der Releases (electron-updater liest daraus die Versionen).
  // Nur Versions-Tags: ein Sammel-Release wie "vortex-files" ist kein Programm-Update.
  app.get<{ Params: RepoParams }>('/:owner/:repo/releases.atom', async (request, reply) => {
    const a = await access(request).catch(() => null);
    if (!a) return reply.code(404).send('Not Found');
    const rows = (await listReleases(a, 60)).filter((r) => !r.isDraft && VERSION_TAG.test(r.tagName));
    const full = `${a.ownerName}/${a.repository.name}`;
    const entries = rows
      .map((r) => {
        const link = `${base()}/${full}/releases/tag/${encodeURIComponent(r.tagName)}`;
        const updated = (r.publishedAt ?? r.createdAt).toISOString();
        return `  <entry>
    <id>tag:${escXml(new URL(base()).host)},2008:Repository/${escXml(a.repository.id)}/${escXml(r.tagName)}</id>
    <updated>${updated}</updated>
    <link rel="alternate" type="text/html" href="${escXml(link)}"/>
    <title>${escXml(r.name ?? r.tagName)}</title>
    <content type="html">${escXml(r.body ?? '')}</content>
    <author><name>${escXml(a.ownerName)}</name></author>
  </entry>`;
      })
      .join('\n');
    reply.header('Content-Type', 'application/atom+xml; charset=utf-8').header('Cache-Control', 'no-cache');
    return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <id>tag:${escXml(new URL(base()).host)},2008:${escXml(full)}/releases</id>
  <link type="text/html" rel="alternate" href="${escXml(`${base()}/${full}/releases`)}"/>
  <link type="application/atom+xml" rel="self" href="${escXml(`${base()}/${full}/releases.atom`)}"/>
  <title>Release notes from ${escXml(a.repository.name)}</title>
  <updated>${(rows[0]?.publishedAt ?? new Date()).toISOString()}</updated>
${entries}
</feed>
`;
  });

  // Alles andere unter /api/v3 gibt es nicht – klar im GitHub-Format sagen.

  // -------------------------------------------------------------------------
  // Issues (nur Liste und Anlegen – genug für Fehlerberichte aus dem Launcher)
  // -------------------------------------------------------------------------
  const issueJson = (full: string, row: typeof issues.$inferSelect) => ({
    id: row.number,
    number: row.number,
    title: row.title,
    body: row.body ?? '',
    state: row.state === 'closed' ? 'closed' : 'open',
    comments: row.commentCount,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    closed_at: row.closedAt ? row.closedAt.toISOString() : null,
    html_url: `${base()}/${full}/issues/${row.number}`,
    url: `${apiBase()}/repos/${full}/issues/${row.number}`,
  });

  app.get<{ Params: RepoParams; Querystring: { state?: string; per_page?: string; page?: string; direction?: string } }>(
    '/api/v3/repos/:owner/:repo/issues',
    async (request, reply) => {
      const a = await access(request);
      if (!a.repository.hasIssues) return ghError(reply, 410, 'Issues are disabled for this repo');
      const perPage = Math.min(Math.max(Number(request.query.per_page) || 30, 1), 100);
      const page = Math.max(Number(request.query.page) || 1, 1);
      const state = request.query.state === 'all' || request.query.state === 'closed' ? request.query.state : 'open';
      const conditions = [eq(issues.repositoryId, a.repository.id), eq(issues.kind, 'issue')];
      if (state !== 'all') conditions.push(eq(issues.state, state));
      const rows = await db
        .select()
        .from(issues)
        .where(and(...conditions))
        .orderBy(request.query.direction === 'asc' ? issues.createdAt : desc(issues.createdAt))
        .limit(perPage)
        .offset((page - 1) * perPage);
      const full = `${a.ownerName}/${a.repository.name}`;
      return rows.map((row) => issueJson(full, row));
    },
  );

  app.post<{ Params: RepoParams }>('/api/v3/repos/:owner/:repo/issues', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const input = z
      .object({ title: z.string().min(1).max(500), body: z.string().max(100_000).nullish() })
      .parse(request.body);
    // Wie bei GitHub: anlegen darf jeder mit Lesezugriff.
    const a = await access(request);
    if (!a.repository.hasIssues) return ghError(reply, 410, 'Issues are disabled for this repo');
    if (a.repository.isArchived) return ghError(reply, 403, 'Repository was archived so is read-only.');
    const created = await createIssue(
      a.repository.id,
      { title: input.title, body: input.body ?? null },
      request.viewer!.id,
      'issue',
    );
    const full = `${a.ownerName}/${a.repository.name}`;
    await notifyIssueActivity({
      issueId: created.id,
      repositoryId: a.repository.id,
      repositoryFullName: full,
      actorId: request.viewer!.id,
      title: `${full}#${created.number}: ${created.title}`,
      kind: 'opened',
      mentionSource: input.body ?? undefined,
    }).catch((error) => request.log.error({ err: error }, 'Benachrichtigung fehlgeschlagen'));
    reply.code(201);
    return issueJson(full, created);
  });


  // -------------------------------------------------------------------------
  // Rohdateien wie raw.githubusercontent.com: <forge>/<owner>/<repo>/raw/<ref>/<pfad>
  // (z. B. Menü-Panoramen und cosmetics.json, die der Client direkt lädt)
  // -------------------------------------------------------------------------
  app.get<{ Params: RepoParams & { ref: string; '*': string } }>(
    '/:owner/:repo/raw/:ref/*',
    async (request, reply) => {
      const a = await access(request);
      const path = request.params['*'] ?? '';
      if (!path || path.split('/').some((part) => part === '..')) return ghError(reply, 404, 'Not Found');
      let buffer: Buffer;
      try {
        ({ buffer } = await readBlobRaw(a.repository.id, request.params.ref, path));
      } catch {
        return ghError(reply, 404, 'Not Found');
      }
      const filename = path.split('/').pop() ?? 'download';
      // Wie bei der API-Rohdatei: nie inline als HTML, damit hochgeladene Dateien
      // kein Skript im Kontext der Plattform ausführen können.
      return reply
        .header('Content-Type', /\.json$/i.test(filename) ? 'application/json; charset=utf-8'
          : /\.png$/i.test(filename) ? 'image/png'
          : /\.jpe?g$/i.test(filename) ? 'image/jpeg'
          : 'application/octet-stream')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cache-Control', 'public, max-age=300')
        .header('Cross-Origin-Resource-Policy', 'cross-origin')
        .send(buffer);
    },
  );

  app.all('/api/v3/*', async (_request, reply) => ghError(reply, 404, 'Not Found'));
  });
}

export const githubCompatInternals = { VERSION_TAG };
