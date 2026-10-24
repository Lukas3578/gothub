/**
 * Administrationsbereich.
 *
 * Alle Endpunkte hier erfordern `isAdmin`. Zusätzlich wird jede Aktion im
 * Audit-Log vermerkt – eine Administration ohne nachvollziehbare Spur ist in
 * einer Mehrbenutzerinstanz nicht vertretbar.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq, gte, ilike, isNull, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  abuseReports,
  auditLogs,
  issues,
  namespaces,
  organizations,
  platformSettings,
  repositories,
  runners,
  sessions,
  users,
  workflowRuns,
} from '../db/schema.js';
import { notFound, validationFailed } from '../lib/errors.js';
import { loadUserRefs } from '../services/issues.js';
import { toSummary } from '../services/repositories.js';
import { verifyMailTransport } from '../services/mail.js';

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  /** Schreibt eine Admin-Aktion ins Audit-Log. */
  async function record(
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
    ip: string,
  ): Promise<void> {
    await db.insert(auditLogs).values({
      actorId,
      action,
      targetType,
      targetId,
      ipAddress: ip,
      metadata,
    });
  }

  // -------------------------------------------------------------------------
  // Übersicht
  // -------------------------------------------------------------------------
  app.get('/api/v1/admin/stats', async (request) => {
    app.requireAdmin(request);

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      userCount,
      activeUserCount,
      suspendedCount,
      repoCount,
      privateRepoCount,
      orgCount,
      issueCount,
      openIssueCount,
      runCount,
      failedRunCount,
      runnerCount,
      sessionCount,
      newUsers,
      storage,
    ] = await Promise.all([
      db.select({ value: count() }).from(users),
      db.select({ value: count() }).from(users).where(eq(users.isActive, true)),
      db.select({ value: count() }).from(users).where(isNotNull(users.suspendedAt)),
      db.select({ value: count() }).from(repositories).where(isNull(repositories.deletedAt)),
      db
        .select({ value: count() })
        .from(repositories)
        .where(and(isNull(repositories.deletedAt), eq(repositories.visibility, 'private'))),
      db.select({ value: count() }).from(organizations),
      db.select({ value: count() }).from(issues),
      db.select({ value: count() }).from(issues).where(eq(issues.state, 'open')),
      db.select({ value: count() }).from(workflowRuns),
      db.select({ value: count() }).from(workflowRuns).where(eq(workflowRuns.status, 'failure')),
      db.select({ value: count() }).from(runners),
      db.select({ value: count() }).from(sessions).where(isNull(sessions.revokedAt)),
      db.select({ value: count() }).from(users).where(gte(users.createdAt, since)),
      db
        .select({ value: sql<number>`COALESCE(SUM(${repositories.sizeBytes}), 0)::bigint` })
        .from(repositories)
        .where(isNull(repositories.deletedAt)),
    ]);

    return {
      users: {
        total: userCount[0]?.value ?? 0,
        active: activeUserCount[0]?.value ?? 0,
        suspended: suspendedCount[0]?.value ?? 0,
        newLast30Days: newUsers[0]?.value ?? 0,
      },
      repositories: {
        total: repoCount[0]?.value ?? 0,
        private: privateRepoCount[0]?.value ?? 0,
        storageBytes: Number(storage[0]?.value ?? 0),
      },
      organizations: { total: orgCount[0]?.value ?? 0 },
      issues: { total: issueCount[0]?.value ?? 0, open: openIssueCount[0]?.value ?? 0 },
      workflows: { runs: runCount[0]?.value ?? 0, failed: failedRunCount[0]?.value ?? 0 },
      runners: { total: runnerCount[0]?.value ?? 0 },
      sessions: { active: sessionCount[0]?.value ?? 0 },
    };
  });

  // -------------------------------------------------------------------------
  // Benutzerverwaltung
  // -------------------------------------------------------------------------
  app.get('/api/v1/admin/users', async (request) => {
    app.requireAdmin(request);
    const query = z
      .object({
        q: z.string().max(200).optional(),
        status: z.enum(['all', 'active', 'suspended', 'unverified']).default('all'),
        page: z.coerce.number().int().min(1).default(1),
        perPage: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(request.query);

    const conditions = [];
    if (query.q) {
      const pattern = `%${query.q}%`;
      conditions.push(
        or(ilike(namespaces.name, pattern), ilike(users.email, pattern), ilike(users.displayName, pattern))!,
      );
    }
    if (query.status === 'suspended') conditions.push(isNotNull(users.suspendedAt));
    if (query.status === 'active') conditions.push(and(eq(users.isActive, true), isNull(users.suspendedAt))!);
    if (query.status === 'unverified') conditions.push(eq(users.emailVerified, false));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        id: users.id,
        username: namespaces.name,
        email: users.email,
        displayName: users.displayName,
        emailVerified: users.emailVerified,
        isAdmin: users.isAdmin,
        isActive: users.isActive,
        suspendedAt: users.suspendedAt,
        suspendedReason: users.suspendedReason,
        twoFactorEnabled: users.twoFactorEnabled,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(query.perPage)
      .offset((query.page - 1) * query.perPage);

    const totalRows = await db
      .select({ value: count() })
      .from(users)
      .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
      .where(where);

    return {
      items: rows.map((row) => ({
        ...row,
        suspendedAt: row.suspendedAt?.toISOString() ?? null,
        lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      totalCount: totalRows[0]?.value ?? 0,
    };
  });

  app.post<{ Params: { id: string } }>('/api/v1/admin/users/:id/suspend', async (request) => {
    app.requireAdmin(request);
    const { reason } = z.object({ reason: z.string().max(500) }).parse(request.body);

    // Ein Administrator darf sich nicht selbst sperren – sonst ist die
    // Instanz unter Umständen nicht mehr verwaltbar.
    if (request.params.id === request.viewer!.id) {
      throw validationFailed('Du kannst dein eigenes Konto nicht sperren.');
    }

    await db.transaction(async (tx) => {
      const updated = await tx
        .update(users)
        .set({ suspendedAt: new Date(), suspendedReason: reason, isActive: false })
        .where(eq(users.id, request.params.id))
        .returning({ id: users.id });

      if (updated.length === 0) throw notFound('Benutzer nicht gefunden.');

      // Laufende Sitzungen beenden: eine Sperre, die erst beim nächsten Login
      // wirkt, ist keine Sperre.
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, request.params.id), isNull(sessions.revokedAt)));
    });

    await record(
      request.viewer!.id,
      'admin.user_suspended',
      'user',
      request.params.id,
      { reason },
      request.ip,
    );

    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/v1/admin/users/:id/unsuspend', async (request) => {
    app.requireAdmin(request);

    await db
      .update(users)
      .set({ suspendedAt: null, suspendedReason: null, isActive: true })
      .where(eq(users.id, request.params.id));

    await record(
      request.viewer!.id,
      'admin.user_unsuspended',
      'user',
      request.params.id,
      {},
      request.ip,
    );

    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/v1/admin/users/:id/admin', async (request) => {
    app.requireAdmin(request);
    const { isAdmin } = z.object({ isAdmin: z.boolean() }).parse(request.body);

    if (request.params.id === request.viewer!.id && !isAdmin) {
      // Sonst könnte sich der letzte Administrator die Rechte nehmen.
      const remaining = await db
        .select({ value: count() })
        .from(users)
        .where(eq(users.isAdmin, true));
      if ((remaining[0]?.value ?? 0) <= 1) {
        throw validationFailed('Du bist der letzte Administrator dieser Instanz.');
      }
    }

    await db.update(users).set({ isAdmin }).where(eq(users.id, request.params.id));

    await record(
      request.viewer!.id,
      isAdmin ? 'admin.granted' : 'admin.revoked',
      'user',
      request.params.id,
      {},
      request.ip,
    );

    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Repository-Verwaltung
  // -------------------------------------------------------------------------
  app.get('/api/v1/admin/repositories', async (request) => {
    app.requireAdmin(request);
    const query = z
      .object({
        q: z.string().max(200).optional(),
        includeDeleted: z.coerce.boolean().default(false),
        page: z.coerce.number().int().min(1).default(1),
        perPage: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(request.query);

    const conditions = [];
    if (!query.includeDeleted) conditions.push(isNull(repositories.deletedAt));
    if (query.q) conditions.push(ilike(repositories.name, `%${query.q}%`));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        repository: repositories,
        ownerName: namespaces.name,
        ownerKind: namespaces.kind,
      })
      .from(repositories)
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(where)
      .orderBy(desc(repositories.sizeBytes))
      .limit(query.perPage)
      .offset((query.page - 1) * query.perPage);

    const totalRows = await db.select({ value: count() }).from(repositories).where(where);

    return {
      items: rows.map((row) => ({
        ...toSummary(row.repository, row.ownerName, row.ownerKind),
        deletedAt: row.repository.deletedAt?.toISOString() ?? null,
      })),
      totalCount: totalRows[0]?.value ?? 0,
    };
  });

  // -------------------------------------------------------------------------
  // Audit-Log
  // -------------------------------------------------------------------------
  app.get('/api/v1/admin/audit-log', async (request) => {
    app.requireAdmin(request);
    const query = z
      .object({
        action: z.string().max(64).optional(),
        actor: z.string().max(39).optional(),
        page: z.coerce.number().int().min(1).default(1),
        perPage: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);

    const conditions = [];
    if (query.action) conditions.push(ilike(auditLogs.action, `%${query.action}%`));
    if (query.actor) {
      conditions.push(
        sql`${auditLogs.actorId} = (
          SELECT ${users.id} FROM ${users}
          JOIN ${namespaces} ON ${namespaces.id} = ${users.namespaceId}
          WHERE ${namespaces.nameLower} = ${query.actor.toLowerCase()}
        )`,
      );
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(query.perPage)
      .offset((query.page - 1) * query.perPage);

    const refs = await loadUserRefs(rows.map((row) => row.actorId));
    const totalRows = await db.select({ value: count() }).from(auditLogs).where(where);

    return {
      items: rows.map((row) => ({
        id: row.id,
        actorType: row.actorType,
        actor: row.actorId ? (refs.get(row.actorId) ?? null) : null,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        ipAddress: row.ipAddress,
        metadata: row.metadata,
        createdAt: row.createdAt.toISOString(),
      })),
      totalCount: totalRows[0]?.value ?? 0,
    };
  });

  // -------------------------------------------------------------------------
  // Meldungen
  // -------------------------------------------------------------------------
  app.get('/api/v1/admin/reports', async (request) => {
    app.requireAdmin(request);
    const { status } = z
      .object({ status: z.enum(['open', 'resolved', 'all']).default('open') })
      .parse(request.query);

    const rows = await db
      .select()
      .from(abuseReports)
      .where(status === 'all' ? undefined : eq(abuseReports.status, status))
      .orderBy(desc(abuseReports.createdAt))
      .limit(100);

    const refs = await loadUserRefs(rows.map((row) => row.reporterId));

    return {
      items: rows.map((row) => ({
        id: row.id,
        reporter: row.reporterId ? (refs.get(row.reporterId) ?? null) : null,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        reason: row.reason,
        details: row.details,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/v1/admin/reports/:id/resolve', async (request) => {
    app.requireAdmin(request);
    const { note } = z.object({ note: z.string().max(2000).optional() }).parse(request.body ?? {});

    await db
      .update(abuseReports)
      .set({
        status: 'resolved',
        resolvedById: request.viewer!.id,
        resolvedAt: new Date(),
        resolutionNote: note ?? null,
      })
      .where(eq(abuseReports.id, request.params.id));

    return { ok: true };
  });

  /** Meldung durch einen normalen Benutzer. */
  app.post('/api/v1/reports', async (request, reply) => {
    app.requireAuth(request);
    const input = z
      .object({
        subjectType: z.enum(['user', 'repository', 'issue', 'comment']),
        subjectId: z.string().uuid(),
        reason: z.enum(['spam', 'abuse', 'malware', 'copyright', 'other']),
        details: z.string().max(2000).optional(),
      })
      .parse(request.body);

    await db.insert(abuseReports).values({
      reporterId: request.viewer!.id,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      reason: input.reason,
      details: input.details ?? null,
    });

    reply.code(201);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Plattformeinstellungen
  // -------------------------------------------------------------------------
  app.get('/api/v1/admin/settings', async (request) => {
    app.requireAdmin(request);
    const rows = await db.select().from(platformSettings);
    return {
      items: rows.map((row) => ({
        key: row.key,
        value: row.value,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  });

  app.put<{ Params: { key: string } }>('/api/v1/admin/settings/:key', async (request) => {
    app.requireAdmin(request);
    const { value } = z.object({ value: z.unknown() }).parse(request.body);

    const allowed = ['maintenance_mode', 'allow_registration', 'announcement', 'max_repo_size_mb'];
    if (!allowed.includes(request.params.key)) {
      throw validationFailed(`Unbekannte Einstellung. Erlaubt: ${allowed.join(', ')}`);
    }

    await db
      .insert(platformSettings)
      .values({ key: request.params.key, value, updatedById: request.viewer!.id })
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: { value, updatedById: request.viewer!.id, updatedAt: new Date() },
      });

    await record(
      request.viewer!.id,
      'admin.setting_changed',
      'platform',
      request.params.key,
      { key: request.params.key, value },
      request.ip,
    );

    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Runner
  // -------------------------------------------------------------------------
  app.get('/api/v1/admin/runners', async (request) => {
    app.requireAdmin(request);

    const rows = await db
      .select({
        runner: runners,
        repositoryName: repositories.name,
        ownerName: namespaces.name,
      })
      .from(runners)
      .leftJoin(repositories, eq(repositories.id, runners.repositoryId))
      .leftJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .orderBy(desc(runners.lastSeenAt));

    return {
      items: rows.map((row) => ({
        id: row.runner.id,
        name: row.runner.name,
        labels: row.runner.labels,
        status:
          row.runner.status !== 'disabled' &&
          (!row.runner.lastSeenAt || Date.now() - row.runner.lastSeenAt.getTime() > 120_000)
            ? 'offline'
            : row.runner.status,
        scope:
          row.ownerName && row.repositoryName
            ? `${row.ownerName}/${row.repositoryName}`
            : 'Plattform',
        osName: row.runner.osName,
        lastSeenAt: row.runner.lastSeenAt?.toISOString() ?? null,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/v1/admin/runners/:id/disable', async (request) => {
    app.requireAdmin(request);
    await db.update(runners).set({ status: 'disabled' }).where(eq(runners.id, request.params.id));
    await record(request.viewer!.id, 'admin.runner_disabled', 'runner', request.params.id, {}, request.ip);
    return { ok: true };
  });
  /**
   * Prüft, ob der konfigurierte Mailversand funktioniert.
   * Ohne diesen Test fällt eine Fehlkonfiguration erst auf, wenn jemand
   * vergeblich auf eine Bestätigungsmail wartet.
   */
  app.get('/api/v1/admin/mail/check', async (request) => {
    app.requireAdmin(request);
    return verifyMailTransport();
  });

}
