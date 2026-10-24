/**
 * Hintergrundaufgaben des API-Prozesses.
 *
 * Bewusst klein gehalten und im selben Prozess: ein separater Worker wäre
 * erst nötig, wenn die Arbeit hier spürbar wird. Was läuft, ist jeweils kurz
 * und fehlertolerant – ein Fehlschlag wird protokolliert und beim nächsten
 * Durchlauf erneut versucht.
 */

import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db } from './db/index.js';
import { repositories, runners, workflows } from './db/schema.js';
import { reclaimExpiredJobs, triggerWorkflows } from './services/workflows.js';
import { resolveRef } from './git/repository.js';

export interface SchedulerHandle {
  stop: () => void;
}

export function startScheduler(log: FastifyBaseLogger): SchedulerHandle {
  const timers: NodeJS.Timeout[] = [];

  /** Hilfsfunktion: führt eine Aufgabe aus und schluckt Fehler nicht stumm. */
  const every = (intervalMs: number, name: string, task: () => Promise<void>) => {
    const run = () => {
      task().catch((error) => log.error({ err: error, task: name }, 'Hintergrundaufgabe fehlgeschlagen'));
    };
    timers.push(setInterval(run, intervalMs));
  };

  // Verwaiste Jobs freigeben, deren Runner sich nicht mehr meldet.
  every(30_000, 'reclaim-jobs', async () => {
    const count = await reclaimExpiredJobs();
    if (count > 0) log.warn({ count }, 'Verwaiste CI-Jobs wurden neu eingereiht');
  });

  // Runner, die sich lange nicht gemeldet haben, auf offline setzen.
  every(60_000, 'runner-status', async () => {
    await db
      .update(runners)
      .set({ status: 'offline' })
      .where(
        and(
          sql`${runners.status} IN ('idle', 'busy')`,
          isNotNull(runners.lastSeenAt),
          lt(runners.lastSeenAt, new Date(Date.now() - 120_000)),
        ),
      );
  });

  // Zeitgesteuerte Workflows.
  every(60_000, 'cron-workflows', runScheduledWorkflows);

  return {
    stop: () => {
      for (const timer of timers) clearInterval(timer);
    },
  };
}

/**
 * Wertet Cron-Ausdrücke aus und löst fällige Workflows aus.
 *
 * Unterstützt die fünf Standardfelder mit *, Zahlen, Listen, Bereichen und
 * Schrittweiten. Die Prüfung läuft minütlich; durch die Begrenzung auf die
 * aktuelle Minute kann ein Workflow pro Minute höchstens einmal starten.
 */
async function runScheduledWorkflows(): Promise<void> {
  const now = new Date();
  const rows = await db
    .select({
      workflow: workflows,
      repositoryId: repositories.id,
      defaultBranch: repositories.defaultBranch,
      hasActions: repositories.hasActions,
      isArchived: repositories.isArchived,
    })
    .from(workflows)
    .innerJoin(repositories, eq(repositories.id, workflows.repositoryId))
    .where(and(eq(workflows.isEnabled, true), sql`jsonb_array_length(${workflows.schedules}) > 0`));

  for (const row of rows) {
    if (!row.hasActions || row.isArchived) continue;

    const due = row.workflow.schedules.some((expression) => cronMatches(expression, now));
    if (!due) continue;

    const sha = await resolveRef(row.repositoryId, row.defaultBranch);
    if (!sha) continue;

    await triggerWorkflows({
      repositoryId: row.repositoryId,
      event: 'schedule',
      headSha: sha,
      headBranch: row.defaultBranch,
      workflowPath: row.workflow.path,
    });
  }
}

/** Prüft einen Cron-Ausdruck gegen einen Zeitpunkt (UTC). */
export function cronMatches(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const values = [
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    date.getUTCDay(),
  ];

  return fields.every((field, index) => fieldMatches(field, values[index]!));
}

function fieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;

  for (const part of field.split(',')) {
    const step = part.split('/');
    const range = step[0]!;
    const interval = step[1] ? Number(step[1]) : 1;

    if (!Number.isFinite(interval) || interval <= 0) continue;

    if (range === '*') {
      if (value % interval === 0) return true;
      continue;
    }

    const bounds = range.split('-').map(Number);
    const start = bounds[0]!;
    const end = bounds.length > 1 ? bounds[1]! : start;

    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (value < start || value > end) continue;
    if ((value - start) % interval === 0) return true;
  }

  return false;
}
