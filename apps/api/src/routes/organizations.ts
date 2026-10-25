/**
 * Organisationen, Teams, Mitgliedschaften und Repository-Kollaborateure.
 *
 * Die Rechteprüfung selbst steht in services/permissions.ts und war von
 * Anfang an auf Organisationen und Teams ausgelegt – diese Routen füllen also
 * nur die Verwaltung auf, ohne dass sich am Zugriffsmodell etwas ändert.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  NAME_PATTERN,
  RESERVED_NAMES,
  TEAM_PERMISSIONS,
  type CollaboratorEntry,
  type OrganizationMember,
  type OrganizationSummary,
  type TeamSummary,
} from '@forge/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import {
  auditLogs,
  namespaces,
  organizationInvitations,
  organizationMembers,
  organizations,
  repositories,
  repositoryCollaborators,
  teamMembers,
  teamRepositories,
  teams,
  users,
} from '../db/schema.js';
import { conflict, forbidden, isUniqueViolation, notFound, validationFailed } from '../lib/errors.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import {
  getOrganizationRole,
  requireOrganizationRole,
  requireRepositoryAccess,
  visibleRepositoriesFilter,
} from '../services/permissions.js';
import { loadUserRefs, toUserRef } from '../services/issues.js';
import { toSummary } from '../services/repositories.js';
import { avatarUrl } from '../services/avatars.js';

export async function registerOrganizationRoutes(app: FastifyInstance): Promise<void> {
  /** Lädt eine Organisation anhand ihres Namens. */
  async function loadOrganization(name: string) {
    const rows = await db
      .select({ organization: organizations, namespace: namespaces })
      .from(organizations)
      .innerJoin(namespaces, eq(namespaces.id, organizations.namespaceId))
      .where(eq(namespaces.nameLower, name.toLowerCase()))
      .limit(1);

    if (!rows[0]) throw notFound('Organisation nicht gefunden.');
    return rows[0];
  }


  /**
   * Hält das Standardteam synchron.
   *
   * Die Rechteauflösung in services/permissions.ts geht über konkrete
   * Team-Mitgliedschaften. Damit das Team "Alle Mitglieder" tatsächlich
   * wirkt, bekommt es beim Beitritt eine echte Zeile – statt den
   * Sonderfall in die Zugriffsprüfung einzubauen, wo er leicht übersehen
   * würde.
   */
  async function syncAllMembersTeam(organizationId: string, userId: string): Promise<void> {
    const rows = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.organizationId, organizationId), eq(teams.isAllMembers, true)))
      .limit(1);

    if (!rows[0]) return;
    await db
      .insert(teamMembers)
      .values({ teamId: rows[0].id, userId })
      .onConflictDoNothing();
  }

  async function findUser(username: string) {
    const rows = await db
      .select({ id: users.id, username: namespaces.name })
      .from(users)
      .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
      .where(eq(namespaces.nameLower, username.toLowerCase()))
      .limit(1);
    if (!rows[0]) throw validationFailed(`Unbekannter Benutzer: ${username}`);
    return rows[0];
  }

  // -------------------------------------------------------------------------
  // Organisation anlegen
  // -------------------------------------------------------------------------
  app.post('/api/v1/organizations', async (request, reply) => {
    app.requireAuth(request);
    const input = z
      .object({
        name: z.string().min(1).max(39),
        displayName: z.string().max(100).nullish(),
        description: z.string().max(500).nullish(),
      })
      .parse(request.body);

    const name = input.name.trim();
    if (!NAME_PATTERN.test(name)) {
      throw validationFailed('Ungültiger Organisationsname.', { name: ['Ungültiges Format.'] });
    }
    if (RESERVED_NAMES.has(name.toLowerCase())) {
      throw validationFailed('Dieser Name ist reserviert.', { name: ['Reservierter Name.'] });
    }

    const created = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: namespaces.id })
        .from(namespaces)
        .where(eq(namespaces.nameLower, name.toLowerCase()))
        .limit(1);
      if (existing[0]) throw conflict('Dieser Name ist bereits vergeben.');

      const [namespace] = await tx
        .insert(namespaces)
        .values({ name, nameLower: name.toLowerCase(), kind: 'organization' })
        .returning();

      const [organization] = await tx
        .insert(organizations)
        .values({
          namespaceId: namespace!.id,
          displayName: input.displayName?.trim() || null,
          description: input.description?.trim() || null,
          createdById: request.viewer!.id,
        })
        .returning();

      // Der Ersteller wird Eigentümer, sonst wäre die Organisation sofort
      // unverwaltbar.
      await tx.insert(organizationMembers).values({
        organizationId: organization!.id,
        userId: request.viewer!.id,
        role: 'owner',
        isPublic: true,
      });

      // Ein Standardteam, das automatisch alle Mitglieder enthält. Es
      // vereinfacht die häufigste Rechtevergabe erheblich.
      await tx.insert(teams).values({
        organizationId: organization!.id,
        name: 'Alle Mitglieder',
        slug: 'alle',
        description: 'Enthält automatisch alle Mitglieder der Organisation.',
        defaultPermission: 'read',
        isAllMembers: true,
      });

      return { organization: organization!, namespace: namespace! };
    });

    await syncAllMembersTeam(created.organization.id, request.viewer!.id);

    await db.insert(auditLogs).values({
      actorId: request.viewer!.id,
      action: 'organization.created',
      targetType: 'organization',
      targetId: created.organization.id,
      organizationId: created.organization.id,
      metadata: { name },
    });

    reply.code(201);
    return { id: created.organization.id, name: created.namespace.name };
  });

  // -------------------------------------------------------------------------
  // Eigene Organisationen
  // -------------------------------------------------------------------------
  app.get('/api/v1/user/organizations', async (request) => {
    app.requireAuth(request);

    const rows = await db
      .select({
        organization: organizations,
        namespace: namespaces,
        role: organizationMembers.role,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .innerJoin(namespaces, eq(namespaces.id, organizations.namespaceId))
      .where(eq(organizationMembers.userId, request.viewer!.id))
      .orderBy(asc(namespaces.name));

    const items = await Promise.all(
      rows.map(async (row) => buildSummary(row.organization, row.namespace, row.role, request.viewer!.id)),
    );
    return { items };
  });

  async function buildSummary(
    organization: typeof organizations.$inferSelect,
    namespace: typeof namespaces.$inferSelect,
    role: 'owner' | 'admin' | 'member' | null,
    viewerId: string | null,
  ): Promise<OrganizationSummary> {
    const memberRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organization.id));

    const repoRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerNamespaceId, namespace.id),
          visibleRepositoriesFilter(viewerId ? { id: viewerId, isAdmin: false } : null),
        ),
      );

    return {
      id: organization.id,
      name: namespace.name,
      displayName: organization.displayName,
      description: organization.description,
      avatarUrl: avatarUrl(organization.avatarPath),
      memberCount: memberRows[0]?.count ?? 0,
      repositoryCount: repoRows[0]?.count ?? 0,
      viewerRole: role,
      createdAt: organization.createdAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Detail
  // -------------------------------------------------------------------------
  app.get<{ Params: { org: string } }>('/api/v1/organizations/:org', async (request) => {
    const { organization, namespace } = await loadOrganization(request.params.org);
    const role = await getOrganizationRole(organization.id, request.viewer?.id ?? null);
    return buildSummary(organization, namespace, role, request.viewer?.id ?? null);
  });

  app.patch<{ Params: { org: string } }>('/api/v1/organizations/:org', async (request) => {
    app.requireAuth(request);
    const input = z
      .object({
        displayName: z.string().max(100).nullish(),
        description: z.string().max(500).nullish(),
        websiteUrl: z.string().max(500).nullish(),
        location: z.string().max(100).nullish(),
        defaultRepoVisibility: z.enum(['public', 'private', 'internal']).optional(),
      })
      .parse(request.body);

    const { organization } = await loadOrganization(request.params.org);
    await requireOrganizationRole(organization.id, request.viewer, 'admin');

    await db
      .update(organizations)
      .set({
        ...(input.displayName !== undefined ? { displayName: input.displayName?.trim() || null } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
        ...(input.websiteUrl !== undefined ? { websiteUrl: input.websiteUrl?.trim() || null } : {}),
        ...(input.location !== undefined ? { location: input.location?.trim() || null } : {}),
        ...(input.defaultRepoVisibility !== undefined
          ? { defaultRepoVisibility: input.defaultRepoVisibility }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, organization.id));

    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Mitglieder
  // -------------------------------------------------------------------------
  app.get<{ Params: { org: string } }>('/api/v1/organizations/:org/members', async (request) => {
    const { organization } = await loadOrganization(request.params.org);
    const viewerRole = await getOrganizationRole(organization.id, request.viewer?.id ?? null);

    const rows = await db
      .select({
        userId: organizationMembers.userId,
        role: organizationMembers.role,
        isPublic: organizationMembers.isPublic,
        createdAt: organizationMembers.createdAt,
      })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organization.id))
      .orderBy(desc(organizationMembers.role), asc(organizationMembers.createdAt));

    // Nichtmitglieder sehen nur die öffentlich gemachten Mitgliedschaften.
    const visible = viewerRole ? rows : rows.filter((row) => row.isPublic);
    const refs = await loadUserRefs(visible.map((row) => row.userId));

    const items: OrganizationMember[] = visible
      .map((row) => {
        const user = refs.get(row.userId);
        if (!user) return null;
        return {
          user,
          role: row.role,
          isPublic: row.isPublic,
          joinedAt: row.createdAt.toISOString(),
        };
      })
      .filter((entry): entry is OrganizationMember => entry !== null);

    return { items, viewerRole };
  });

  app.put<{ Params: { org: string; username: string } }>(
    '/api/v1/organizations/:org/members/:username',
    async (request) => {
      app.requireAuth(request);
      const { role } = z
        .object({ role: z.enum(['member', 'admin', 'owner']).default('member') })
        .parse(request.body ?? {});

      const { organization } = await loadOrganization(request.params.org);
      const actorRole = await requireOrganizationRole(organization.id, request.viewer, 'admin');

      // Nur Eigentümer dürfen weitere Eigentümer ernennen; sonst könnte ein
      // Admin sich selbst zum Eigentümer machen.
      if (role === 'owner' && actorRole !== 'owner' && !request.viewer!.isAdmin) {
        throw forbidden('Nur Eigentümer können weitere Eigentümer ernennen.');
      }

      const target = await findUser(request.params.username);

      await db
        .insert(organizationMembers)
        .values({ organizationId: organization.id, userId: target.id, role })
        .onConflictDoUpdate({
          target: [organizationMembers.organizationId, organizationMembers.userId],
          set: { role },
        });

      await syncAllMembersTeam(organization.id, target.id);

      await db.insert(auditLogs).values({
        actorId: request.viewer!.id,
        action: 'organization.member_added',
        targetType: 'user',
        targetId: target.id,
        organizationId: organization.id,
        metadata: { role, username: target.username },
      });

      return { ok: true };
    },
  );

  app.delete<{ Params: { org: string; username: string } }>(
    '/api/v1/organizations/:org/members/:username',
    async (request) => {
      app.requireAuth(request);
      const { organization } = await loadOrganization(request.params.org);
      const target = await findUser(request.params.username);

      // Man darf sich selbst entfernen, sonst braucht es Adminrechte.
      if (target.id !== request.viewer!.id) {
        await requireOrganizationRole(organization.id, request.viewer, 'admin');
      }

      await db.transaction(async (tx) => {
        const owners = await tx
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.organizationId, organization.id),
              eq(organizationMembers.role, 'owner'),
            ),
          );

        // Eine Organisation ohne Eigentümer wäre nicht mehr verwaltbar.
        if (owners.length === 1 && owners[0]!.userId === target.id) {
          throw validationFailed(
            'Der letzte Eigentümer kann nicht entfernt werden. Ernenne zuerst einen anderen.',
          );
        }

        await tx
          .delete(organizationMembers)
          .where(
            and(
              eq(organizationMembers.organizationId, organization.id),
              eq(organizationMembers.userId, target.id),
            ),
          );

        // Mitgliedschaft weg heißt auch: raus aus allen Teams dieser
        // Organisation. Sonst behielte die Person über das Team weiter Zugriff.
        const orgTeams = await tx
          .select({ id: teams.id })
          .from(teams)
          .where(eq(teams.organizationId, organization.id));

        if (orgTeams.length > 0) {
          await tx.delete(teamMembers).where(
            and(
              eq(teamMembers.userId, target.id),
              inArray(
                teamMembers.teamId,
                orgTeams.map((t) => t.id),
              ),
            ),
          );
        }
      });

      await db.insert(auditLogs).values({
        actorId: request.viewer!.id,
        action: 'organization.member_removed',
        targetType: 'user',
        targetId: target.id,
        organizationId: organization.id,
        metadata: { username: target.username },
      });

      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Einladungen
  // -------------------------------------------------------------------------
  app.post<{ Params: { org: string } }>(
    '/api/v1/organizations/:org/invitations',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({
          username: z.string().max(39),
          role: z.enum(['member', 'admin']).default('member'),
        })
        .parse(request.body);

      const { organization, namespace } = await loadOrganization(request.params.org);
      await requireOrganizationRole(organization.id, request.viewer, 'admin');

      const target = await findUser(input.username);

      const existingMember = await getOrganizationRole(organization.id, target.id);
      if (existingMember) throw conflict('Diese Person ist bereits Mitglied.');

      const token = generateToken(24);
      const [invitation] = await db
        .insert(organizationInvitations)
        .values({
          organizationId: organization.id,
          inviteeId: target.id,
          role: input.role,
          invitedById: request.viewer!.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        })
        .returning();

      reply.code(201);
      return { id: invitation!.id, token };
    },
  );

  app.get('/api/v1/user/invitations', async (request) => {
    app.requireAuth(request);

    const rows = await db
      .select({
        invitation: organizationInvitations,
        organizationName: namespaces.name,
        displayName: organizations.displayName,
      })
      .from(organizationInvitations)
      .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
      .innerJoin(namespaces, eq(namespaces.id, organizations.namespaceId))
      .where(
        and(
          eq(organizationInvitations.inviteeId, request.viewer!.id),
          isNull(organizationInvitations.acceptedAt),
          isNull(organizationInvitations.declinedAt),
          gt(organizationInvitations.expiresAt, new Date()),
        ),
      );

    return {
      items: rows.map((row) => ({
        id: row.invitation.id,
        organizationName: row.organizationName,
        displayName: row.displayName,
        role: row.invitation.role,
        expiresAt: row.invitation.expiresAt.toISOString(),
      })),
    };
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/user/invitations/:id/accept',
    async (request) => {
      app.requireAuth(request);

      await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(organizationInvitations)
          .where(
            and(
              eq(organizationInvitations.id, request.params.id),
              // Die Zugehörigkeit zum anfragenden Benutzer gehört in die
              // Bedingung: sonst ließe sich eine fremde Einladung annehmen.
              eq(organizationInvitations.inviteeId, request.viewer!.id),
              isNull(organizationInvitations.acceptedAt),
              gt(organizationInvitations.expiresAt, new Date()),
            ),
          )
          .limit(1);

        const invitation = rows[0];
        if (!invitation) throw notFound('Einladung nicht gefunden oder abgelaufen.');

        await tx
          .insert(organizationMembers)
          .values({
            organizationId: invitation.organizationId,
            userId: request.viewer!.id,
            role: invitation.role,
          })
          .onConflictDoNothing();

        await tx
          .update(organizationInvitations)
          .set({ acceptedAt: new Date() })
          .where(eq(organizationInvitations.id, invitation.id));

        const allMembers = await tx
          .select({ id: teams.id })
          .from(teams)
          .where(
            and(eq(teams.organizationId, invitation.organizationId), eq(teams.isAllMembers, true)),
          )
          .limit(1);

        if (allMembers[0]) {
          await tx
            .insert(teamMembers)
            .values({ teamId: allMembers[0].id, userId: request.viewer!.id })
            .onConflictDoNothing();
        }
      });

      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/user/invitations/:id/decline',
    async (request) => {
      app.requireAuth(request);
      await db
        .update(organizationInvitations)
        .set({ declinedAt: new Date() })
        .where(
          and(
            eq(organizationInvitations.id, request.params.id),
            eq(organizationInvitations.inviteeId, request.viewer!.id),
          ),
        );
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Teams
  // -------------------------------------------------------------------------
  app.get<{ Params: { org: string } }>('/api/v1/organizations/:org/teams', async (request) => {
    const { organization } = await loadOrganization(request.params.org);
    // Teams sind interne Struktur; nur Mitglieder sehen sie.
    await requireOrganizationRole(organization.id, request.viewer, 'member');

    const rows = await db
      .select()
      .from(teams)
      .where(eq(teams.organizationId, organization.id))
      .orderBy(asc(teams.name));

    const items: TeamSummary[] = await Promise.all(
      rows.map(async (row) => {
        const memberCount = row.isAllMembers
          ? (
              await db
                .select({ count: sql<number>`count(*)` })
                .from(organizationMembers)
                .where(eq(organizationMembers.organizationId, organization.id))
            )[0]?.count ?? 0
          : (
              await db
                .select({ count: sql<number>`count(*)` })
                .from(teamMembers)
                .where(eq(teamMembers.teamId, row.id))
            )[0]?.count ?? 0;

        const repoCount =
          (
            await db
              .select({ count: sql<number>`count(*)` })
              .from(teamRepositories)
              .where(eq(teamRepositories.teamId, row.id))
          )[0]?.count ?? 0;

        return {
          id: row.id,
          name: row.name,
          slug: row.slug,
          description: row.description,
          defaultPermission: row.defaultPermission,
          memberCount,
          repositoryCount: repoCount,
        };
      }),
    );

    return { items };
  });

  app.post<{ Params: { org: string } }>(
    '/api/v1/organizations/:org/teams',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({
          name: z.string().min(1).max(100),
          description: z.string().max(500).nullish(),
          defaultPermission: z.enum(TEAM_PERMISSIONS).default('read'),
        })
        .parse(request.body);

      const { organization } = await loadOrganization(request.params.org);
      await requireOrganizationRole(organization.id, request.viewer, 'admin');

      const slug = input.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      if (!slug) throw validationFailed('Aus dem Namen lässt sich kein Kürzel bilden.');

      try {
        const [created] = await db
          .insert(teams)
          .values({
            organizationId: organization.id,
            name: input.name.trim(),
            slug,
            description: input.description?.trim() || null,
            defaultPermission: input.defaultPermission,
          })
          .returning();

        reply.code(201);
        return { id: created!.id, slug: created!.slug };
      } catch (error) {
        if (isUniqueViolation(error, 'teams_org_slug_key', 'teams.slug')) {
          throw conflict('Ein Team mit diesem Namen existiert bereits.');
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { org: string; slug: string } }>(
    '/api/v1/organizations/:org/teams/:slug',
    async (request) => {
      app.requireAuth(request);
      const { organization } = await loadOrganization(request.params.org);
      await requireOrganizationRole(organization.id, request.viewer, 'admin');

      const team = await findTeam(organization.id, request.params.slug);
      if (team.isAllMembers) {
        throw validationFailed('Das Standardteam kann nicht gelöscht werden.');
      }

      await db.delete(teams).where(eq(teams.id, team.id));
      return { ok: true };
    },
  );

  async function findTeam(organizationId: string, slug: string) {
    const rows = await db
      .select()
      .from(teams)
      .where(and(eq(teams.organizationId, organizationId), eq(teams.slug, slug.toLowerCase())))
      .limit(1);
    if (!rows[0]) throw notFound('Team nicht gefunden.');
    return rows[0];
  }

  app.get<{ Params: { org: string; slug: string } }>(
    '/api/v1/organizations/:org/teams/:slug/members',
    async (request) => {
      const { organization } = await loadOrganization(request.params.org);
      await requireOrganizationRole(organization.id, request.viewer, 'member');
      const team = await findTeam(organization.id, request.params.slug);

      // Das Standardteam hat keine eigene Mitgliederliste – es ist definiert
      // als "alle Mitglieder der Organisation".
      const rows = team.isAllMembers
        ? await db
            .select({ userId: organizationMembers.userId, isMaintainer: sql<boolean>`0`.mapWith(Boolean) })
            .from(organizationMembers)
            .where(eq(organizationMembers.organizationId, organization.id))
        : await db
            .select({ userId: teamMembers.userId, isMaintainer: teamMembers.isMaintainer })
            .from(teamMembers)
            .where(eq(teamMembers.teamId, team.id));

      const refs = await loadUserRefs(rows.map((r) => r.userId));

      return {
        items: rows
          .map((row) => {
            const user = refs.get(row.userId);
            return user ? { user, isMaintainer: row.isMaintainer } : null;
          })
          .filter(Boolean),
        isAllMembers: team.isAllMembers,
      };
    },
  );

  app.put<{ Params: { org: string; slug: string; username: string } }>(
    '/api/v1/organizations/:org/teams/:slug/members/:username',
    async (request) => {
      app.requireAuth(request);
      const { organization } = await loadOrganization(request.params.org);
      await requireOrganizationRole(organization.id, request.viewer, 'admin');
      const team = await findTeam(organization.id, request.params.slug);

      if (team.isAllMembers) {
        throw validationFailed(
          'Das Standardteam enthält automatisch alle Mitglieder und wird nicht von Hand gepflegt.',
        );
      }

      const target = await findUser(request.params.username);

      // Nur wer in der Organisation ist, kann in ein Team ihrer Teams.
      const role = await getOrganizationRole(organization.id, target.id);
      if (!role) {
        throw validationFailed('Diese Person ist kein Mitglied der Organisation.');
      }

      await db
        .insert(teamMembers)
        .values({ teamId: team.id, userId: target.id })
        .onConflictDoNothing();

      return { ok: true };
    },
  );

  app.delete<{ Params: { org: string; slug: string; username: string } }>(
    '/api/v1/organizations/:org/teams/:slug/members/:username',
    async (request) => {
      app.requireAuth(request);
      const { organization } = await loadOrganization(request.params.org);
      await requireOrganizationRole(organization.id, request.viewer, 'admin');
      const team = await findTeam(organization.id, request.params.slug);
      const target = await findUser(request.params.username);

      await db
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, target.id)));

      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Team-Zugriff auf Repositories
  // -------------------------------------------------------------------------
  app.put<{ Params: { org: string; slug: string } }>(
    '/api/v1/organizations/:org/teams/:slug/repositories',
    async (request) => {
      app.requireAuth(request);
      const input = z
        .object({
          repository: z.string().min(1).max(100),
          permission: z.enum(TEAM_PERMISSIONS).default('read'),
        })
        .parse(request.body);

      const { organization, namespace } = await loadOrganization(request.params.org);
      await requireOrganizationRole(organization.id, request.viewer, 'admin');
      const team = await findTeam(organization.id, request.params.slug);

      // Ein Team darf nur auf Repositories der eigenen Organisation
      // berechtigt werden.
      const repoRows = await db
        .select({ id: repositories.id })
        .from(repositories)
        .where(
          and(
            eq(repositories.ownerNamespaceId, namespace.id),
            eq(repositories.nameLower, input.repository.toLowerCase()),
            isNull(repositories.deletedAt),
          ),
        )
        .limit(1);

      if (!repoRows[0]) throw notFound('Repository nicht gefunden.');

      await db
        .insert(teamRepositories)
        .values({
          teamId: team.id,
          repositoryId: repoRows[0].id,
          permission: input.permission,
        })
        .onConflictDoUpdate({
          target: [teamRepositories.teamId, teamRepositories.repositoryId],
          set: { permission: input.permission },
        });

      return { ok: true };
    },
  );

  app.delete<{ Params: { org: string; slug: string; repo: string } }>(
    '/api/v1/organizations/:org/teams/:slug/repositories/:repo',
    async (request) => {
      app.requireAuth(request);
      const { organization, namespace } = await loadOrganization(request.params.org);
      await requireOrganizationRole(organization.id, request.viewer, 'admin');
      const team = await findTeam(organization.id, request.params.slug);

      const repoRows = await db
        .select({ id: repositories.id })
        .from(repositories)
        .where(
          and(
            eq(repositories.ownerNamespaceId, namespace.id),
            eq(repositories.nameLower, request.params.repo.toLowerCase()),
          ),
        )
        .limit(1);

      if (repoRows[0]) {
        await db
          .delete(teamRepositories)
          .where(
            and(
              eq(teamRepositories.teamId, team.id),
              eq(teamRepositories.repositoryId, repoRows[0].id),
            ),
          );
      }
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Kollaborateure eines Repositories
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/collaborators',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'maintain',
      );

      const direct = await db
        .select({
          userId: repositoryCollaborators.userId,
          permission: repositoryCollaborators.permission,
        })
        .from(repositoryCollaborators)
        .where(eq(repositoryCollaborators.repositoryId, access.repository.id));

      const viaTeams = await db
        .select({
          userId: teamMembers.userId,
          permission: teamRepositories.permission,
          teamName: teams.name,
        })
        .from(teamRepositories)
        .innerJoin(teams, eq(teams.id, teamRepositories.teamId))
        .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
        .where(eq(teamRepositories.repositoryId, access.repository.id));

      const refs = await loadUserRefs([
        ...direct.map((d) => d.userId),
        ...viaTeams.map((t) => t.userId),
      ]);

      const items: CollaboratorEntry[] = [];

      for (const row of direct) {
        const user = refs.get(row.userId);
        if (user) items.push({ user, permission: row.permission, source: 'direct' });
      }
      for (const row of viaTeams) {
        const user = refs.get(row.userId);
        if (user) items.push({ user, permission: row.permission, source: row.teamName });
      }

      return { items };
    },
  );

  app.put<{ Params: { owner: string; repo: string; username: string } }>(
    '/api/v1/repos/:owner/:repo/collaborators/:username',
    async (request) => {
      app.requireAuth(request);
      const { permission } = z
        .object({ permission: z.enum(TEAM_PERMISSIONS).default('write') })
        .parse(request.body ?? {});

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );
      const target = await findUser(request.params.username);

      await db
        .insert(repositoryCollaborators)
        .values({ repositoryId: access.repository.id, userId: target.id, permission })
        .onConflictDoUpdate({
          target: [repositoryCollaborators.repositoryId, repositoryCollaborators.userId],
          set: { permission },
        });

      await db.insert(auditLogs).values({
        actorId: request.viewer!.id,
        action: 'repository.collaborator_added',
        targetType: 'user',
        targetId: target.id,
        repositoryId: access.repository.id,
        metadata: { permission, username: target.username },
      });

      return { ok: true };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; username: string } }>(
    '/api/v1/repos/:owner/:repo/collaborators/:username',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'admin',
      );
      const target = await findUser(request.params.username);

      await db
        .delete(repositoryCollaborators)
        .where(
          and(
            eq(repositoryCollaborators.repositoryId, access.repository.id),
            eq(repositoryCollaborators.userId, target.id),
          ),
        );

      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Repositories einer Organisation
  // -------------------------------------------------------------------------
  app.get<{ Params: { org: string } }>(
    '/api/v1/organizations/:org/repositories',
    async (request) => {
      const { namespace } = await loadOrganization(request.params.org);

      const rows = await db
        .select({ repository: repositories })
        .from(repositories)
        .where(
          and(
            eq(repositories.ownerNamespaceId, namespace.id),
            visibleRepositoriesFilter(request.viewer),
          ),
        )
        .orderBy(desc(repositories.updatedAt))
        .limit(100);

      return {
        items: rows.map((row) => toSummary(row.repository, namespace.name, 'organization')),
      };
    },
  );
}
