/**
 * Übergreifende Suche über Repositories, Code, Commits, Issues und Benutzer.
 *
 * Grundsatz: jede Teilsuche filtert über `visibleRepositoriesFilter`, dieselbe
 * Bedingung, die auch die Repository-Liste verwendet. Dadurch kann kein
 * Suchergebnis Inhalte aus einem Repository zeigen, das der Benutzer nicht
 * sehen darf – ohne dass die Regel hier noch einmal formuliert werden müsste.
 *
 * Die Codesuche läuft mit `git grep` direkt gegen die Repositories. Das ist
 * ehrlicher als ein halbgarer eigener Index: es findet wirklich, was im Code
 * steht, und braucht keine Pflege. Der Preis ist, dass die Suche über viele
 * Repositories hinweg begrenzt werden muss – deshalb wird die Anzahl der
 * durchsuchten Repositories und die Laufzeit gedeckelt.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  commitIndex,
  issues,
  namespaces,
  organizations,
  repositories,
  users,
} from '../db/schema.js';
import { visibleRepositoriesFilter } from '../services/permissions.js';
import { toSummary } from '../services/repositories.js';
import { hydrateIssues, loadUserRefs } from '../services/issues.js';
import { runGit } from '../git/exec.js';
import { repositoryPath } from '../git/storage.js';
import { detectLanguage } from '../lib/language.js';

/** Obergrenzen für die Codesuche, damit eine Anfrage den Server nicht lahmlegt. */
const CODE_SEARCH_MAX_REPOS = 25;
const CODE_SEARCH_MAX_MATCHES = 100;
const CODE_SEARCH_TIMEOUT_MS = 10_000;

const querySchema = z.object({
  q: z.string().min(1).max(200),
  type: z.enum(['repositories', 'code', 'commits', 'issues', 'users']).default('repositories'),
  language: z.string().max(50).optional(),
  owner: z.string().max(39).optional(),
  repo: z.string().max(100).optional(),
  state: z.enum(['open', 'closed', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(20),
});

export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/search', async (request) => {
    const query = querySchema.parse(request.query);
    const viewer = request.viewer;

    switch (query.type) {
      case 'repositories':
        return searchRepositories(query, viewer);
      case 'users':
        return searchUsers(query);
      case 'issues':
        return searchIssues(query, viewer);
      case 'commits':
        return searchCommits(query, viewer);
      case 'code':
        return searchCode(query, viewer);
    }
  });

  // -------------------------------------------------------------------------

  async function searchRepositories(
    query: z.infer<typeof querySchema>,
    viewer: { id: string; isAdmin: boolean } | null,
  ) {
    const conditions = [visibleRepositoriesFilter(viewer)];
    const pattern = `%${query.q}%`;

    conditions.push(
      or(
        ilike(repositories.name, pattern),
        ilike(repositories.description, pattern),
        // Themen liegen als JSON-Array; die Textsuche darüber ist für die
        // erwarteten Mengen ausreichend.
        sql`${repositories.topics}::text ILIKE ${pattern}`,
      )!,
    );

    if (query.language) conditions.push(eq(repositories.primaryLanguage, query.language));
    if (query.owner) conditions.push(eq(namespaces.nameLower, query.owner.toLowerCase()));

    const where = and(...conditions);

    const rows = await db
      .select({ repository: repositories, ownerName: namespaces.name, ownerKind: namespaces.kind })
      .from(repositories)
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(where)
      .orderBy(desc(repositories.starCount), desc(repositories.updatedAt))
      .limit(query.perPage)
      .offset((query.page - 1) * query.perPage);

    const totalRows = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(repositories)
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(where);

    return {
      type: 'repositories' as const,
      totalCount: totalRows[0]?.total ?? 0,
      items: rows.map((row) => toSummary(row.repository, row.ownerName, row.ownerKind)),
    };
  }

  // -------------------------------------------------------------------------

  async function searchUsers(query: z.infer<typeof querySchema>) {
    const pattern = `%${query.q}%`;

    const userRows = await db
      .select({
        id: users.id,
        username: namespaces.name,
        displayName: users.displayName,
        avatarPath: users.avatarPath,
        bio: users.bio,
      })
      .from(users)
      .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
      .where(
        and(
          eq(users.isActive, true),
          isNull(users.suspendedAt),
          or(ilike(namespaces.name, pattern), ilike(users.displayName, pattern)),
        ),
      )
      .limit(query.perPage);

    const orgRows = await db
      .select({
        id: organizations.id,
        name: namespaces.name,
        displayName: organizations.displayName,
        description: organizations.description,
      })
      .from(organizations)
      .innerJoin(namespaces, eq(namespaces.id, organizations.namespaceId))
      .where(or(ilike(namespaces.name, pattern), ilike(organizations.displayName, pattern)))
      .limit(query.perPage);

    return {
      type: 'users' as const,
      totalCount: userRows.length + orgRows.length,
      items: [
        ...userRows.map((row) => ({
          kind: 'user' as const,
          id: row.id,
          name: row.username,
          displayName: row.displayName,
          description: row.bio,
        })),
        ...orgRows.map((row) => ({
          kind: 'organization' as const,
          id: row.id,
          name: row.name,
          displayName: row.displayName,
          description: row.description,
        })),
      ],
    };
  }

  // -------------------------------------------------------------------------

  async function searchIssues(
    query: z.infer<typeof querySchema>,
    viewer: { id: string; isAdmin: boolean } | null,
  ) {
    const pattern = `%${query.q}%`;

    const conditions = [
      or(ilike(issues.title, pattern), ilike(issues.body, pattern))!,
      // Der Unterabfrage-Filter stellt sicher, dass nur Issues aus sichtbaren
      // Repositories erscheinen.
      sql`EXISTS (
        SELECT 1 FROM ${repositories}
        WHERE ${repositories.id} = ${issues.repositoryId}
          AND ${visibleRepositoriesFilter(viewer)}
      )`,
    ];

    if (query.state !== 'all') conditions.push(eq(issues.state, query.state));

    const where = and(...conditions);

    const rows = await db
      .select({
        issue: issues,
        repositoryName: repositories.name,
        ownerName: namespaces.name,
      })
      .from(issues)
      .innerJoin(repositories, eq(repositories.id, issues.repositoryId))
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(where)
      .orderBy(desc(issues.updatedAt))
      .limit(query.perPage)
      .offset((query.page - 1) * query.perPage);

    const totalRows = await db.select({ total: sql<number>`count(*)::int` }).from(issues).where(where);

    const hydrated = await hydrateIssues(
      rows.map((r) => r.issue),
      viewer?.id ?? null,
    );

    return {
      type: 'issues' as const,
      totalCount: totalRows[0]?.total ?? 0,
      items: hydrated.map((issue, index) => ({
        ...issue,
        repositoryFullName: `${rows[index]!.ownerName}/${rows[index]!.repositoryName}`,
      })),
    };
  }

  // -------------------------------------------------------------------------

  async function searchCommits(
    query: z.infer<typeof querySchema>,
    viewer: { id: string; isAdmin: boolean } | null,
  ) {
    const pattern = `%${query.q}%`;

    const where = and(
      or(ilike(commitIndex.subject, pattern), ilike(commitIndex.body, pattern))!,
      sql`EXISTS (
        SELECT 1 FROM ${repositories}
        WHERE ${repositories.id} = ${commitIndex.repositoryId}
          AND ${visibleRepositoriesFilter(viewer)}
      )`,
    );

    const rows = await db
      .select({
        commit: commitIndex,
        repositoryName: repositories.name,
        ownerName: namespaces.name,
      })
      .from(commitIndex)
      .innerJoin(repositories, eq(repositories.id, commitIndex.repositoryId))
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(where)
      .orderBy(desc(commitIndex.committedAt))
      .limit(query.perPage)
      .offset((query.page - 1) * query.perPage);

    const refs = await loadUserRefs(rows.map((r) => r.commit.authorUserId));

    return {
      type: 'commits' as const,
      totalCount: rows.length,
      items: rows.map((row) => ({
        oid: row.commit.oid,
        shortOid: row.commit.oid.slice(0, 7),
        subject: row.commit.subject,
        body: row.commit.body,
        authorName: row.commit.authorName,
        author: row.commit.authorUserId ? (refs.get(row.commit.authorUserId) ?? null) : null,
        committedAt: row.commit.committedAt.toISOString(),
        repositoryFullName: `${row.ownerName}/${row.repositoryName}`,
      })),
    };
  }

  // -------------------------------------------------------------------------

  async function searchCode(
    query: z.infer<typeof querySchema>,
    viewer: { id: string; isAdmin: boolean } | null,
  ) {
    const conditions = [visibleRepositoriesFilter(viewer)];
    if (query.owner) conditions.push(eq(namespaces.nameLower, query.owner.toLowerCase()));
    if (query.repo) conditions.push(eq(repositories.nameLower, query.repo.toLowerCase()));
    if (query.language) conditions.push(eq(repositories.primaryLanguage, query.language));

    const repoRows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
        ownerName: namespaces.name,
      })
      .from(repositories)
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(and(...conditions, eq(repositories.isEmpty, false)))
      .orderBy(desc(repositories.updatedAt))
      .limit(CODE_SEARCH_MAX_REPOS);

    const deadline = Date.now() + CODE_SEARCH_TIMEOUT_MS;
    const matches: {
      repositoryFullName: string;
      path: string;
      line: number;
      content: string;
      language: string | null;
    }[] = [];

    let truncated = repoRows.length >= CODE_SEARCH_MAX_REPOS;

    for (const repo of repoRows) {
      if (matches.length >= CODE_SEARCH_MAX_MATCHES || Date.now() > deadline) {
        truncated = true;
        break;
      }

      // --fixed-strings: der Suchbegriff wird wörtlich genommen. Ein
      // regulärer Ausdruck aus Benutzereingabe könnte den Prozess mit
      // katastrophalem Backtracking blockieren.
      const result = await runGit(
        [
          'grep',
          '--fixed-strings',
          '--ignore-case',
          '--line-number',
          '--no-color',
          '--max-count=5',
          '-I', // Binärdateien überspringen
          '-e',
          query.q,
          repo.defaultBranch,
        ],
        {
          cwd: repositoryPath(repo.id),
          allowFailure: true,
          timeoutMs: 5000,
          maxBuffer: 2 * 1024 * 1024,
        },
      ).catch(() => null);

      if (!result || result.exitCode !== 0) continue;

      for (const line of result.stdout.toString('utf8').split('\n')) {
        if (!line) continue;
        if (matches.length >= CODE_SEARCH_MAX_MATCHES) {
          truncated = true;
          break;
        }

        // Format: <ref>:<pfad>:<zeile>:<inhalt>
        const withoutRef = line.startsWith(`${repo.defaultBranch}:`)
          ? line.slice(repo.defaultBranch.length + 1)
          : line;

        const firstColon = withoutRef.indexOf(':');
        if (firstColon === -1) continue;
        const secondColon = withoutRef.indexOf(':', firstColon + 1);
        if (secondColon === -1) continue;

        const path = withoutRef.slice(0, firstColon);
        const lineNumber = Number(withoutRef.slice(firstColon + 1, secondColon));
        const content = withoutRef.slice(secondColon + 1);

        if (!Number.isFinite(lineNumber)) continue;

        matches.push({
          repositoryFullName: `${repo.ownerName}/${repo.name}`,
          path,
          line: lineNumber,
          // Sehr lange Zeilen (etwa minifizierter Code) würden die Antwort
          // aufblähen und sind als Vorschau ohnehin wertlos.
          content: content.slice(0, 400),
          language: detectLanguage(path),
        });
      }
    }

    return {
      type: 'code' as const,
      totalCount: matches.length,
      truncated,
      searchedRepositories: repoRows.length,
      items: matches,
    };
  }
}
