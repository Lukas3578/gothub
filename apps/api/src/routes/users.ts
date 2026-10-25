/**
 * Benutzerprofile, Einstellungen und API-Tokens.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { NAME_PATTERN, RESERVED_NAMES, type UserProfile } from '@forge/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import {
  apiTokens,
  auditLogs,
  follows,
  namespaces,
  notificationSettings,
  repositories,
  userBlocks,
  users,
} from '../db/schema.js';
import { conflict, forbidden, isUniqueViolation, notFound, validationFailed } from '../lib/errors.js';
import { visibleRepositoriesFilter } from '../services/permissions.js';
import {
  beginTwoFactorSetup,
  confirmTwoFactorSetup,
  createApiToken,
  disableTwoFactor,
} from '../services/auth.js';
import { avatarUrl } from '../services/avatars.js';
import {
  addKey as addSshKey,
  listKeys as listSshKeys,
  removeKey as removeSshKey,
} from '../services/ssh-keys.js';

const profileUpdateSchema = z.object({
  displayName: z.string().max(100).nullish(),
  bio: z.string().max(500).nullish(),
  company: z.string().max(100).nullish(),
  location: z.string().max(100).nullish(),
  websiteUrl: z.string().max(500).nullish(),
  emailPublic: z.boolean().optional(),
  socialLinks: z
    .array(z.object({ label: z.string().max(50), url: z.string().url().max(500) }))
    .max(8)
    .optional(),
});

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  // -- Öffentliches Profil --------------------------------------------------
  app.get<{ Params: { username: string } }>('/api/v1/users/:username', async (request) => {
    const rows = await db
      .select({ user: users, namespace: namespaces })
      .from(users)
      .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
      .where(eq(namespaces.nameLower, request.params.username.toLowerCase()))
      .limit(1);

    const row = rows[0];
    if (!row) throw notFound('Benutzer nicht gefunden.');

    const repositoryCountRows = await db
      .select({ repositoryCount: sql<number>`count(*)` })
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerNamespaceId, row.namespace.id),
          visibleRepositoriesFilter(request.viewer),
        ),
      );

    const followerCountRows = await db
      .select({ followerCount: sql<number>`count(*)` })
      .from(follows)
      .where(eq(follows.followingId, row.user.id));

    const followingCountRows = await db
      .select({ followingCount: sql<number>`count(*)` })
      .from(follows)
      .where(eq(follows.followerId, row.user.id));

    const profile: UserProfile = {
      id: row.user.id,
      username: row.namespace.name,
      displayName: row.user.displayName,
      avatarUrl: avatarUrl(row.user.avatarPath),
      bio: row.user.bio,
      company: row.user.company,
      location: row.user.location,
      websiteUrl: row.user.websiteUrl,
      socialLinks: row.user.socialLinks,
      // Die E-Mail erscheint nur, wenn der Benutzer das ausdrücklich erlaubt
      // hat oder es sich um das eigene Profil handelt.
      email:
        row.user.emailPublic || request.viewer?.id === row.user.id ? row.user.email : null,
      isAdmin: row.user.isAdmin,
      createdAt: row.user.createdAt.toISOString(),
      repositoryCount: repositoryCountRows[0]?.repositoryCount ?? 0,
      followerCount: followerCountRows[0]?.followerCount ?? 0,
      followingCount: followingCountRows[0]?.followingCount ?? 0,
    };

    return profile;
  });

  // -- Eigenes Profil bearbeiten -------------------------------------------
  app.patch('/api/v1/user/profile', async (request) => {
    app.requireAuth(request);
    const input = profileUpdateSchema.parse(request.body);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.displayName !== undefined) patch.displayName = input.displayName?.trim() || null;
    if (input.bio !== undefined) patch.bio = input.bio?.trim() || null;
    if (input.company !== undefined) patch.company = input.company?.trim() || null;
    if (input.location !== undefined) patch.location = input.location?.trim() || null;
    if (input.websiteUrl !== undefined) patch.websiteUrl = input.websiteUrl?.trim() || null;
    if (input.emailPublic !== undefined) patch.emailPublic = input.emailPublic;
    if (input.socialLinks !== undefined) {
      // Nur http(s) zulassen: javascript:-URLs im Profil wären eine
      // XSS-Quelle, sobald sie irgendwo verlinkt werden.
      patch.socialLinks = input.socialLinks.filter((link) =>
        /^https?:\/\//i.test(link.url),
      );
    }

    await db.update(users).set(patch).where(eq(users.id, request.viewer!.id));
    return { ok: true };
  });

  // -- Benutzernamen ändern -------------------------------------------------
  app.post('/api/v1/user/username', async (request) => {
    app.requireAuth(request);
    const { username } = z.object({ username: z.string().min(1).max(39) }).parse(request.body);

    const trimmed = username.trim();
    if (!NAME_PATTERN.test(trimmed)) {
      throw validationFailed('Ungültiger Benutzername.', { username: ['Ungültiges Format.'] });
    }
    if (RESERVED_NAMES.has(trimmed.toLowerCase())) {
      throw validationFailed('Dieser Name ist reserviert.', { username: ['Reservierter Name.'] });
    }

    try {
      await db
        .update(namespaces)
        .set({ name: trimmed, nameLower: trimmed.toLowerCase() })
        .where(eq(namespaces.id, request.viewer!.namespaceId));
    } catch (error) {
      if (isUniqueViolation(error, 'namespaces_name_lower_key', 'namespaces.name_lower')) {
        throw conflict('Dieser Benutzername ist bereits vergeben.');
      }
      throw error;
    }

    await db.insert(auditLogs).values({
      actorId: request.viewer!.id,
      action: 'user.username_changed',
      targetType: 'user',
      targetId: request.viewer!.id,
      metadata: { from: request.viewer!.username, to: trimmed },
    });

    return { ok: true, username: trimmed };
  });

  // -- Benachrichtigungseinstellungen --------------------------------------
  app.get('/api/v1/user/notification-settings', async (request) => {
    app.requireAuth(request);
    const [row] = await db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.userId, request.viewer!.id))
      .limit(1);

    if (!row) {
      const [created] = await db
        .insert(notificationSettings)
        .values({ userId: request.viewer!.id })
        .returning();
      return created;
    }
    return row;
  });

  app.patch('/api/v1/user/notification-settings', async (request) => {
    app.requireAuth(request);
    const input = z
      .object({
        emailOnMention: z.boolean().optional(),
        emailOnReviewRequest: z.boolean().optional(),
        emailOnAssign: z.boolean().optional(),
        emailOnWorkflowFailure: z.boolean().optional(),
        autoWatchOnAccess: z.boolean().optional(),
      })
      .parse(request.body);

    await db
      .insert(notificationSettings)
      .values({ userId: request.viewer!.id, ...input })
      .onConflictDoUpdate({
        target: notificationSettings.userId,
        set: { ...input, updatedAt: new Date() },
      });

    return { ok: true };
  });

  // -- API-Tokens -----------------------------------------------------------
  app.get('/api/v1/user/tokens', async (request) => {
    app.requireAuth(request);
    const rows = await db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        tokenPrefix: apiTokens.tokenPrefix,
        lastUsedAt: apiTokens.lastUsedAt,
        expiresAt: apiTokens.expiresAt,
        createdAt: apiTokens.createdAt,
      })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, request.viewer!.id), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt));

    return { items: rows };
  });

  app.post('/api/v1/user/tokens', async (request, reply) => {
    app.requireAuth(request);
    const input = z
      .object({
        name: z.string().min(1).max(100),
        expiresInDays: z.number().int().min(1).max(365).nullish(),
      })
      .parse(request.body);

    const created = await createApiToken(
      request.viewer!.id,
      input.name,
      input.expiresInDays ?? null,
    );

    await db.insert(auditLogs).values({
      actorId: request.viewer!.id,
      action: 'user.token_created',
      targetType: 'api_token',
      targetId: created.id,
      metadata: { name: input.name },
    });

    reply.code(201);
    // Das Klartext-Token wird genau einmal zurückgegeben – danach existiert
    // nur noch sein Hash.
    return { id: created.id, token: created.token };
  });

  app.delete<{ Params: { id: string } }>('/api/v1/user/tokens/:id', async (request) => {
    app.requireAuth(request);
    await db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, request.params.id), eq(apiTokens.userId, request.viewer!.id)));
    return { ok: true };
  });

  // -- Zwei-Faktor-Authentifizierung ---------------------------------------
  app.post('/api/v1/user/two-factor/setup', async (request) => {
    app.requireAuth(request);
    const { secret, otpauthUrl } = await beginTwoFactorSetup(
      request.viewer!.id,
      request.viewer!.username,
    );

    const QRCode = (await import('qrcode')).default;
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 });

    return { secret, otpauthUrl, qrDataUrl };
  });

  app.post('/api/v1/user/two-factor/confirm', async (request) => {
    app.requireAuth(request);
    const { code } = z.object({ code: z.string().min(6).max(10) }).parse(request.body);
    const recoveryCodes = await confirmTwoFactorSetup(request.viewer!.id, code);

    await db.insert(auditLogs).values({
      actorId: request.viewer!.id,
      action: 'user.two_factor_enabled',
      targetType: 'user',
      targetId: request.viewer!.id,
    });

    return { ok: true, recoveryCodes };
  });

  app.post('/api/v1/user/two-factor/disable', async (request) => {
    app.requireAuth(request);
    const { password } = z.object({ password: z.string().min(1) }).parse(request.body);
    await disableTwoFactor(request.viewer!.id, password);

    await db.insert(auditLogs).values({
      actorId: request.viewer!.id,
      action: 'user.two_factor_disabled',
      targetType: 'user',
      targetId: request.viewer!.id,
    });

    return { ok: true };
  });

  // -- Folgen und Blockieren ------------------------------------------------
  app.put<{ Params: { username: string } }>(
    '/api/v1/users/:username/follow',
    async (request) => {
      app.requireAuth(request);
      const target = await findUserByName(request.params.username);
      if (target.id === request.viewer!.id) {
        throw validationFailed('Du kannst dir nicht selbst folgen.');
      }
      await db
        .insert(follows)
        .values({ followerId: request.viewer!.id, followingId: target.id })
        .onConflictDoNothing();
      return { ok: true, following: true };
    },
  );

  app.delete<{ Params: { username: string } }>(
    '/api/v1/users/:username/follow',
    async (request) => {
      app.requireAuth(request);
      const target = await findUserByName(request.params.username);
      await db
        .delete(follows)
        .where(
          and(eq(follows.followerId, request.viewer!.id), eq(follows.followingId, target.id)),
        );
      return { ok: true, following: false };
    },
  );

  app.put<{ Params: { username: string } }>('/api/v1/users/:username/block', async (request) => {
    app.requireAuth(request);
    const input = z.object({ reason: z.string().max(500).optional() }).parse(request.body ?? {});
    const target = await findUserByName(request.params.username);

    if (target.id === request.viewer!.id) {
      throw validationFailed('Du kannst dich nicht selbst blockieren.');
    }

    await db.transaction(async (tx) => {
      await tx
        .insert(userBlocks)
        .values({
          blockerId: request.viewer!.id,
          blockedId: target.id,
          reason: input.reason ?? null,
        })
        .onConflictDoNothing();

      // Eine Blockierung hebt eine bestehende Folge-Beziehung in beide
      // Richtungen auf – sonst bliebe der Blockierte im Feed sichtbar.
      await tx
        .delete(follows)
        .where(
          sql`(${follows.followerId} = ${request.viewer!.id} AND ${follows.followingId} = ${target.id})
              OR (${follows.followerId} = ${target.id} AND ${follows.followingId} = ${request.viewer!.id})`,
        );
    });

    return { ok: true, blocked: true };
  });

  app.delete<{ Params: { username: string } }>(
    '/api/v1/users/:username/block',
    async (request) => {
      app.requireAuth(request);
      const target = await findUserByName(request.params.username);
      await db
        .delete(userBlocks)
        .where(
          and(eq(userBlocks.blockerId, request.viewer!.id), eq(userBlocks.blockedId, target.id)),
        );
      return { ok: true, blocked: false };
    },
  );

  // -- SSH-Schlüssel --------------------------------------------------------
  app.get('/api/v1/user/ssh-keys', async (request) => {
    app.requireAuth(request);
    return { items: await listSshKeys(request.viewer!.id), sshEnabled: config.ssh.enabled };
  });

  app.post('/api/v1/user/ssh-keys', async (request, reply) => {
    app.requireAuth(request);
    const input = z
      .object({ title: z.string().max(100).default(''), key: z.string().min(10).max(16384) })
      .parse(request.body);

    const created = await addSshKey(request.viewer!.id, input.title, input.key);

    await db.insert(auditLogs).values({
      actorId: request.viewer!.id,
      action: 'user.ssh_key_added',
      targetType: 'ssh_key',
      targetId: created.id,
      metadata: { fingerprint: created.fingerprint, type: created.type },
    });

    reply.code(201);
    return created;
  });

  app.delete<{ Params: { id: string } }>('/api/v1/user/ssh-keys/:id', async (request) => {
    app.requireAuth(request);
    await removeSshKey(request.viewer!.id, request.params.id);

    await db.insert(auditLogs).values({
      actorId: request.viewer!.id,
      action: 'user.ssh_key_removed',
      targetType: 'ssh_key',
      targetId: request.params.id,
    });

    return { ok: true };
  });
}

async function findUserByName(username: string) {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
    .where(eq(namespaces.nameLower, username.toLowerCase()))
    .limit(1);
  if (!rows[0]) throw notFound('Benutzer nicht gefunden.');
  return rows[0];
}
