/**
 * Lesende und schreibende Endpunkte für Git-Inhalte:
 * Dateibaum, Dateien, Commits, Branches, Tags, Diffs, Blame.
 *
 * Alle Routen gehen über `requireRepositoryAccess`, sodass private
 * Repository-Inhalte nicht erreichbar sind.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import type { TreeEntry } from '@forge/shared';
import { db } from '../db/index.js';
import { branchProtections, namespaces, users } from '../db/schema.js';
import { notFound, validationFailed } from '../lib/errors.js';
import { requireRepositoryAccess } from '../services/permissions.js';
import { syncRepositoryMetadata } from '../services/repository-metadata.js';
import {
  aheadBehind,
  blameFile,
  checkMergeable,
  commitFileChange,
  commitsBetween,
  countCommits,
  createBranch,
  deleteBranch,
  getCommit,
  getDiff,
  listBranches,
  listCommits,
  listTags,
  listTree,
  attachLastCommits,
  readBlob,
  readBlobRaw,
  resolveRef,
} from '../git/repository.js';
import { GitError } from '../git/exec.js';

/**
 * Ref und Pfad kommen aus der URL. Da ein Branch-Name selbst Schrägstriche
 * enthalten darf (`feature/login`), lässt sich `:ref/:path` nicht eindeutig
 * zerlegen. Deshalb wird der Ref als Query-Parameter übergeben und der Pfad
 * als Wildcard – das ist eindeutig und spart Rateheuristik.
 */
const refQuery = z.object({ ref: z.string().min(1).max(255).optional() });

export async function registerGitDataRoutes(app: FastifyInstance): Promise<void> {
  /** Löst den zu verwendenden Ref auf: expliziter Wert oder Default-Branch. */
  async function resolveTargetRef(
    repositoryId: string,
    defaultBranch: string,
    requested: string | undefined,
  ): Promise<string> {
    const ref = requested ?? defaultBranch;
    const oid = await resolveRef(repositoryId, ref);
    if (!oid) throw notFound(`Die Referenz "${ref}" existiert in diesem Repository nicht.`);
    return ref;
  }

  /** Ergänzt Git-Signaturen um den zugehörigen Plattform-Account. */
  async function linkUsers<T extends { author: { email: string; user: unknown } }>(
    items: T[],
  ): Promise<T[]> {
    const emails = [...new Set(items.map((i) => i.author.email.toLowerCase()))];
    if (emails.length === 0) return items;

    const rows = await db
      .select({
        id: users.id,
        emailLower: users.emailLower,
        username: namespaces.name,
        displayName: users.displayName,
        avatarPath: users.avatarPath,
      })
      .from(users)
      .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
      .where(inArray(users.emailLower, emails));

    const byEmail = new Map(rows.map((r) => [r.emailLower, r]));

    return items.map((item) => {
      const match = byEmail.get(item.author.email.toLowerCase());
      if (!match) return item;
      return {
        ...item,
        author: {
          ...item.author,
          user: {
            id: match.id,
            username: match.username,
            displayName: match.displayName,
            avatarUrl: null,
          },
        },
      };
    });
  }

  // -- Dateibaum ------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string; '*': string } }>(
    '/api/v1/repos/:owner/:repo/tree/*',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const query = refQuery
        .extend({ withLastCommit: z.coerce.boolean().default(true) })
        .parse(request.query);

      if (access.repository.isEmpty) {
        return { ref: access.repository.defaultBranch, path: '', entries: [] as TreeEntry[] };
      }

      const ref = await resolveTargetRef(
        access.repository.id,
        access.repository.defaultBranch,
        query.ref,
      );
      const path = request.params['*'] ?? '';

      let entries = await listTree(access.repository.id, ref, path);

      // Der letzte Commit je Eintrag ist teuer; bei sehr großen
      // Verzeichnissen wird er weggelassen, damit die Seite schnell bleibt.
      if (query.withLastCommit && entries.length <= 150) {
        entries = await attachLastCommits(access.repository.id, ref, entries);
      }

      return { ref, path, entries };
    },
  );

  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/tree',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const query = refQuery.parse(request.query);

      if (access.repository.isEmpty) {
        return { ref: access.repository.defaultBranch, path: '', entries: [] as TreeEntry[] };
      }

      const ref = await resolveTargetRef(
        access.repository.id,
        access.repository.defaultBranch,
        query.ref,
      );
      let entries = await listTree(access.repository.id, ref, '');
      if (entries.length <= 150) {
        entries = await attachLastCommits(access.repository.id, ref, entries);
      }
      return { ref, path: '', entries };
    },
  );

  // -- Dateiinhalt ----------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string; '*': string } }>(
    '/api/v1/repos/:owner/:repo/blob/*',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const query = refQuery.parse(request.query);
      const ref = await resolveTargetRef(
        access.repository.id,
        access.repository.defaultBranch,
        query.ref,
      );

      const blob = await readBlob(access.repository.id, ref, request.params['*'] ?? '');
      return { ref, ...blob };
    },
  );

  // -- Rohdatei (Download) --------------------------------------------------
  app.get<{ Params: { owner: string; repo: string; '*': string } }>(
    '/api/v1/repos/:owner/:repo/raw/*',
    async (request, reply) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const query = refQuery.parse(request.query);
      const ref = await resolveTargetRef(
        access.repository.id,
        access.repository.defaultBranch,
        query.ref,
      );

      const path = request.params['*'] ?? '';
      const { buffer } = await readBlobRaw(access.repository.id, ref, path);

      const filename = path.split('/').pop() ?? 'download';

      // Immer als Anhang und mit octet-stream ausliefern. Würde die Datei mit
      // ihrem echten Typ inline dargestellt, ließe sich über eine hochgeladene
      // HTML-Datei Javascript im Kontext der Plattform ausführen.
      reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${filename.replace(/["\\]/g, '')}"`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox");

      return reply.send(buffer);
    },
  );

  // -- Branches -------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/branches',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      if (access.repository.isEmpty) return { items: [] };

      const branches = await listBranches(
        access.repository.id,
        access.repository.defaultBranch,
      );

      const protections = await db
        .select({ pattern: branchProtections.pattern })
        .from(branchProtections)
        .where(eq(branchProtections.repositoryId, access.repository.id));

      const withMeta = await Promise.all(
        branches.slice(0, 100).map(async (branch) => ({
          ...branch,
          isProtected: protections.some((p) => matchesPattern(branch.name, p.pattern)),
          aheadBehind:
            branch.isDefault
              ? { ahead: 0, behind: 0 }
              : await aheadBehind(
                  access.repository.id,
                  branch.name,
                  access.repository.defaultBranch,
                ),
        })),
      );

      return { items: withMeta, totalCount: branches.length };
    },
  );

  app.post<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/branches',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({ name: z.string().min(1).max(255), from: z.string().min(1).max(255) })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );

      try {
        await createBranch(access.repository.id, input.name, input.from);
      } catch (error) {
        if (error instanceof GitError) {
          throw validationFailed(`Der Branch konnte nicht erstellt werden: ${error.stderr || error.message}`);
        }
        throw error;
      }

      reply.code(201);
      return { ok: true, name: input.name };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; '*': string } }>(
    '/api/v1/repos/:owner/:repo/branches/*',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );

      const name = request.params['*'] ?? '';

      if (name === access.repository.defaultBranch) {
        throw validationFailed('Der Default-Branch kann nicht gelöscht werden.');
      }

      const protections = await db
        .select({ pattern: branchProtections.pattern, blockDeletion: branchProtections.blockDeletion })
        .from(branchProtections)
        .where(eq(branchProtections.repositoryId, access.repository.id));

      if (protections.some((p) => p.blockDeletion && matchesPattern(name, p.pattern))) {
        throw validationFailed('Dieser Branch ist geschützt und kann nicht gelöscht werden.');
      }

      await deleteBranch(access.repository.id, name);
      return { ok: true };
    },
  );

  // -- Tags -----------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/tags',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      if (access.repository.isEmpty) return { items: [] };
      return { items: await listTags(access.repository.id) };
    },
  );

  // -- Commits --------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/commits',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      if (access.repository.isEmpty) return { items: [], totalCount: 0, ref: null };

      const query = refQuery
        .extend({
          path: z.string().max(1000).optional(),
          author: z.string().max(320).optional(),
          search: z.string().max(200).optional(),
          page: z.coerce.number().int().min(1).default(1),
          perPage: z.coerce.number().int().min(1).max(100).default(30),
        })
        .parse(request.query);

      const ref = await resolveTargetRef(
        access.repository.id,
        access.repository.defaultBranch,
        query.ref,
      );

      const commits = await listCommits(access.repository.id, {
        ref,
        path: query.path,
        author: query.author,
        search: query.search,
        limit: query.perPage,
        skip: (query.page - 1) * query.perPage,
      });

      const totalCount = await countCommits(access.repository.id, ref, query.path);

      return { items: await linkUsers(commits), totalCount, ref };
    },
  );

  app.get<{ Params: { owner: string; repo: string; oid: string } }>(
    '/api/v1/repos/:owner/:repo/commits/:oid',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      try {
        const commit = await getCommit(access.repository.id, request.params.oid);
        const [linked] = await linkUsers([commit]);
        return linked;
      } catch (error) {
        if (error instanceof GitError) throw notFound('Commit nicht gefunden.');
        throw error;
      }
    },
  );

  // -- Vergleich zweier Refs ------------------------------------------------
  app.get<{ Params: { owner: string; repo: string; base: string; head: string } }>(
    '/api/v1/repos/:owner/:repo/compare/:base...:head',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      const { base, head } = request.params;

      const [baseOid, headOid] = await Promise.all([
        resolveRef(access.repository.id, base),
        resolveRef(access.repository.id, head),
      ]);
      if (!baseOid || !headOid) throw notFound('Basis oder Head nicht gefunden.');

      const [diff, commits, merge] = await Promise.all([
        getDiff(access.repository.id, base, head),
        commitsBetween(access.repository.id, base, head),
        checkMergeable(access.repository.id, base, head),
      ]);

      return {
        base,
        head,
        baseOid,
        headOid,
        commits: await linkUsers(commits),
        files: diff.files,
        stats: diff.stats,
        mergeable: merge.mergeable,
        conflictingFiles: merge.conflictingFiles,
      };
    },
  );

  // -- Blame ----------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string; '*': string } }>(
    '/api/v1/repos/:owner/:repo/blame/*',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );
      const query = refQuery.parse(request.query);
      const ref = await resolveTargetRef(
        access.repository.id,
        access.repository.defaultBranch,
        query.ref,
      );

      const lines = await blameFile(access.repository.id, ref, request.params['*'] ?? '');
      return { ref, lines };
    },
  );

  // -- Datei anlegen, ändern, löschen --------------------------------------
  const fileWriteSchema = z.object({
    branch: z.string().min(1).max(255),
    message: z.string().min(1).max(2000),
    /** Base64, damit auch Binärinhalte übertragen werden können. */
    contentBase64: z.string().nullable(),
    newPath: z.string().max(1000).optional(),
    /** Stand, auf dem die Änderung basiert. Verhindert stilles Überschreiben. */
    expectedOid: z.string().length(40).nullish(),
  });

  app.put<{ Params: { owner: string; repo: string; '*': string } }>(
    '/api/v1/repos/:owner/:repo/contents/*',
    async (request) => {
      app.requireAuth(request);
      const input = fileWriteSchema.parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );

      const protections = await db
        .select()
        .from(branchProtections)
        .where(eq(branchProtections.repositoryId, access.repository.id));

      const protection = protections.find((p) => matchesPattern(input.branch, p.pattern));
      if (protection?.requirePullRequest) {
        throw validationFailed(
          `Der Branch "${input.branch}" ist geschützt. Änderungen müssen über einen Pull Request erfolgen.`,
        );
      }

      try {
        const oid = await commitFileChange(access.repository.id, {
          branch: input.branch,
          path: request.params['*'] ?? '',
          content: input.contentBase64 === null ? null : Buffer.from(input.contentBase64, 'base64'),
          message: input.message,
          author: { name: request.viewer!.username, email: request.viewer!.email },
          expectedOid: input.expectedOid ?? undefined,
          newPath: input.newPath,
        });

        await syncRepositoryMetadata(access.repository.id).catch(() => {});

        return { ok: true, commitOid: oid };
      } catch (error) {
        if (error instanceof GitError) {
          throw validationFailed(error.message);
        }
        throw error;
      }
    },
  );
}

/**
 * Prüft einen Branch-Namen gegen ein Schutzmuster.
 * Unterstützt `*` für ein beliebiges Segment und `**` für mehrere.
 */
function matchesPattern(name: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}
