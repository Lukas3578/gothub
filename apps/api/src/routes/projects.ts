/**
 * Projektboards (Kanban).
 *
 * Ein Board gehört zu einem Repository und besteht aus Spalten, in denen
 * Karten liegen. Eine Karte ist entweder eine freie Notiz oder ein
 * verknüpftes Issue bzw. ein Pull Request.
 *
 * Die Sortierung läuft über ganzzahlige Positionen mit Abstand 1000. Beim
 * Verschieben wird der Mittelwert der Nachbarn genommen; erst wenn kein Platz
 * mehr dazwischen ist, wird die Spalte neu nummeriert. Das vermeidet, bei
 * jedem Verschieben alle Karten anzufassen.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  auditLogs,
  issues,
  projectBoards,
  projectCards,
  projectColumns,
  repositories,
} from '../db/schema.js';
import { isUniqueViolation, notFound, validationFailed } from '../lib/errors.js';
import { requireRepositoryAccess } from '../services/permissions.js';

const POSITION_GAP = 1000;

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  /** Lädt ein Board und stellt sicher, dass es zum Repository gehört. */
  async function loadBoard(repositoryId: string, number: number) {
    const rows = await db
      .select()
      .from(projectBoards)
      .where(and(eq(projectBoards.repositoryId, repositoryId), eq(projectBoards.number, number)))
      .limit(1);
    if (!rows[0]) throw notFound('Board nicht gefunden.');
    return rows[0];
  }

  /**
   * Stellt sicher, dass eine Spalte zu dem Board gehört, auf das der Aufrufer
   * Zugriff hat. Ohne diese Prüfung ließe sich mit einer fremden Spalten-ID
   * in ein fremdes Board schreiben.
   */
  async function loadColumnOfBoard(columnId: string, boardId: string) {
    const rows = await db
      .select()
      .from(projectColumns)
      .where(and(eq(projectColumns.id, columnId), eq(projectColumns.boardId, boardId)))
      .limit(1);
    if (!rows[0]) throw notFound('Spalte nicht gefunden.');
    return rows[0];
  }

  // -------------------------------------------------------------------------
  // Boards
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/projects',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      const rows = await db
        .select({
          board: projectBoards,
          cardCount: sql<number>`(
            SELECT count(*) FROM project_cards
            JOIN project_columns ON project_columns.id = project_cards.column_id
            WHERE project_columns.board_id = ${projectBoards.id}
          )`,
        })
        .from(projectBoards)
        .where(eq(projectBoards.repositoryId, access.repository.id))
        .orderBy(asc(projectBoards.number));

      return {
        items: rows.map((row) => ({
          id: row.board.id,
          number: row.board.number,
          name: row.board.name,
          description: row.board.description,
          isClosed: row.board.isClosed,
          cardCount: row.cardCount,
          createdAt: row.board.createdAt.toISOString(),
        })),
        viewerCanEdit: ['write', 'maintain', 'admin'].includes(access.level),
      };
    },
  );

  app.post<{ Params: { owner: string; repo: string } }>(
    '/api/v1/repos/:owner/:repo/projects',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({
          name: z.string().min(1).max(200),
          description: z.string().max(1000).nullish(),
          /** Standardspalten, wenn nichts angegeben wird. */
          columns: z.array(z.string().min(1).max(100)).max(10).optional(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );

      const board = await db.transaction(async (tx) => {
        // Die Nummer wird innerhalb der Transaktion vergeben; der
        // UNIQUE-Index auf (Repository, Nummer) fängt ein Wettrennen ab.
        const maxRows = await tx
          .select({ maximum: sql<number>`COALESCE(MAX(${projectBoards.number}), 0)` })
          .from(projectBoards)
          .where(eq(projectBoards.repositoryId, access.repository.id));

        const [created] = await tx
          .insert(projectBoards)
          .values({
            repositoryId: access.repository.id,
            number: (maxRows[0]?.maximum ?? 0) + 1,
            name: input.name,
            description: input.description ?? null,
            createdById: request.viewer!.id,
          })
          .returning();

        const names = input.columns ?? ['Offen', 'In Arbeit', 'Erledigt'];
        await tx.insert(projectColumns).values(
          names.map((name, index) => ({
            boardId: created!.id,
            name,
            position: (index + 1) * POSITION_GAP,
            // Die letzte Standardspalte gilt als Abschluss.
            isDoneColumn: !input.columns && index === names.length - 1,
          })),
        );

        return created!;
      });

      await db.insert(auditLogs).values({
        actorId: request.viewer!.id,
        action: 'project.created',
        targetType: 'project_board',
        targetId: board.id,
        repositoryId: access.repository.id,
        metadata: { name: input.name },
      });

      reply.code(201);
      return { id: board.id, number: board.number, name: board.name };
    },
  );

  // -------------------------------------------------------------------------
  // Board-Detail mit Spalten und Karten
  // -------------------------------------------------------------------------
  app.get<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/projects/:number',
    async (request) => {
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'read',
      );

      const board = await loadBoard(access.repository.id, Number(request.params.number));

      const columns = await db
        .select()
        .from(projectColumns)
        .where(eq(projectColumns.boardId, board.id))
        .orderBy(asc(projectColumns.position));

      const cards = await db
        .select({
          card: projectCards,
          issueNumber: issues.number,
          issueTitle: issues.title,
          issueState: issues.state,
          issueKind: issues.kind,
        })
        .from(projectCards)
        .leftJoin(issues, eq(issues.id, projectCards.issueId))
        .where(
          sql`${projectCards.columnId} IN (
            SELECT id FROM project_columns WHERE board_id = ${board.id}
          )`,
        )
        .orderBy(asc(projectCards.position));

      return {
        id: board.id,
        number: board.number,
        name: board.name,
        description: board.description,
        isClosed: board.isClosed,
        viewerCanEdit: ['write', 'maintain', 'admin'].includes(access.level),
        columns: columns.map((column) => ({
          id: column.id,
          name: column.name,
          position: column.position,
          isDoneColumn: column.isDoneColumn,
          cards: cards
            .filter((entry) => entry.card.columnId === column.id)
            .map((entry) => ({
              id: entry.card.id,
              note: entry.card.note,
              position: entry.card.position,
              issue: entry.card.issueId
                ? {
                    id: entry.card.issueId,
                    number: entry.issueNumber,
                    title: entry.issueTitle,
                    state: entry.issueState,
                    kind: entry.issueKind,
                  }
                : null,
            })),
        })),
      };
    },
  );

  app.patch<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/projects/:number',
    async (request) => {
      app.requireAuth(request);
      const input = z
        .object({
          name: z.string().min(1).max(200).optional(),
          description: z.string().max(1000).nullish(),
          isClosed: z.boolean().optional(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );
      const board = await loadBoard(access.repository.id, Number(request.params.number));

      await db
        .update(projectBoards)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(projectBoards.id, board.id));

      return { ok: true };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/projects/:number',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'maintain',
      );
      const board = await loadBoard(access.repository.id, Number(request.params.number));

      await db.delete(projectBoards).where(eq(projectBoards.id, board.id));
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Spalten
  // -------------------------------------------------------------------------
  app.post<{ Params: { owner: string; repo: string; number: string } }>(
    '/api/v1/repos/:owner/:repo/projects/:number/columns',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z.object({ name: z.string().min(1).max(100) }).parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );
      const board = await loadBoard(access.repository.id, Number(request.params.number));

      const maxRows = await db
        .select({ maximum: sql<number>`COALESCE(MAX(${projectColumns.position}), 0)` })
        .from(projectColumns)
        .where(eq(projectColumns.boardId, board.id));

      const [created] = await db
        .insert(projectColumns)
        .values({ boardId: board.id, name: input.name, position: (maxRows[0]?.maximum ?? 0) + POSITION_GAP })
        .returning();

      reply.code(201);
      return { id: created!.id, name: created!.name, position: created!.position };
    },
  );

  app.patch<{ Params: { owner: string; repo: string; number: string; columnId: string } }>(
    '/api/v1/repos/:owner/:repo/projects/:number/columns/:columnId',
    async (request) => {
      app.requireAuth(request);
      const input = z
        .object({
          name: z.string().min(1).max(100).optional(),
          isDoneColumn: z.boolean().optional(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );
      const board = await loadBoard(access.repository.id, Number(request.params.number));
      const column = await loadColumnOfBoard(request.params.columnId, board.id);

      await db.update(projectColumns).set(input).where(eq(projectColumns.id, column.id));
      return { ok: true };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; number: string; columnId: string } }>(
    '/api/v1/repos/:owner/:repo/projects/:number/columns/:columnId',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );
      const board = await loadBoard(access.repository.id, Number(request.params.number));
      const column = await loadColumnOfBoard(request.params.columnId, board.id);

      await db.delete(projectColumns).where(eq(projectColumns.id, column.id));
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Karten
  // -------------------------------------------------------------------------
  app.post<{ Params: { owner: string; repo: string; number: string; columnId: string } }>(
    '/api/v1/repos/:owner/:repo/projects/:number/columns/:columnId/cards',
    async (request, reply) => {
      app.requireAuth(request);
      const input = z
        .object({
          note: z.string().max(5000).nullish(),
          issueNumber: z.number().int().positive().nullish(),
        })
        .parse(request.body);

      if (!input.note && !input.issueNumber) {
        throw validationFailed('Eine Karte braucht eine Notiz oder ein verknüpftes Issue.');
      }

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );
      const board = await loadBoard(access.repository.id, Number(request.params.number));
      const column = await loadColumnOfBoard(request.params.columnId, board.id);

      let issueId: string | null = null;
      if (input.issueNumber) {
        // Das Issue muss aus demselben Repository stammen; sonst ließe sich
        // ein fremder Titel in ein Board holen.
        const [issue] = await db
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(
              eq(issues.repositoryId, access.repository.id),
              eq(issues.number, input.issueNumber),
            ),
          )
          .limit(1);
        if (!issue) throw notFound('Issue nicht gefunden.');
        issueId = issue.id;
      }

      const maxRows = await db
        .select({ maximum: sql<number>`COALESCE(MAX(${projectCards.position}), 0)` })
        .from(projectCards)
        .where(eq(projectCards.columnId, column.id));

      try {
        const [created] = await db
          .insert(projectCards)
          .values({
            columnId: column.id,
            note: input.note ?? null,
            issueId,
            position: (maxRows[0]?.maximum ?? 0) + POSITION_GAP,
            createdById: request.viewer!.id,
          })
          .returning();

        reply.code(201);
        return { id: created!.id, position: created!.position };
      } catch (error) {
        if (isUniqueViolation(error, 'project_cards_issue_key', 'project_cards.issue_id')) {
          throw validationFailed('Dieses Issue liegt bereits in dieser Spalte.');
        }
        throw error;
      }
    },
  );

  /**
   * Verschiebt eine Karte.
   *
   * `afterCardId` benennt die Karte, hinter der sie landen soll – null
   * bedeutet "an den Anfang". Positionen werden aus den Nachbarn berechnet;
   * reicht der Abstand nicht, wird die Zielspalte neu nummeriert.
   */
  app.post<{ Params: { owner: string; repo: string; number: string; cardId: string } }>(
    '/api/v1/repos/:owner/:repo/projects/:number/cards/:cardId/move',
    async (request) => {
      app.requireAuth(request);
      const input = z
        .object({
          columnId: z.string().uuid(),
          afterCardId: z.string().uuid().nullish(),
        })
        .parse(request.body);

      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );
      const board = await loadBoard(access.repository.id, Number(request.params.number));
      const targetColumn = await loadColumnOfBoard(input.columnId, board.id);

      await db.transaction(async (tx) => {
        const [card] = await tx
          .select()
          .from(projectCards)
          .where(eq(projectCards.id, request.params.cardId))
          .limit(1);
        if (!card) throw notFound('Karte nicht gefunden.');

        // Auch die Herkunftsspalte muss zum Board gehören.
        const [sourceColumn] = await tx
          .select({ boardId: projectColumns.boardId })
          .from(projectColumns)
          .where(eq(projectColumns.id, card.columnId))
          .limit(1);
        if (sourceColumn?.boardId !== board.id) throw notFound('Karte nicht gefunden.');

        const siblings = await tx
          .select({ id: projectCards.id, position: projectCards.position })
          .from(projectCards)
          .where(eq(projectCards.columnId, targetColumn.id))
          .orderBy(asc(projectCards.position));

        const others = siblings.filter((entry) => entry.id !== card.id);
        const index = input.afterCardId
          ? others.findIndex((entry) => entry.id === input.afterCardId) + 1
          : 0;

        const before = index > 0 ? others[index - 1]?.position ?? 0 : 0;
        const after = others[index]?.position ?? before + 2 * POSITION_GAP;

        let position = Math.floor((before + after) / 2);

        if (position <= before || position >= after) {
          // Kein Platz mehr: Spalte in gleichmäßigen Abständen neu nummerieren.
          const reordered = [...others];
          reordered.splice(index, 0, { id: card.id, position: 0 });
          for (const [i, entry] of reordered.entries()) {
            await tx
              .update(projectCards)
              .set({ position: (i + 1) * POSITION_GAP })
              .where(eq(projectCards.id, entry.id));
          }
          position = (index + 1) * POSITION_GAP;
        }

        await tx
          .update(projectCards)
          .set({ columnId: targetColumn.id, position })
          .where(eq(projectCards.id, card.id));
      });

      return { ok: true };
    },
  );

  app.delete<{ Params: { owner: string; repo: string; number: string; cardId: string } }>(
    '/api/v1/repos/:owner/:repo/projects/:number/cards/:cardId',
    async (request) => {
      app.requireAuth(request);
      const access = await requireRepositoryAccess(
        request.params.owner,
        request.params.repo,
        request.viewer,
        'write',
      );
      const board = await loadBoard(access.repository.id, Number(request.params.number));

      const [card] = await db
        .select({ id: projectCards.id, columnId: projectCards.columnId })
        .from(projectCards)
        .where(eq(projectCards.id, request.params.cardId))
        .limit(1);
      if (!card) throw notFound('Karte nicht gefunden.');

      await loadColumnOfBoard(card.columnId, board.id);
      await db.delete(projectCards).where(eq(projectCards.id, card.id));

      return { ok: true };
    },
  );
}
