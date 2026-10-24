/**
 * Gists: kleine Code-Schnipsel mit echter Git-Historie.
 *
 * Ein Gist ist ein eigenes bare-Repository. Das klingt nach viel für drei
 * Zeilen Code, bringt aber Versionierung, Diffs und `git clone` ohne zweite
 * Speicherform – und die Werkzeuge dafür stehen bereits.
 *
 * Sichtbarkeit: ein Gist ist entweder öffentlich (erscheint in Listen) oder
 * nicht gelistet (nur über seine ID erreichbar). Es gibt bewusst keine
 * private Stufe, weil das eine Zugriffsprüfung verspräche, die ein per Link
 * geteilter Schnipsel nicht einlösen kann.
 */

import { randomUUID } from 'node:crypto';
import { access, mkdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { UserRef } from '@forge/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { gistStars, gists, namespaces, users } from '../db/schema.js';
import { runGit, runGitText } from '../git/exec.js';
import { detectLanguage } from '../lib/language.js';
import { forbidden, notFound, validationFailed } from '../lib/errors.js';
import { avatarUrl } from './avatars.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function gistPath(gistId: string): string {
  if (!UUID_PATTERN.test(gistId)) throw validationFailed('Ungültige Gist-ID.');

  const path = resolve(
    config.git.storageRoot,
    'gists',
    gistId.slice(0, 2),
    gistId.slice(2, 4),
    `${gistId}.git`,
  );

  const root = resolve(config.git.storageRoot);
  if (!path.startsWith(root + sep)) {
    throw new Error('Pfadauflösung hat das Storage-Verzeichnis verlassen.');
  }
  return path;
}

export interface GistFile {
  filename: string;
  content: string;
  language: string | null;
  sizeBytes: number;
}

export interface GistSummary {
  id: string;
  description: string | null;
  isPublic: boolean;
  owner: UserRef | null;
  primaryFilename: string | null;
  primaryLanguage: string | null;
  fileCount: number;
  starCount: number;
  viewerHasStarred: boolean;
  createdAt: string;
  updatedAt: string;
  cloneUrl: string;
}

export interface GistDetail extends GistSummary {
  files: GistFile[];
  viewerCanEdit: boolean;
}

/**
 * Prüft einen Dateinamen.
 *
 * Verzeichnisse sind nicht erlaubt: ein Gist ist flach, und ein Pfad wie
 * `a/../b` müsste sonst gesondert behandelt werden.
 */
function validateFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw validationFailed('Ein Dateiname fehlt.');
  if (trimmed.length > 255) throw validationFailed('Der Dateiname ist zu lang.');
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw validationFailed('Dateinamen in einem Gist dürfen keine Verzeichnisse enthalten.');
  }
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('\0')) {
    throw validationFailed('Ungültiger Dateiname.');
  }
  return trimmed;
}

async function gistRepositoryExists(gistId: string): Promise<boolean> {
  try {
    await access(join(gistPath(gistId), 'HEAD'), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Schreibt einen Satz Dateien als einen Commit.
 *
 * Nicht genannte Dateien verschwinden: der übergebene Satz ist der neue
 * Gesamtstand, nicht eine Ergänzung. Das entspricht der Bearbeitung eines
 * Gists in einem Formular, in dem alle Dateien sichtbar sind.
 */
async function commitFiles(
  gistId: string,
  files: { filename: string; content: string }[],
  author: { name: string; email: string },
  message: string,
): Promise<string> {
  const cwd = gistPath(gistId);

  const headResult = await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], {
    cwd,
    allowFailure: true,
  });
  const parentOid = headResult.exitCode === 0 ? headResult.stdout.toString('utf8').trim() : null;

  const indexFile = `${cwd}/index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const env = { GIT_INDEX_FILE: indexFile };

  try {
    // Immer vom leeren Baum ausgehen: so entfällt das Entfernen gelöschter
    // Dateien als Sonderfall.
    await runGit(['read-tree', '--empty'], { cwd, env });

    for (const file of files) {
      const blobOid = (
        await runGit(['hash-object', '-w', '--stdin'], {
          cwd,
          input: Buffer.from(file.content, 'utf8'),
        })
      ).stdout
        .toString('utf8')
        .trim();

      await runGit(
        ['update-index', '--add', '--cacheinfo', `100644,${blobOid},${file.filename}`],
        { cwd, env },
      );
    }

    const treeOid = (await runGitText(['write-tree'], { cwd, env })).trim();

    const commitArgs = ['commit-tree', treeOid, '-m', message];
    if (parentOid) commitArgs.push('-p', parentOid);

    const commitOid = (
      await runGitText(commitArgs, {
        cwd,
        env: {
          GIT_INDEX_FILE: indexFile,
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email,
        },
      })
    ).trim();

    await runGit(['update-ref', 'refs/heads/main', commitOid, parentOid ?? ''], { cwd });
    return commitOid;
  } finally {
    const { unlink } = await import('node:fs/promises');
    await unlink(indexFile).catch(() => {});
  }
}

export async function createGist(options: {
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  description: string | null;
  isPublic: boolean;
  files: { filename: string; content: string }[];
}): Promise<string> {
  if (options.files.length === 0) {
    throw validationFailed('Ein Gist braucht mindestens eine Datei.');
  }
  if (options.files.length > 50) {
    throw validationFailed('Ein Gist darf höchstens 50 Dateien enthalten.');
  }

  const files = options.files.map((file) => ({
    filename: validateFilename(file.filename),
    content: file.content,
  }));

  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.filename)) {
      throw validationFailed(`Der Dateiname "${file.filename}" kommt mehrfach vor.`);
    }
    seen.add(file.filename);
  }

  const gistId = randomUUID();
  const path = gistPath(gistId);

  await mkdir(path, { recursive: true });
  await runGit(['init', '--bare', '--initial-branch=main', path], { cwd: path });
  await runGit(['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: path });

  try {
    await commitFiles(
      gistId,
      files,
      { name: options.ownerName, email: options.ownerEmail },
      'Gist angelegt',
    );

    await db.insert(gists).values({
      id: gistId,
      ownerId: options.ownerId,
      description: options.description,
      isPublic: options.isPublic,
      primaryFilename: files[0]!.filename,
      primaryLanguage: detectLanguage(files[0]!.filename),
      fileCount: files.length,
    });
  } catch (error) {
    // Ohne Datenbankeintrag wäre das Verzeichnis verwaist.
    await rm(path, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return gistId;
}

export async function updateGist(
  gistId: string,
  actor: { id: string; name: string; email: string; isAdmin: boolean },
  options: {
    description?: string | null;
    isPublic?: boolean;
    files?: { filename: string; content: string }[];
  },
): Promise<void> {
  const [gist] = await db.select().from(gists).where(eq(gists.id, gistId)).limit(1);
  if (!gist) throw notFound('Gist nicht gefunden.');
  if (gist.ownerId !== actor.id && !actor.isAdmin) {
    throw forbidden('Nur der Eigentümer kann diesen Gist ändern.');
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (options.description !== undefined) patch.description = options.description;
  if (options.isPublic !== undefined) patch.isPublic = options.isPublic;

  if (options.files) {
    if (options.files.length === 0) {
      throw validationFailed('Ein Gist braucht mindestens eine Datei.');
    }
    const files = options.files.map((file) => ({
      filename: validateFilename(file.filename),
      content: file.content,
    }));

    await commitFiles(
      gistId,
      files,
      { name: actor.name, email: actor.email },
      'Gist aktualisiert',
    );

    patch.primaryFilename = files[0]!.filename;
    patch.primaryLanguage = detectLanguage(files[0]!.filename);
    patch.fileCount = files.length;
  }

  await db.update(gists).set(patch).where(eq(gists.id, gistId));
}

export async function deleteGist(
  gistId: string,
  actor: { id: string; isAdmin: boolean },
): Promise<void> {
  const [gist] = await db.select().from(gists).where(eq(gists.id, gistId)).limit(1);
  if (!gist) throw notFound('Gist nicht gefunden.');
  if (gist.ownerId !== actor.id && !actor.isAdmin) {
    throw forbidden('Nur der Eigentümer kann diesen Gist löschen.');
  }

  await db.delete(gists).where(eq(gists.id, gistId));
  await rm(gistPath(gistId), { recursive: true, force: true }).catch(() => {});
}

/** Liest die Dateien eines Gists aus seinem Repository. */
export async function readGistFiles(gistId: string): Promise<GistFile[]> {
  if (!(await gistRepositoryExists(gistId))) return [];

  const cwd = gistPath(gistId);
  const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], {
    cwd,
    allowFailure: true,
  });
  if (head.exitCode !== 0) return [];

  const listing = await runGitText(['ls-tree', '-z', '--long', 'HEAD'], { cwd });
  const files: GistFile[] = [];

  for (const line of listing.split('\0')) {
    if (!line) continue;
    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1) continue;

    const meta = line.slice(0, tabIndex).split(/\s+/);
    const filename = line.slice(tabIndex + 1);
    if (meta[1] !== 'blob') continue;

    const size = meta[3] && meta[3] !== '-' ? Number(meta[3]) : 0;

    // Sehr große Schnipsel sind kein Gist mehr; der Inhalt wird dann
    // abgeschnitten statt die Antwort unbegrenzt wachsen zu lassen.
    const content =
      size > 512 * 1024
        ? '// Diese Datei ist zu groß für die Anzeige. Klone den Gist, um sie zu lesen.'
        : (await runGit(['cat-file', 'blob', `HEAD:${filename}`], { cwd, maxBuffer: size + 1024 }))
            .stdout.toString('utf8');

    files.push({ filename, content, language: detectLanguage(filename), sizeBytes: size });
  }

  files.sort((a, b) => a.filename.localeCompare(b.filename, 'en'));
  return files;
}

function toSummary(
  row: typeof gists.$inferSelect,
  owner: UserRef | null,
  starCount: number,
  viewerHasStarred: boolean,
): GistSummary {
  return {
    id: row.id,
    description: row.description,
    isPublic: row.isPublic,
    owner,
    primaryFilename: row.primaryFilename,
    primaryLanguage: row.primaryLanguage,
    fileCount: row.fileCount,
    starCount,
    viewerHasStarred,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    cloneUrl: `${config.server.publicApiUrl}/git/gists/${row.id}.git`,
  };
}

export async function getGist(gistId: string, viewerId: string | null): Promise<GistDetail> {
  if (!UUID_PATTERN.test(gistId)) throw notFound('Gist nicht gefunden.');

  const rows = await db
    .select({ gist: gists, username: namespaces.name, displayName: users.displayName, avatarPath: users.avatarPath })
    .from(gists)
    .leftJoin(users, eq(users.id, gists.ownerId))
    .leftJoin(namespaces, eq(namespaces.id, users.namespaceId))
    .where(eq(gists.id, gistId))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound('Gist nicht gefunden.');

  const starRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gistStars)
    .where(eq(gistStars.gistId, gistId));

  let viewerHasStarred = false;
  if (viewerId) {
    const mine = await db
      .select({ userId: gistStars.userId })
      .from(gistStars)
      .where(and(eq(gistStars.gistId, gistId), eq(gistStars.userId, viewerId)))
      .limit(1);
    viewerHasStarred = mine.length > 0;
  }

  const owner: UserRef | null = row.username
    ? {
        id: row.gist.ownerId,
        username: row.username,
        displayName: row.displayName ?? null,
        avatarUrl: avatarUrl(row.avatarPath),
      }
    : null;

  return {
    ...toSummary(row.gist, owner, starRows[0]?.count ?? 0, viewerHasStarred),
    files: await readGistFiles(gistId),
    viewerCanEdit: viewerId === row.gist.ownerId,
  };
}

/**
 * Listet Gists.
 *
 * Ohne `ownerId` erscheinen nur öffentliche. Mit `ownerId` sieht der
 * Eigentümer auch seine nicht gelisteten – andere wiederum nur die
 * öffentlichen desselben Benutzers.
 */
export async function listGists(options: {
  ownerId?: string | null;
  viewerId: string | null;
  page?: number;
  perPage?: number;
}): Promise<{ items: GistSummary[]; totalCount: number }> {
  const perPage = Math.min(options.perPage ?? 30, 100);
  const page = Math.max(options.page ?? 1, 1);

  const conditions = [];
  if (options.ownerId) conditions.push(eq(gists.ownerId, options.ownerId));

  const seesEverything = options.ownerId && options.ownerId === options.viewerId;
  if (!seesEverything) conditions.push(eq(gists.isPublic, true));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      gist: gists,
      username: namespaces.name,
      displayName: users.displayName,
      avatarPath: users.avatarPath,
      starCount: sql<number>`(SELECT count(*)::int FROM gist_stars WHERE gist_stars.gist_id = ${gists.id})`,
    })
    .from(gists)
    .leftJoin(users, eq(users.id, gists.ownerId))
    .leftJoin(namespaces, eq(namespaces.id, users.namespaceId))
    .where(where)
    .orderBy(desc(gists.updatedAt))
    .limit(perPage)
    .offset((page - 1) * perPage);

  const totalRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gists)
    .where(where);

  return {
    items: rows.map((row) =>
      toSummary(
        row.gist,
        row.username
          ? {
              id: row.gist.ownerId,
              username: row.username,
              displayName: row.displayName ?? null,
              avatarUrl: avatarUrl(row.avatarPath),
            }
          : null,
        row.starCount,
        false,
      ),
    ),
    totalCount: totalRows[0]?.count ?? 0,
  };
}

export async function setGistStar(
  gistId: string,
  userId: string,
  starred: boolean,
): Promise<number> {
  if (starred) {
    await db.insert(gistStars).values({ gistId, userId }).onConflictDoNothing();
  } else {
    await db
      .delete(gistStars)
      .where(and(eq(gistStars.gistId, gistId), eq(gistStars.userId, userId)));
  }

  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gistStars)
    .where(eq(gistStars.gistId, gistId));
  return rows[0]?.count ?? 0;
}
