/**
 * Authentifizierungs-Endpunkte.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { SessionInfo } from '@forge/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { auditLogs, sessions } from '../db/schema.js';
import {
  authenticate,
  changePassword,
  completeTwoFactor,
  consumeEmailVerification,
  createSession,
  issueEmailVerification,
  registerUser,
  requestPasswordReset,
  resetPassword,
  revokeAllSessionsExcept,
  revokeSession,
  toViewer,
} from '../services/auth.js';
import { unauthenticated } from '../lib/errors.js';

const registerSchema = z.object({
  username: z.string().min(1).max(39),
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

const loginSchema = z.object({
  identifier: z.string().min(1).max(320),
  password: z.string().min(1).max(200),
  rememberMe: z.boolean().optional(),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /** Setzt das Session-Cookie. HttpOnly, damit JavaScript es nicht auslesen kann. */
  function setSessionCookie(reply: any, token: string, expiresAt: Date): void {
    reply.setCookie(config.security.sessionCookieName, token, {
      path: '/',
      httpOnly: true,
      // 'lax' erlaubt normale Navigation, blockiert aber Cross-Site-POSTs.
      sameSite: 'lax',
      secure: config.isProduction,
      signed: true,
      expires: expiresAt,
    });
  }

  app.post('/api/v1/auth/register', async (request, reply) => {
    const input = registerSchema.parse(request.body);

    const user = await registerUser(input);
    const session = await createSession(user.id, {
      userAgent: request.headers['user-agent'] ?? null,
      ipAddress: request.ip,
    });

    setSessionCookie(reply, session.token, session.expiresAt);

    // Der Versand darf die Registrierung nicht scheitern lassen; der Benutzer
    // kann die Bestätigung später erneut anfordern.
    await issueEmailVerification(user.id, user.email, user.username).catch((error) => {
      request.log.error({ err: error }, 'Versand der Bestätigungsmail fehlgeschlagen');
    });

    await db.insert(auditLogs).values({
      actorId: user.id,
      action: 'user.registered',
      targetType: 'user',
      targetId: user.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']?.slice(0, 400) ?? null,
    });

    reply.code(201);
    return { viewer: toViewer(user) };
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const result = await authenticate(input.identifier, input.password);

    if (result.status === 'two_factor_required') {
      reply.code(200);
      return { status: 'two_factor_required', challengeToken: result.challengeToken };
    }

    const user = result.user!;
    const session = await createSession(user.id, {
      userAgent: request.headers['user-agent'] ?? null,
      ipAddress: request.ip,
    });

    setSessionCookie(reply, session.token, session.expiresAt);

    await db.insert(auditLogs).values({
      actorId: user.id,
      action: 'user.login',
      targetType: 'user',
      targetId: user.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']?.slice(0, 400) ?? null,
    });

    return { status: 'ok', viewer: toViewer(user) };
  });

  app.post('/api/v1/auth/login/two-factor', async (request, reply) => {
    const input = z
      .object({ challengeToken: z.string().min(1), code: z.string().min(1).max(32) })
      .parse(request.body);

    const user = await completeTwoFactor(input.challengeToken, input.code);
    const session = await createSession(user.id, {
      userAgent: request.headers['user-agent'] ?? null,
      ipAddress: request.ip,
    });

    setSessionCookie(reply, session.token, session.expiresAt);
    return { status: 'ok', viewer: toViewer(user) };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    if (request.sessionId && request.viewer) {
      await revokeSession(request.sessionId, request.viewer.id);
    }
    reply.clearCookie(config.security.sessionCookieName, { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/auth/me', async (request) => {
    if (!request.viewer) return { viewer: null };
    return { viewer: toViewer(request.viewer) };
  });

  // -- E-Mail-Verifizierung -------------------------------------------------

  app.post('/api/v1/auth/verify-email', async (request) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(request.body);
    await consumeEmailVerification(token);
    return { ok: true };
  });

  app.post('/api/v1/auth/verify-email/resend', async (request) => {
    app.requireAuth(request);
    if (request.viewer!.emailVerified) {
      return { ok: true, alreadyVerified: true };
    }
    await issueEmailVerification(
      request.viewer!.id,
      request.viewer!.email,
      request.viewer!.username,
    );
    return { ok: true };
  });

  // -- Passwort -------------------------------------------------------------

  app.post('/api/v1/auth/password/forgot', async (request) => {
    const { email } = z.object({ email: z.string().email() }).parse(request.body);
    await requestPasswordReset(email);
    // Immer dieselbe Antwort, unabhängig davon, ob die Adresse existiert.
    return { ok: true };
  });

  app.post('/api/v1/auth/password/reset', async (request) => {
    const input = z
      .object({ token: z.string().min(1), password: z.string().min(1).max(200) })
      .parse(request.body);
    await resetPassword(input.token, input.password);
    return { ok: true };
  });

  app.post('/api/v1/auth/password/change', async (request) => {
    app.requireAuth(request);
    if (!request.sessionId) throw unauthenticated('Diese Aktion erfordert eine Browser-Session.');

    const input = z
      .object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(1).max(200),
      })
      .parse(request.body);

    await changePassword(
      request.viewer!.id,
      input.currentPassword,
      input.newPassword,
      request.sessionId,
    );

    await db.insert(auditLogs).values({
      actorId: request.viewer!.id,
      action: 'user.password_changed',
      targetType: 'user',
      targetId: request.viewer!.id,
      ipAddress: request.ip,
    });

    return { ok: true };
  });

  // -- Sessions -------------------------------------------------------------

  app.get('/api/v1/auth/sessions', async (request) => {
    app.requireAuth(request);

    const rows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, request.viewer!.id), isNull(sessions.revokedAt)))
      .orderBy(desc(sessions.lastSeenAt));

    const now = Date.now();
    const items: SessionInfo[] = rows
      .filter((row) => row.expiresAt.getTime() > now)
      .map((row) => ({
        id: row.id,
        userAgent: row.userAgent,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        isCurrent: row.id === request.sessionId,
      }));

    return { items };
  });

  app.delete<{ Params: { id: string } }>('/api/v1/auth/sessions/:id', async (request) => {
    app.requireAuth(request);
    await revokeSession(request.params.id, request.viewer!.id);
    return { ok: true };
  });

  app.post('/api/v1/auth/sessions/revoke-others', async (request) => {
    app.requireAuth(request);
    if (!request.sessionId) throw unauthenticated('Diese Aktion erfordert eine Browser-Session.');
    await revokeAllSessionsExcept(request.viewer!.id, request.sessionId);
    return { ok: true };
  });
}
