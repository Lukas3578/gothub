/**
 * Dashboard: Übersicht über eigene und beobachtete Repositories sowie
 * Aktivität. Alle Zahlen stammen aus der Datenbank.
 */

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  issues,
  namespaces,
  organizationMembers,
  organizations,
  pushEvents,
  repositories,
  users,
  watches,
} from '../db/schema.js';
import { visibleRepositoriesFilter } from '../services/permissions.js';
import { toSummary } from '../services/repositories.js';

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/dashboard', async (request) => {
    app.requireAuth(request);
    const viewer = request.viewer!;

    // Eigene Repositories.
    const ownRows = await db
      .select({ repository: repositories, ownerName: namespaces.name, ownerKind: namespaces.kind })
      .from(repositories)
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(
        and(
          eq(repositories.ownerNamespaceId, viewer.namespaceId),
          visibleRepositoriesFilter(viewer),
        ),
      )
      .orderBy(desc(repositories.updatedAt))
      .limit(10);

    // Beobachtete Repositories, die nicht dem Benutzer selbst gehören.
    const watchedRows = await db
      .select({ repository: repositories, ownerName: namespaces.name, ownerKind: namespaces.kind })
      .from(watches)
      .innerJoin(repositories, eq(repositories.id, watches.repositoryId))
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(
        and(
          eq(watches.userId, viewer.id),
          sql`${repositories.ownerNamespaceId} <> ${viewer.namespaceId}`,
          visibleRepositoriesFilter(viewer),
        ),
      )
      .orderBy(desc(repositories.pushedAt))
      .limit(10);

    // Organisationen des Benutzers.
    const orgRows = await db
      .select({
        id: organizations.id,
        name: namespaces.name,
        displayName: organizations.displayName,
        role: organizationMembers.role,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .innerJoin(namespaces, eq(namespaces.id, organizations.namespaceId))
      .where(eq(organizationMembers.userId, viewer.id));

    // Offene Issues und Pull Requests, die dem Benutzer gehören.
    const [issueCounts] = await db
      .select({
        openIssues: sql<number>`count(*) FILTER (WHERE ${issues.kind} = 'issue')`,
        openPullRequests: sql<number>`count(*) FILTER (WHERE ${issues.kind} = 'pull_request')`,
      })
      .from(issues)
      .innerJoin(repositories, eq(repositories.id, issues.repositoryId))
      .where(and(eq(issues.authorId, viewer.id), eq(issues.state, 'open')));

    // Letzte Push-Ereignisse in sichtbaren Repositories.
    const activityRows = await db
      .select({
        id: pushEvents.id,
        refName: pushEvents.refName,
        commitCount: pushEvents.commitCount,
        createdAt: pushEvents.createdAt,
        repositoryName: repositories.name,
        ownerName: namespaces.name,
      })
      .from(pushEvents)
      .innerJoin(repositories, eq(repositories.id, pushEvents.repositoryId))
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(visibleRepositoriesFilter(viewer))
      .orderBy(desc(pushEvents.createdAt))
      .limit(15);

    return {
      ownRepositories: ownRows.map((r) => toSummary(r.repository, r.ownerName, r.ownerKind)),
      watchedRepositories: watchedRows.map((r) =>
        toSummary(r.repository, r.ownerName, r.ownerKind),
      ),
      organizations: orgRows,
      counts: {
        openIssues: issueCounts?.openIssues ?? 0,
        openPullRequests: issueCounts?.openPullRequests ?? 0,
        repositories: ownRows.length,
      },
      activity: activityRows.map((row) => ({
        id: row.id,
        type: 'push' as const,
        repositoryFullName: `${row.ownerName}/${row.repositoryName}`,
        refName: row.refName.replace('refs/heads/', ''),
        commitCount: row.commitCount,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });
}
