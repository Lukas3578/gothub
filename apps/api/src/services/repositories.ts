/**
 * Repository-Verwaltung: Anlegen, Ändern, Forken, Löschen.
 *
 * Der Kernpunkt: Datenbankeintrag und Verzeichnis auf der Festplatte müssen
 * zusammenpassen. Da sich ein Dateisystem nicht in eine SQL-Transaktion
 * einbinden lässt, wird die Reihenfolge so gewählt, dass ein Abbruch zu
 * aufräumbarem statt zu widersprüchlichem Zustand führt.
 */

import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  REPO_NAME_PATTERN,
  RESERVED_REPO_NAMES,
  type AccessLevel,
  type RepositoryDetail,
  type RepositorySummary,
  type RepoVisibility,
} from '@forge/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import {
  auditLogs,
  labels,
  namespaces,
  organizations,
  repositories,
  stars,
  users,
  watches,
} from '../db/schema.js';
import { conflict, forbidden, isUniqueViolation, notFound, validationFailed } from '../lib/errors.js';
import {
  createRepository as createGitRepository,
  destroyRepository,
  forkRepository as forkGitRepository,
  trashRepository,
} from '../git/storage.js';
import { commitFileChange } from '../git/repository.js';
import { syncRepositoryMetadata } from './repository-metadata.js';
import { getOwnableNamespaceIds, requireOrganizationRole } from './permissions.js';

/** Standard-Labels, die jedes neue Repository erhält. */
const DEFAULT_LABELS = [
  { name: 'bug', color: 'd73a4a', description: 'Etwas funktioniert nicht' },
  { name: 'documentation', color: '0075ca', description: 'Verbesserungen an der Dokumentation' },
  { name: 'duplicate', color: 'cfd3d7', description: 'Existiert bereits' },
  { name: 'enhancement', color: 'a2eeef', description: 'Neue Funktion oder Verbesserung' },
  { name: 'good first issue', color: '7057ff', description: 'Guter Einstiegspunkt' },
  { name: 'help wanted', color: '008672', description: 'Unterstützung erwünscht' },
  { name: 'question', color: 'd876e3', description: 'Rückfrage' },
  { name: 'wontfix', color: 'ffffff', description: 'Wird nicht bearbeitet' },
];

export interface CreateRepositoryInput {
  ownerName: string;
  name: string;
  description?: string | null;
  visibility: RepoVisibility;
  defaultBranch?: string;
  initializeWithReadme?: boolean;
  gitignoreTemplate?: string | null;
  licenseTemplate?: string | null;
}

export async function createRepository(
  input: CreateRepositoryInput,
  creator: { id: string; username: string; email: string; isAdmin: boolean },
): Promise<RepositorySummary> {
  const name = input.name.trim();

  if (!REPO_NAME_PATTERN.test(name)) {
    throw validationFailed('Der Repository-Name ist ungültig.', {
      name: [
        'Erlaubt sind Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich; maximal 100 Zeichen.',
      ],
    });
  }
  if (RESERVED_REPO_NAMES.has(name.toLowerCase())) {
    throw validationFailed('Dieser Name ist reserviert.', { name: ['Reservierter Name.'] });
  }

  // Besitzer auflösen und prüfen, ob der Ersteller dort anlegen darf.
  const ownerRows = await db
    .select({ namespace: namespaces, organizationId: organizations.id })
    .from(namespaces)
    .leftJoin(organizations, eq(organizations.namespaceId, namespaces.id))
    .where(eq(namespaces.nameLower, input.ownerName.toLowerCase()))
    .limit(1);

  const owner = ownerRows[0];
  if (!owner) throw notFound('Besitzer nicht gefunden.');

  if (owner.namespace.kind === 'user') {
    const [ownerUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.namespaceId, owner.namespace.id))
      .limit(1);
    if (ownerUser?.id !== creator.id && !creator.isAdmin) {
      throw forbidden('Du kannst keine Repositories im Namensraum einer anderen Person anlegen.');
    }
  } else if (owner.organizationId) {
    await requireOrganizationRole(owner.organizationId, creator, 'admin');
  }

  const defaultBranch = (input.defaultBranch ?? 'main').trim() || 'main';

  // Datenbankeintrag zuerst: die UUID bestimmt den Pfad auf der Festplatte,
  // und der UNIQUE-Index auf (Besitzer, Name) ist die verlässliche Sperre
  // gegen gleichzeitige Anlage desselben Namens.
  let created;
  try {
    const rows = await db
      .insert(repositories)
      .values({
        ownerNamespaceId: owner.namespace.id,
        name,
        nameLower: name.toLowerCase(),
        description: input.description?.trim() || null,
        visibility: input.visibility,
        defaultBranch,
        isEmpty: true,
      })
      .returning();
    created = rows[0]!;
  } catch (error) {
    if (isUniqueViolation(error, 'repositories_owner_name_key', 'repositories.name_lower')) {
      throw conflict(`${input.ownerName}/${name} existiert bereits.`);
    }
    throw error;
  }

  try {
    await createGitRepository(created.id, defaultBranch);

    await db.insert(labels).values(
      DEFAULT_LABELS.map((label) => ({ ...label, repositoryId: created.id })),
    );

    // Der Ersteller beobachtet sein Repository automatisch.
    await db.insert(watches).values({ userId: creator.id, repositoryId: created.id });
    await db
      .update(repositories)
      .set({ watcherCount: 1 })
      .where(eq(repositories.id, created.id));

    if (input.initializeWithReadme || input.gitignoreTemplate || input.licenseTemplate) {
      await initializeRepository(created.id, {
        name,
        description: input.description ?? null,
        defaultBranch,
        author: { name: creator.username, email: creator.email },
        gitignoreTemplate: input.gitignoreTemplate ?? null,
        licenseTemplate: input.licenseTemplate ?? null,
        username: creator.username,
      });

      await syncRepositoryMetadata(created.id);
    }
  } catch (error) {
    // Das Verzeichnis konnte nicht angelegt werden: den Datenbankeintrag
    // zurücknehmen, damit kein Repository zurückbleibt, das die Oberfläche
    // anzeigt, aber nicht geklont werden kann.
    await db.delete(repositories).where(eq(repositories.id, created.id));
    await destroyRepository(created.id).catch(() => {});
    throw error;
  }

  await db.insert(auditLogs).values({
    actorId: creator.id,
    action: 'repository.created',
    targetType: 'repository',
    targetId: created.id,
    repositoryId: created.id,
    metadata: { name, visibility: input.visibility },
  });

  const [fresh] = await db.select().from(repositories).where(eq(repositories.id, created.id));
  return toSummary(fresh!, owner.namespace.name, owner.namespace.kind);
}

/** Legt die Startdateien an: README, .gitignore, LICENSE. */
async function initializeRepository(
  repositoryId: string,
  options: {
    name: string;
    description: string | null;
    defaultBranch: string;
    author: { name: string; email: string };
    gitignoreTemplate: string | null;
    licenseTemplate: string | null;
    username: string;
  },
): Promise<void> {
  const readme = [
    `# ${options.name}`,
    '',
    options.description ?? 'Noch keine Beschreibung.',
    '',
  ].join('\n');

  await commitFileChange(repositoryId, {
    branch: options.defaultBranch,
    path: 'README.md',
    content: Buffer.from(readme, 'utf8'),
    message: 'Initialer Commit',
    author: options.author,
    expectedOid: null,
  });

  if (options.gitignoreTemplate) {
    const content = GITIGNORE_TEMPLATES[options.gitignoreTemplate];
    if (content) {
      await commitFileChange(repositoryId, {
        branch: options.defaultBranch,
        path: '.gitignore',
        content: Buffer.from(content, 'utf8'),
        message: `.gitignore für ${options.gitignoreTemplate} hinzufügen`,
        author: options.author,
      });
    }
  }

  if (options.licenseTemplate) {
    const build = LICENSE_TEMPLATES[options.licenseTemplate];
    if (build) {
      await commitFileChange(repositoryId, {
        branch: options.defaultBranch,
        path: 'LICENSE',
        content: Buffer.from(build(options.username, new Date().getFullYear()), 'utf8'),
        message: `${options.licenseTemplate}-Lizenz hinzufügen`,
        author: options.author,
      });
    }
  }
}

const GITIGNORE_TEMPLATES: Record<string, string> = {
  Node: 'node_modules/\ndist/\nbuild/\n.env\n.env.local\n*.log\ncoverage/\n.DS_Store\n',
  Python: '__pycache__/\n*.py[cod]\n.venv/\nvenv/\n.env\ndist/\nbuild/\n*.egg-info/\n.pytest_cache/\n',
  Rust: 'target/\nCargo.lock\n**/*.rs.bk\n',
  Go: '*.exe\n*.test\n*.out\nvendor/\nbin/\n',
  Java: '*.class\ntarget/\nbuild/\n.gradle/\n*.jar\n',
};

const LICENSE_TEMPLATES: Record<string, (holder: string, year: number) => string> = {
  MIT: (holder, year) =>
    `MIT License\n\nCopyright (c) ${year} ${holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n`,
  'Apache-2.0': (holder, year) =>
    `Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/\n\nCopyright ${year} ${holder}\n\nLicensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at\n\n    http://www.apache.org/licenses/LICENSE-2.0\n\nUnless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.\n\nDer vollständige Lizenztext ist unter der angegebenen URL abrufbar.\n`,
};

// ---------------------------------------------------------------------------
// Fork
// ---------------------------------------------------------------------------

export async function forkRepository(
  sourceRepositoryId: string,
  targetOwnerName: string,
  newName: string | null,
  creator: { id: string; username: string; isAdmin: boolean },
): Promise<RepositorySummary> {
  const [source] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, sourceRepositoryId), isNull(repositories.deletedAt)))
    .limit(1);

  if (!source) throw notFound('Quell-Repository nicht gefunden.');
  if (source.isEmpty) throw validationFailed('Ein leeres Repository kann nicht geforkt werden.');

  const ownerRows = await db
    .select({ namespace: namespaces, organizationId: organizations.id })
    .from(namespaces)
    .leftJoin(organizations, eq(organizations.namespaceId, namespaces.id))
    .where(eq(namespaces.nameLower, targetOwnerName.toLowerCase()))
    .limit(1);

  const owner = ownerRows[0];
  if (!owner) throw notFound('Ziel-Besitzer nicht gefunden.');

  const ownable = await getOwnableNamespaceIds(creator.id);
  if (!ownable.includes(owner.namespace.id) && !creator.isAdmin) {
    throw forbidden('Du darfst in diesem Namensraum keine Repositories anlegen.');
  }

  const name = (newName ?? source.name).trim();

  let created;
  try {
    const rows = await db
      .insert(repositories)
      .values({
        ownerNamespaceId: owner.namespace.id,
        name,
        nameLower: name.toLowerCase(),
        description: source.description,
        // Ein Fork erbt niemals eine weitergehende Sichtbarkeit als das
        // Original, startet aber bei privat, wenn das Original privat war.
        visibility: source.visibility === 'public' ? 'public' : 'private',
        defaultBranch: source.defaultBranch,
        isFork: true,
        parentId: source.id,
        isEmpty: false,
        primaryLanguage: source.primaryLanguage,
        languages: source.languages,
      })
      .returning();
    created = rows[0]!;
  } catch (error) {
    if (isUniqueViolation(error, 'repositories_owner_name_key', 'repositories.name_lower')) {
      throw conflict(`${targetOwnerName}/${name} existiert bereits.`);
    }
    throw error;
  }

  try {
    await forkGitRepository(source.id, created.id);
    await db.insert(labels).values(DEFAULT_LABELS.map((l) => ({ ...l, repositoryId: created.id })));
    await db.insert(watches).values({ userId: creator.id, repositoryId: created.id });
    await db
      .update(repositories)
      .set({ forkCount: sql`${repositories.forkCount} + 1` })
      .where(eq(repositories.id, source.id));
    await syncRepositoryMetadata(created.id);
  } catch (error) {
    await db.delete(repositories).where(eq(repositories.id, created.id));
    await destroyRepository(created.id).catch(() => {});
    throw error;
  }

  const [fresh] = await db.select().from(repositories).where(eq(repositories.id, created.id));
  return toSummary(fresh!, owner.namespace.name, owner.namespace.kind);
}

// ---------------------------------------------------------------------------
// Ändern und Löschen
// ---------------------------------------------------------------------------

export interface UpdateRepositoryInput {
  name?: string;
  description?: string | null;
  websiteUrl?: string | null;
  visibility?: RepoVisibility;
  defaultBranch?: string;
  topics?: string[];
  isArchived?: boolean;
  isTemplate?: boolean;
  hasIssues?: boolean;
  hasPullRequests?: boolean;
  hasWiki?: boolean;
  hasActions?: boolean;
  allowMergeCommit?: boolean;
  allowSquashMerge?: boolean;
  allowRebaseMerge?: boolean;
  deleteBranchOnMerge?: boolean;
}

export async function updateRepository(
  repositoryId: string,
  input: UpdateRepositoryInput,
  actorId: string,
): Promise<void> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!REPO_NAME_PATTERN.test(name)) {
      throw validationFailed('Der Repository-Name ist ungültig.', { name: ['Ungültiges Format.'] });
    }
    if (RESERVED_REPO_NAMES.has(name.toLowerCase())) {
      throw validationFailed('Dieser Name ist reserviert.', { name: ['Reservierter Name.'] });
    }
    patch.name = name;
    patch.nameLower = name.toLowerCase();
  }

  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.websiteUrl !== undefined) patch.websiteUrl = input.websiteUrl?.trim() || null;
  if (input.visibility !== undefined) patch.visibility = input.visibility;
  if (input.isArchived !== undefined) patch.isArchived = input.isArchived;
  if (input.isTemplate !== undefined) patch.isTemplate = input.isTemplate;
  if (input.hasIssues !== undefined) patch.hasIssues = input.hasIssues;
  if (input.hasPullRequests !== undefined) patch.hasPullRequests = input.hasPullRequests;
  if (input.hasWiki !== undefined) patch.hasWiki = input.hasWiki;
  if (input.hasActions !== undefined) patch.hasActions = input.hasActions;
  if (input.allowMergeCommit !== undefined) patch.allowMergeCommit = input.allowMergeCommit;
  if (input.allowSquashMerge !== undefined) patch.allowSquashMerge = input.allowSquashMerge;
  if (input.allowRebaseMerge !== undefined) patch.allowRebaseMerge = input.allowRebaseMerge;
  if (input.deleteBranchOnMerge !== undefined) patch.deleteBranchOnMerge = input.deleteBranchOnMerge;

  if (input.topics !== undefined) {
    // Themen werden normalisiert: klein, ohne Leerzeichen, maximal 20 Stück.
    patch.topics = [
      ...new Set(
        input.topics
          .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-'))
          .filter((t) => t.length > 0 && t.length <= 50),
      ),
    ].slice(0, 20);
  }

  if (input.defaultBranch !== undefined) {
    const { setHeadBranch } = await import('../git/repository.js');
    // Wirft, wenn der Branch nicht existiert – die Datenbank bleibt dann
    // unverändert, statt auf einen nicht vorhandenen Branch zu zeigen.
    await setHeadBranch(repositoryId, input.defaultBranch);
    patch.defaultBranch = input.defaultBranch;
  }

  try {
    await db.update(repositories).set(patch).where(eq(repositories.id, repositoryId));
  } catch (error) {
    if (isUniqueViolation(error, 'repositories_owner_name_key', 'repositories.name_lower')) {
      throw conflict('Unter diesem Besitzer existiert bereits ein Repository mit diesem Namen.');
    }
    throw error;
  }

  await db.insert(auditLogs).values({
    actorId,
    action: 'repository.updated',
    targetType: 'repository',
    targetId: repositoryId,
    repositoryId,
    metadata: { fields: Object.keys(patch).filter((k) => k !== 'updatedAt') },
  });
}

/**
 * Löscht ein Repository.
 *
 * Soft Delete: der Datensatz bleibt mit gesetztem deletedAt erhalten und das
 * Verzeichnis wandert in den Papierkorb. Dadurch ist eine Wiederherstellung
 * möglich, und der Name wird nicht sofort wieder frei – das verhindert, dass
 * jemand einen gelöschten Namen übernimmt und bestehende Links kapert.
 */
export async function deleteRepository(repositoryId: string, actorId: string): Promise<void> {
  await db
    .update(repositories)
    .set({ deletedAt: new Date() })
    .where(eq(repositories.id, repositoryId));

  await trashRepository(repositoryId).catch(() => {});

  await db.insert(auditLogs).values({
    actorId,
    action: 'repository.deleted',
    targetType: 'repository',
    targetId: repositoryId,
    metadata: {},
  });
}

/** Überträgt ein Repository an einen anderen Besitzer. */
export async function transferRepository(
  repositoryId: string,
  newOwnerName: string,
  actor: { id: string; isAdmin: boolean },
): Promise<void> {
  const ownerRows = await db
    .select({ namespace: namespaces, organizationId: organizations.id })
    .from(namespaces)
    .leftJoin(organizations, eq(organizations.namespaceId, namespaces.id))
    .where(eq(namespaces.nameLower, newOwnerName.toLowerCase()))
    .limit(1);

  const owner = ownerRows[0];
  if (!owner) throw notFound('Neuer Besitzer nicht gefunden.');

  const ownable = await getOwnableNamespaceIds(actor.id);
  if (!ownable.includes(owner.namespace.id) && !actor.isAdmin) {
    throw forbidden('Du kannst das Repository nur an dich selbst oder an eine Organisation übertragen, die du verwaltest.');
  }

  try {
    await db
      .update(repositories)
      .set({ ownerNamespaceId: owner.namespace.id, updatedAt: new Date() })
      .where(eq(repositories.id, repositoryId));
  } catch (error) {
    if (isUniqueViolation(error, 'repositories_owner_name_key', 'repositories.name_lower')) {
      throw conflict('Der neue Besitzer hat bereits ein Repository mit diesem Namen.');
    }
    throw error;
  }

  await db.insert(auditLogs).values({
    actorId: actor.id,
    action: 'repository.transferred',
    targetType: 'repository',
    targetId: repositoryId,
    repositoryId,
    metadata: { newOwner: owner.namespace.name },
  });
}

// ---------------------------------------------------------------------------
// Stars und Watches
// ---------------------------------------------------------------------------

export async function setStar(
  repositoryId: string,
  userId: string,
  starred: boolean,
): Promise<number> {
  return db.transaction(async (tx) => {
    if (starred) {
      const inserted = await tx
        .insert(stars)
        .values({ userId, repositoryId })
        .onConflictDoNothing()
        .returning();
      if (inserted.length > 0) {
        await tx
          .update(repositories)
          .set({ starCount: sql`${repositories.starCount} + 1` })
          .where(eq(repositories.id, repositoryId));
      }
    } else {
      const deleted = await tx
        .delete(stars)
        .where(and(eq(stars.userId, userId), eq(stars.repositoryId, repositoryId)))
        .returning();
      if (deleted.length > 0) {
        await tx
          .update(repositories)
          // MAX mit zwei Argumenten verhindert negative Zähler, falls die
          // Buchführung einmal auseinanderläuft. (SQLite nennt GREATEST so.)
          .set({ starCount: sql`MAX(${repositories.starCount} - 1, 0)` })
          .where(eq(repositories.id, repositoryId));
      }
    }

    const [row] = await tx
      .select({ count: repositories.starCount })
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    return row?.count ?? 0;
  });
}

export async function setWatch(
  repositoryId: string,
  userId: string,
  watching: boolean,
): Promise<number> {
  return db.transaction(async (tx) => {
    if (watching) {
      const inserted = await tx
        .insert(watches)
        .values({ userId, repositoryId })
        .onConflictDoNothing()
        .returning();
      if (inserted.length > 0) {
        await tx
          .update(repositories)
          .set({ watcherCount: sql`${repositories.watcherCount} + 1` })
          .where(eq(repositories.id, repositoryId));
      }
    } else {
      const deleted = await tx
        .delete(watches)
        .where(and(eq(watches.userId, userId), eq(watches.repositoryId, repositoryId)))
        .returning();
      if (deleted.length > 0) {
        await tx
          .update(repositories)
          .set({ watcherCount: sql`MAX(${repositories.watcherCount} - 1, 0)` })
          .where(eq(repositories.id, repositoryId));
      }
    }

    const [row] = await tx
      .select({ count: repositories.watcherCount })
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    return row?.count ?? 0;
  });
}

// ---------------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------------

export function toSummary(
  repo: typeof repositories.$inferSelect,
  ownerName: string,
  ownerKind: 'user' | 'organization',
): RepositorySummary {
  return {
    id: repo.id,
    ownerType: ownerKind,
    ownerName,
    name: repo.name,
    fullName: `${ownerName}/${repo.name}`,
    description: repo.description,
    visibility: repo.visibility,
    isArchived: repo.isArchived,
    isFork: repo.isFork,
    isEmpty: repo.isEmpty,
    defaultBranch: repo.defaultBranch,
    primaryLanguage: repo.primaryLanguage,
    topics: repo.topics,
    starCount: repo.starCount,
    forkCount: repo.forkCount,
    watcherCount: repo.watcherCount,
    openIssueCount: repo.openIssueCount,
    sizeBytes: repo.sizeBytes,
    pushedAt: repo.pushedAt?.toISOString() ?? null,
    updatedAt: repo.updatedAt.toISOString(),
    createdAt: repo.createdAt.toISOString(),
    hasIssues: repo.hasIssues,
    hasPullRequests: repo.hasPullRequests,
    hasWiki: repo.hasWiki,
    hasActions: repo.hasActions,
    hasReleases: repo.hasReleases,
  };
}

export async function toDetail(
  repo: typeof repositories.$inferSelect,
  ownerName: string,
  ownerKind: 'user' | 'organization',
  viewerAccess: AccessLevel,
  viewerId: string | null,
): Promise<RepositoryDetail> {
  const summary = toSummary(repo, ownerName, ownerKind);

  let viewerHasStarred = false;
  let viewerIsWatching = false;

  if (viewerId) {
    const [star] = await db
      .select({ userId: stars.userId })
      .from(stars)
      .where(and(eq(stars.userId, viewerId), eq(stars.repositoryId, repo.id)))
      .limit(1);
    viewerHasStarred = Boolean(star);

    const [watch] = await db
      .select({ userId: watches.userId })
      .from(watches)
      .where(and(eq(watches.userId, viewerId), eq(watches.repositoryId, repo.id)))
      .limit(1);
    viewerIsWatching = Boolean(watch);
  }

  let parent: { fullName: string; id: string } | null = null;
  if (repo.parentId) {
    const rows = await db
      .select({ id: repositories.id, name: repositories.name, ownerName: namespaces.name })
      .from(repositories)
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(eq(repositories.id, repo.parentId))
      .limit(1);
    if (rows[0]) {
      parent = { id: rows[0].id, fullName: `${rows[0].ownerName}/${rows[0].name}` };
    }
  }

  return {
    ...summary,
    viewerAccess,
    viewerHasStarred,
    viewerIsWatching,
    parent,
    cloneUrlHttp: `${config.server.publicApiUrl}/git/${ownerName}/${repo.name}.git`,
  };
}
