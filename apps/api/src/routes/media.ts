/**
 * Profilbilder hochladen, entfernen und ausliefern.
 *
 * Der Upload nimmt den rohen Anfragekörper entgegen statt eines
 * Multipart-Formulars: ein einzelnes Bild braucht keine Feldstruktur, und der
 * rohe Strom lässt sich ohne Zwischenpuffer begrenzen.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { auditLogs, organizations, users } from '../db/schema.js';
import { notFound, payloadTooLarge } from '../lib/errors.js';
import { readAvatar, removeAvatar, storeAvatar } from '../services/avatars.js';
import { loadOrganizationByName, requireOrganizationRole } from '../services/permissions.js';

/**
 * Liest den Anfragekörper mit harter Obergrenze.
 *
 * Die Grenze greift während des Lesens, nicht danach: ein Upload von 500 MB
 * soll den Speicher nicht erst füllen, bevor er abgewiesen wird.
 */
async function readLimitedBody(request: FastifyRequest, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request.raw) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limit) {
      request.raw.destroy();
      throw payloadTooLarge(`Das Bild darf höchstens ${Math.round(limit / 1024)} KB groß sein.`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

export async function registerMediaRoutes(app: FastifyInstance): Promise<void> {
  // Bilder kommen als roher Binärstrom; Fastify darf sie nicht parsen.
  // `application/octet-stream` ist bereits in app.ts registriert und fehlt
  // hier deshalb – eine zweite Registrierung desselben Typs lehnt Fastify ab.
  app.addContentTypeParser(
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    (_request, payload, done) => done(null, payload),
  );

  // -------------------------------------------------------------------------
  // Auslieferung
  // -------------------------------------------------------------------------
  app.get<{ Params: { '*': string } }>('/media/*', async (request, reply) => {
    const key = request.params['*'] ?? '';
    const avatar = await readAvatar(key);
    if (!avatar) throw notFound('Bild nicht gefunden.');

    return reply
      .header('Content-Type', avatar.contentType)
      // Der Schlüssel ist zufällig und ändert sich bei jedem neuen Bild,
      // deshalb kann unbegrenzt zwischengespeichert werden.
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(avatar.buffer);
  });

  // -------------------------------------------------------------------------
  // Benutzer-Avatar
  // -------------------------------------------------------------------------
  app.post('/api/v1/user/avatar', async (request) => {
    app.requireAuth(request);

    const buffer = await readLimitedBody(request, config.uploads.maxAvatarBytes);
    const stored = await storeAvatar(buffer);

    const [previous] = await db
      .select({ avatarPath: users.avatarPath })
      .from(users)
      .where(eq(users.id, request.viewer!.id))
      .limit(1);

    await db
      .update(users)
      .set({ avatarPath: stored.storageKey, updatedAt: new Date() })
      .where(eq(users.id, request.viewer!.id));

    // Erst nach dem erfolgreichen Wechsel aufräumen: schlägt das Schreiben
    // fehl, bleibt das alte Bild erhalten statt beides zu verlieren.
    await removeAvatar(previous?.avatarPath ?? null);

    await db.insert(auditLogs).values({
      actorId: request.viewer!.id,
      action: 'user.avatar_changed',
      targetType: 'user',
      targetId: request.viewer!.id,
    });

    return { ok: true, avatarUrl: `${config.server.publicApiUrl}/media/${stored.storageKey}` };
  });

  app.delete('/api/v1/user/avatar', async (request) => {
    app.requireAuth(request);

    const [previous] = await db
      .select({ avatarPath: users.avatarPath })
      .from(users)
      .where(eq(users.id, request.viewer!.id))
      .limit(1);

    await db.update(users).set({ avatarPath: null }).where(eq(users.id, request.viewer!.id));
    await removeAvatar(previous?.avatarPath ?? null);

    return { ok: true, avatarUrl: null };
  });

  // -------------------------------------------------------------------------
  // Organisations-Avatar
  // -------------------------------------------------------------------------
  app.post<{ Params: { org: string } }>('/api/v1/organizations/:org/avatar', async (request) => {
    app.requireAuth(request);

    const { organization } = await loadOrganizationByName(request.params.org);
    await requireOrganizationRole(organization.id, request.viewer, 'admin');

    const buffer = await readLimitedBody(request, config.uploads.maxAvatarBytes);
    const stored = await storeAvatar(buffer);

    await db
      .update(organizations)
      .set({ avatarPath: stored.storageKey, updatedAt: new Date() })
      .where(eq(organizations.id, organization.id));

    await removeAvatar(organization.avatarPath);

    await db.insert(auditLogs).values({
      actorId: request.viewer!.id,
      action: 'organization.avatar_changed',
      targetType: 'organization',
      targetId: organization.id,
      organizationId: organization.id,
    });

    return { ok: true, avatarUrl: `${config.server.publicApiUrl}/media/${stored.storageKey}` };
  });

  app.delete<{ Params: { org: string } }>('/api/v1/organizations/:org/avatar', async (request) => {
    app.requireAuth(request);

    const { organization } = await loadOrganizationByName(request.params.org);
    await requireOrganizationRole(organization.id, request.viewer, 'admin');

    await db
      .update(organizations)
      .set({ avatarPath: null })
      .where(eq(organizations.id, organization.id));
    await removeAvatar(organization.avatarPath);

    return { ok: true, avatarUrl: null };
  });
}
