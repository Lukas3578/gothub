/**
 * Gist-Endpunkte und Kommentare.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLogs, gistComments, gists, namespaces, users } from '../db/schema.js';
import { forbidden, notFound } from '../lib/errors.js';
import { avatarUrl } from '../services/avatars.js';
import {
  createGist,
  deleteGist,
  getGist,
  listGists,
  setGistStar,
  updateGist,
} from '../services/gists.js';

const fileSchema = z.object({
  filename: z.string().min(1).max(255),
  content: z.string().max(1024 * 1024),
});

export async function registerGistRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Liste
  // -------------------------------------------------------------------------
  app.get('/api/v1/gists', async (request) => {
    const query = z
      .object({
        owner: z.string().max(39).optional(),
        page: z.coerce.number().int().min(1).default(1),
        perPage: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(request.query);

    let ownerId: string | null = null;
    if (query.owner) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
        .where(eq(namespaces.nameLower, query.owner.toLowerCase()))
        .limit(1);
      if (!rows[0]) throw notFound('Benutzer nicht gefunden.');
      ownerId = rows[0].id;
    }

    return listGists({
      ownerId,
      viewerId: request.viewer?.id ?? null,
      page: query.page,
      perPage: query.perPage,
    });
  });

  // -------------------------------------------------------------------------
  // Anlegen
  // -------------------------------------------------------------------------
  app.post('/api/v1/gists', async (request, reply) => {
    app.requireAuth(request);
    const input = z
      .object({
        description: z.string().max(500).nullish(),
        isPublic: z.boolean().default(false),
        files: z.array(fileSchema).min(1).max(50),
      })
      .parse(request.body);

    const id = await createGist({
      ownerId: request.viewer!.id,
      ownerName: request.viewer!.username,
      ownerEmail: request.viewer!.email,
      description: input.description ?? null,
      isPublic: input.isPublic,
      files: input.files,
    });

    await db.insert(auditLogs).values({
      actorId: request.viewer!.id,
      action: 'gist.created',
      targetType: 'gist',
      targetId: id,
      metadata: { isPublic: input.isPublic },
    });

    reply.code(201);
    return getGist(id, request.viewer!.id);
  });

  // -------------------------------------------------------------------------
  // Detail
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/v1/gists/:id', async (request) => {
    return getGist(request.params.id, request.viewer?.id ?? null);
  });

  app.patch<{ Params: { id: string } }>('/api/v1/gists/:id', async (request) => {
    app.requireAuth(request);
    const input = z
      .object({
        description: z.string().max(500).nullish(),
        isPublic: z.boolean().optional(),
        files: z.array(fileSchema).min(1).max(50).optional(),
      })
      .parse(request.body);

    await updateGist(
      request.params.id,
      {
        id: request.viewer!.id,
        name: request.viewer!.username,
        email: request.viewer!.email,
        isAdmin: request.viewer!.isAdmin,
      },
      input,
    );

    return getGist(request.params.id, request.viewer!.id);
  });

  app.delete<{ Params: { id: string } }>('/api/v1/gists/:id', async (request) => {
    app.requireAuth(request);
    await deleteGist(request.params.id, request.viewer!);

    await db.insert(auditLogs).values({
      actorId: request.viewer!.id,
      action: 'gist.deleted',
      targetType: 'gist',
      targetId: request.params.id,
    });

    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Sterne
  // -------------------------------------------------------------------------
  app.put<{ Params: { id: string } }>('/api/v1/gists/:id/star', async (request) => {
    app.requireAuth(request);
    // Über getGist, damit ein nicht existierender Gist 404 liefert, statt
    // einen Stern auf eine fremde ID zu setzen.
    await getGist(request.params.id, request.viewer!.id);
    const count = await setGistStar(request.params.id, request.viewer!.id, true);
    return { starred: true, starCount: count };
  });

  app.delete<{ Params: { id: string } }>('/api/v1/gists/:id/star', async (request) => {
    app.requireAuth(request);
    const count = await setGistStar(request.params.id, request.viewer!.id, false);
    return { starred: false, starCount: count };
  });

  // -------------------------------------------------------------------------
  // Kommentare
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/v1/gists/:id/comments', async (request) => {
    await getGist(request.params.id, request.viewer?.id ?? null);

    const rows = await db
      .select({
        comment: gistComments,
        username: namespaces.name,
        displayName: users.displayName,
        avatarPath: users.avatarPath,
      })
      .from(gistComments)
      .leftJoin(users, eq(users.id, gistComments.authorId))
      .leftJoin(namespaces, eq(namespaces.id, users.namespaceId))
      .where(eq(gistComments.gistId, request.params.id))
      .orderBy(gistComments.createdAt);

    return {
      items: rows.map((row) => ({
        id: row.comment.id,
        body: row.comment.body,
        createdAt: row.comment.createdAt.toISOString(),
        editedAt: row.comment.editedAt?.toISOString() ?? null,
        author: row.comment.authorId
          ? {
              id: row.comment.authorId,
              username: row.username ?? '',
              displayName: row.displayName ?? null,
              avatarUrl: avatarUrl(row.avatarPath),
            }
          : null,
        viewerCanEdit: row.comment.authorId === request.viewer?.id,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/v1/gists/:id/comments', async (request, reply) => {
    app.requireAuth(request);
    const { body } = z.object({ body: z.string().min(1).max(64 * 1024) }).parse(request.body);

    await getGist(request.params.id, request.viewer!.id);

    const [created] = await db
      .insert(gistComments)
      .values({ gistId: request.params.id, authorId: request.viewer!.id, body })
      .returning();

    reply.code(201);
    return { id: created!.id, createdAt: created!.createdAt.toISOString() };
  });

  app.delete<{ Params: { id: string; commentId: string } }>(
    '/api/v1/gists/:id/comments/:commentId',
    async (request) => {
      app.requireAuth(request);

      const [comment] = await db
        .select()
        .from(gistComments)
        .where(
          and(eq(gistComments.id, request.params.commentId), eq(gistComments.gistId, request.params.id)),
        )
        .limit(1);

      if (!comment) throw notFound('Kommentar nicht gefunden.');

      const [gist] = await db
        .select({ ownerId: gists.ownerId })
        .from(gists)
        .where(eq(gists.id, request.params.id))
        .limit(1);

      // Löschen darf der Verfasser, der Eigentümer des Gists und ein Administrator.
      const allowed =
        comment.authorId === request.viewer!.id ||
        gist?.ownerId === request.viewer!.id ||
        request.viewer!.isAdmin;

      if (!allowed) throw forbidden('Du kannst diesen Kommentar nicht löschen.');

      await db.delete(gistComments).where(eq(gistComments.id, comment.id));
      return { ok: true };
    },
  );
}
