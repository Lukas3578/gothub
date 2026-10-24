/**
 * Berechtigungsmodell.
 *
 * Es gibt genau EINE Funktion, die Repository-Zugriff berechnet:
 * `resolveRepositoryAccess`. Routen rufen sie über die Guards in
 * middleware/repository.ts auf. Keine Route darf Zugriff selbst herleiten –
 * sonst entstehen genau die Lücken, bei denen ein privates Repository in einer
 * Suchliste auftaucht.
 *
 * Zugriffsquellen, von der höchsten zur niedrigsten:
 *   1. Plattform-Administrator   -> admin
 *   2. Persönliches Repository des Benutzers -> admin
 *   3. Rolle in der besitzenden Organisation (owner/admin -> admin)
 *   4. Direkte Kollaboration auf dem Repository
 *   5. Team-Zuweisung in der besitzenden Organisation
 *   6. Sichtbarkeit (public -> read; internal -> read für angemeldete Benutzer)
 *
 * Das Ergebnis ist das Maximum aller zutreffenden Quellen.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type AccessLevel, hasAccess, maxAccess } from '@forge/shared';
import { db } from '../db/index.js';
import {
  namespaces,
  organizationMembers,
  organizations,
  repositories,
  repositoryCollaborators,
  teamMembers,
  teamRepositories,
  users,
} from '../db/schema.js';
import { forbidden, notFound } from '../lib/errors.js';

export interface RepositoryContext {
  repository: typeof repositories.$inferSelect;
  ownerName: string;
  ownerKind: 'user' | 'organization';
  /** Gesetzt, wenn das Repository einer Organisation gehört. */
  organizationId: string | null;
}

export interface ResolvedAccess extends RepositoryContext {
  level: AccessLevel;
  /** True, wenn der Zugriff ausschließlich aus der Sichtbarkeit folgt. */
  isAnonymousRead: boolean;
}

/**
 * Lädt ein Repository anhand von Besitzer- und Repository-Namen.
 * Vergleiche laufen über die kleingeschriebenen Spalten, damit
 * "Foo/Bar" und "foo/bar" dasselbe Repository treffen.
 */
export async function loadRepository(
  ownerName: string,
  repoName: string,
): Promise<RepositoryContext | null> {
  const rows = await db
    .select({
      repository: repositories,
      ownerName: namespaces.name,
      ownerKind: namespaces.kind,
      organizationId: organizations.id,
    })
    .from(repositories)
    .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
    .leftJoin(organizations, eq(organizations.namespaceId, namespaces.id))
    .where(
      and(
        eq(namespaces.nameLower, ownerName.toLowerCase()),
        eq(repositories.nameLower, repoName.toLowerCase()),
        isNull(repositories.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    repository: row.repository,
    ownerName: row.ownerName,
    ownerKind: row.ownerKind,
    organizationId: row.organizationId,
  };
}

/**
 * Berechnet die Zugriffsstufe eines (optional anonymen) Benutzers auf ein
 * Repository.
 */
export async function resolveRepositoryAccess(
  context: RepositoryContext,
  viewer: { id: string; isAdmin: boolean } | null,
): Promise<ResolvedAccess> {
  const { repository, organizationId } = context;

  // 1. Plattform-Administratoren haben vollen Zugriff. Jeder solche Zugriff
  //    wird an der aufrufenden Stelle im Audit-Log vermerkt.
  if (viewer?.isAdmin) {
    return { ...context, level: 'admin', isAnonymousRead: false };
  }

  // 6a. Ausgangspunkt: was die Sichtbarkeit jedem erlaubt.
  let level: AccessLevel = 'none';
  if (repository.visibility === 'public') {
    level = 'read';
  } else if (repository.visibility === 'internal' && viewer) {
    // "internal" = sichtbar für alle angemeldeten Benutzer der Instanz.
    level = 'read';
  }

  if (!viewer) {
    return { ...context, level, isAnonymousRead: level !== 'none' };
  }

  // 2. Persönliches Repository des Benutzers.
  if (context.ownerKind === 'user') {
    const ownerRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.namespaceId, repository.ownerNamespaceId))
      .limit(1);
    if (ownerRows[0]?.id === viewer.id) {
      return { ...context, level: 'admin', isAnonymousRead: false };
    }
  }

  // 3. Rolle in der besitzenden Organisation.
  if (organizationId) {
    const memberRows = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, viewer.id),
        ),
      )
      .limit(1);

    const role = memberRows[0]?.role;
    if (role === 'owner' || role === 'admin') {
      return { ...context, level: 'admin', isAnonymousRead: false };
    }
    if (role === 'member') {
      // Mitglieder sehen private Repositories ihrer Organisation nicht
      // automatisch – der Zugriff muss über Team oder Kollaboration kommen.
      // Interne Repositories sind für sie aber lesbar.
      if (repository.visibility === 'internal') {
        level = maxAccess(level, 'read');
      }
    }
  }

  // 4. Direkte Kollaboration.
  const collabRows = await db
    .select({ permission: repositoryCollaborators.permission })
    .from(repositoryCollaborators)
    .where(
      and(
        eq(repositoryCollaborators.repositoryId, repository.id),
        eq(repositoryCollaborators.userId, viewer.id),
      ),
    )
    .limit(1);

  if (collabRows[0]) {
    level = maxAccess(level, collabRows[0].permission);
  }

  // 5. Team-Zuweisungen.
  if (organizationId) {
    const teamRows = await db
      .select({ permission: teamRepositories.permission })
      .from(teamRepositories)
      .innerJoin(teamMembers, eq(teamMembers.teamId, teamRepositories.teamId))
      .where(
        and(
          eq(teamRepositories.repositoryId, repository.id),
          eq(teamMembers.userId, viewer.id),
        ),
      );

    for (const row of teamRows) {
      level = maxAccess(level, row.permission);
    }
  }

  return { ...context, level, isAnonymousRead: false };
}

/**
 * Lädt ein Repository und prüft in einem Schritt, ob der Benutzer die
 * geforderte Stufe erreicht.
 *
 * Fehlt die Leseberechtigung, wird 404 geworfen (nicht 403) – andernfalls
 * verrät die Antwort, dass ein privates Repository unter diesem Namen
 * existiert.
 */
export async function requireRepositoryAccess(
  ownerName: string,
  repoName: string,
  viewer: { id: string; isAdmin: boolean } | null,
  required: AccessLevel,
): Promise<ResolvedAccess> {
  const context = await loadRepository(ownerName, repoName);
  if (!context) throw notFound('Repository nicht gefunden.');

  const access = await resolveRepositoryAccess(context, viewer);

  if (!hasAccess(access.level, 'read')) {
    throw notFound('Repository nicht gefunden.');
  }
  if (!hasAccess(access.level, required)) {
    throw forbidden('Für diese Aktion fehlen dir die nötigen Rechte in diesem Repository.');
  }

  // Archivierte Repositories sind strikt schreibgeschützt. Diese Prüfung hier
  // zu verankern verhindert, dass einzelne Routen sie übersehen.
  if (access.repository.isArchived && hasAccess(required, 'write')) {
    throw forbidden('Dieses Repository ist archiviert und schreibgeschützt.');
  }

  return access;
}

/**
 * Liefert eine SQL-Bedingung, die eine Repository-Abfrage auf die für den
 * Benutzer sichtbaren Einträge einschränkt.
 *
 * Wird von allen Listen- und Suchendpunkten verwendet. Dadurch ist die Regel
 * "private Repositories erscheinen nie für Unberechtigte" an einer Stelle
 * formuliert und nicht in jeder Query neu.
 */
export function visibleRepositoriesFilter(viewer: { id: string; isAdmin: boolean } | null) {
  if (viewer?.isAdmin) {
    return isNull(repositories.deletedAt);
  }

  if (!viewer) {
    return and(isNull(repositories.deletedAt), eq(repositories.visibility, 'public'));
  }

  // Sichtbar sind: öffentliche, interne (für Angemeldete) sowie alle, auf die
  // der Benutzer über Besitz, Kollaboration oder Team Zugriff hat.
  return and(
    isNull(repositories.deletedAt),
    sql`(
      ${repositories.visibility} IN ('public', 'internal')
      OR ${repositories.ownerNamespaceId} = (
        SELECT ${users.namespaceId} FROM ${users} WHERE ${users.id} = ${viewer.id}
      )
      OR EXISTS (
        SELECT 1 FROM ${repositoryCollaborators}
        WHERE ${repositoryCollaborators.repositoryId} = ${repositories.id}
          AND ${repositoryCollaborators.userId} = ${viewer.id}
      )
      OR EXISTS (
        SELECT 1 FROM ${teamRepositories}
        JOIN ${teamMembers} ON ${teamMembers.teamId} = ${teamRepositories.teamId}
        WHERE ${teamRepositories.repositoryId} = ${repositories.id}
          AND ${teamMembers.userId} = ${viewer.id}
      )
      OR EXISTS (
        SELECT 1 FROM ${organizations}
        JOIN ${organizationMembers} ON ${organizationMembers.organizationId} = ${organizations.id}
        WHERE ${organizations.namespaceId} = ${repositories.ownerNamespaceId}
          AND ${organizationMembers.userId} = ${viewer.id}
          AND ${organizationMembers.role} IN ('owner', 'admin')
      )
    )`,
  );
}

// ---------------------------------------------------------------------------
// Organisationen
// ---------------------------------------------------------------------------

export type OrgRoleResult = 'owner' | 'admin' | 'member' | null;

export async function getOrganizationRole(
  organizationId: string,
  userId: string | null,
): Promise<OrgRoleResult> {
  if (!userId) return null;
  const rows = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return rows[0]?.role ?? null;
}

const ORG_ROLE_RANK = { member: 1, admin: 2, owner: 3 } as const;

export async function requireOrganizationRole(
  organizationId: string,
  viewer: { id: string; isAdmin: boolean } | null,
  required: 'member' | 'admin' | 'owner',
): Promise<OrgRoleResult> {
  if (viewer?.isAdmin) return 'owner';
  if (!viewer) throw notFound('Organisation nicht gefunden.');

  const role = await getOrganizationRole(organizationId, viewer.id);
  if (!role) throw notFound('Organisation nicht gefunden.');
  if (ORG_ROLE_RANK[role] < ORG_ROLE_RANK[required]) {
    throw forbidden('Für diese Aktion fehlen dir die nötigen Rechte in dieser Organisation.');
  }
  return role;
}

/** Namespace-IDs, deren Repositories der Benutzer verwalten darf. */
export async function getOwnableNamespaceIds(userId: string): Promise<string[]> {
  const own = await db
    .select({ namespaceId: users.namespaceId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const orgs = await db
    .select({ namespaceId: organizations.namespaceId })
    .from(organizations)
    .innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
    .where(
      and(
        eq(organizationMembers.userId, userId),
        inArray(organizationMembers.role, ['owner', 'admin']),
      ),
    );

  const ids = new Set<string>();
  if (own[0]) ids.add(own[0].namespaceId);
  for (const org of orgs) ids.add(org.namespaceId);
  return [...ids];
}

/**
 * Lädt eine Organisation anhand ihres Namens.
 *
 * Liegt hier statt in den Routen, weil inzwischen mehrere Routendateien sie
 * brauchen und eine zweite Kopie unweigerlich auseinanderliefe.
 */
export async function loadOrganizationByName(name: string): Promise<{
  organization: typeof organizations.$inferSelect;
  namespace: typeof namespaces.$inferSelect;
}> {
  const rows = await db
    .select({ organization: organizations, namespace: namespaces })
    .from(organizations)
    .innerJoin(namespaces, eq(namespaces.id, organizations.namespaceId))
    .where(eq(namespaces.nameLower, name.toLowerCase()))
    .limit(1);

  if (!rows[0]) throw notFound('Organisation nicht gefunden.');
  return rows[0];
}
