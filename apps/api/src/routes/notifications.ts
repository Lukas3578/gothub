/**
 * Benachrichtigungs-Endpunkte inklusive Echtzeit-Stream.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listNotifications,
  markAllRead,
  markRead,
  notificationBus,
  unreadCount,
} from '../services/notifications.js';

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/notifications', async (request) => {
    app.requireAuth(request);
    const query = z
      .object({
        unreadOnly: z.coerce.boolean().default(false),
        page: z.coerce.number().int().min(1).default(1),
        perPage: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(request.query);

    return listNotifications(request.viewer!.id, query);
  });

  app.get('/api/v1/notifications/count', async (request) => {
    app.requireAuth(request);
    return { unreadCount: await unreadCount(request.viewer!.id) };
  });

  app.post('/api/v1/notifications/read', async (request) => {
    app.requireAuth(request);
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(200) }).parse(request.body);
    await markRead(request.viewer!.id, ids);
    return { ok: true, unreadCount: await unreadCount(request.viewer!.id) };
  });

  app.post('/api/v1/notifications/read-all', async (request) => {
    app.requireAuth(request);
    await markAllRead(request.viewer!.id);
    return { ok: true, unreadCount: 0 };
  });

  /**
   * Server-Sent Events für Echtzeit-Updates.
   *
   * SSE statt WebSocket: der Datenfluss geht nur in eine Richtung, SSE kommt
   * ohne zusätzliches Protokoll aus und der Browser stellt die Verbindung bei
   * einem Abbruch selbst wieder her.
   */
  app.get('/api/v1/notifications/stream', async (request, reply) => {
    app.requireAuth(request);
    const userId = request.viewer!.id;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Verhindert, dass ein Reverse Proxy die Antwort puffert und damit den
      // Zweck des Streams aufhebt.
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('ready', { unreadCount: await unreadCount(userId) });

    const onEvent = async () => {
      send('update', { unreadCount: await unreadCount(userId) });
    };

    const channel = `user:${userId}`;
    notificationBus.on(channel, onEvent);

    // Ein regelmäßiger Kommentar hält Verbindungen offen, die ein Proxy nach
    // Leerlauf sonst schließen würde.
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': keepalive\n\n');
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      notificationBus.off(channel, onEvent);
    };

    request.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);

    // Die Antwort bleibt offen; Fastify darf sie nicht beenden.
    return reply;
  });
}
