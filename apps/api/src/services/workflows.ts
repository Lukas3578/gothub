/**
 * Workflow-Verwaltung: Dateien aus dem Repository einlesen, Läufe erzeugen,
 * Jobs einreihen und ihren Fortschritt verfolgen.
 *
 * Die Jobwarteschlange liegt in der Datenbank, nicht in Redis. Begründung: ein
 * Job muss zusammen mit seinem Lauf konsistent sein, und eine Zuweisung an
 * einen Runner darf nicht verloren gehen, wenn ein Prozess abstürzt. Die
 * Zuweisung läuft über `UPDATE ... WHERE status = 'queued'` mit `RETURNING` –
 * das ist atomar, auch wenn mehrere Runner gleichzeitig fragen.
 */

import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type {
  RunStatus,
  WorkflowJobDetail,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowSummary,
} from '@forge/shared';
import { db } from '../db/index.js';
import {
  issues,
  namespaces,
  pullRequests,
  repositories,
  runners,
  secrets,
  variables,
  workflowArtifacts,
  workflowJobs,
  workflowLogChunks,
  workflowRuns,
  workflowSteps,
  workflows,
} from '../db/schema.js';
import { notFound, validationFailed } from '../lib/errors.js';
import { decryptSecret } from '../lib/crypto.js';
import { listTree, readBlob, resolveRef } from '../git/repository.js';
import {
  evaluateCondition,
  interpolate,
  parseWorkflow,
  pullRequestTriggerMatches,
  pushTriggerMatches,
  WorkflowParseError,
  type NormalizedWorkflow,
} from './workflow-parser.js';
import { loadUserRefs } from './issues.js';
import { dispatchWebhook } from './webhooks.js';
import { notify } from './notifications.js';

/** Verzeichnis, in dem Workflow-Dateien erwartet werden. */
const WORKFLOW_DIR = '.forge/workflows';

// ---------------------------------------------------------------------------
// Dateien einlesen
// ---------------------------------------------------------------------------

/**
 * Liest die Workflow-Dateien eines Refs und gleicht sie mit der Datenbank ab.
 *
 * Fehlerhafte Dateien werden nicht übergangen: sie bleiben mit gesetztem
 * `parseError` in der Liste, damit die Oberfläche zeigen kann, dass hier etwas
 * nicht stimmt. Eine stillschweigend verschwundene CI ist schlimmer als eine
 * sichtbar kaputte.
 */
export async function syncWorkflows(repositoryId: string, ref: string): Promise<void> {
  let entries;
  try {
    entries = await listTree(repositoryId, ref, WORKFLOW_DIR);
  } catch {
    // Kein Workflow-Verzeichnis: alle bisherigen Einträge als entfernt
    // behandeln, aber die Läufe erhalten.
    await db
      .update(workflows)
      .set({ isEnabled: false })
      .where(eq(workflows.repositoryId, repositoryId));
    return;
  }

  const files = entries.filter(
    (entry) => entry.type === 'blob' && /\.(ya?ml)$/i.test(entry.name),
  );

  const seenPaths: string[] = [];

  for (const file of files) {
    seenPaths.push(file.path);

    let name = file.name;
    let parseError: string | null = null;
    let schedules: string[] = [];

    try {
      const blob = await readBlob(repositoryId, ref, file.path);
      if (blob.content === null || blob.isBinary) {
        parseError = 'Die Datei ist leer oder keine Textdatei.';
      } else {
        const parsed = parseWorkflow(blob.content, file.path);
        name = parsed.name;
        schedules = parsed.triggers.schedules;
      }
    } catch (error) {
      parseError =
        error instanceof WorkflowParseError
          ? [error.message, ...error.details].join('\n')
          : error instanceof Error
            ? error.message
            : 'Unbekannter Fehler beim Lesen.';
    }

    await db
      .insert(workflows)
      .values({
        repositoryId,
        name,
        path: file.path,
        parseError,
        schedules,
        isEnabled: true,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [workflows.repositoryId, workflows.path],
        set: { name, parseError, schedules, isEnabled: true, updatedAt: new Date() },
      });
  }

  // Dateien, die es nicht mehr gibt, werden deaktiviert statt gelöscht –
  // sonst verschwänden die zugehörigen Läufe aus der Historie.
  const existing = await db
    .select({ id: workflows.id, path: workflows.path })
    .from(workflows)
    .where(eq(workflows.repositoryId, repositoryId));

  const removed = existing.filter((row) => !seenPaths.includes(row.path));
  if (removed.length > 0) {
    await db
      .update(workflows)
      .set({ isEnabled: false })
      .where(
        inArray(
          workflows.id,
          removed.map((r) => r.id),
        ),
      );
  }
}

// ---------------------------------------------------------------------------
// Läufe auslösen
// ---------------------------------------------------------------------------

export interface TriggerContext {
  repositoryId: string;
  event: 'push' | 'pull_request' | 'workflow_dispatch' | 'schedule' | 'release';
  headSha: string;
  headBranch: string | null;
  tag?: string | null;
  changedPaths?: string[] | null;
  /** Bei pull_request der Basis-Branch. */
  baseBranch?: string | null;
  issueId?: string | null;
  triggeredById?: string | null;
  /** Nur bei workflow_dispatch: ein bestimmter Workflow. */
  workflowPath?: string;
  inputs?: Record<string, string>;
}

/**
 * Prüft alle Workflows eines Repositories gegen ein Ereignis und legt für die
 * passenden einen Lauf an.
 */
export async function triggerWorkflows(context: TriggerContext): Promise<string[]> {
  const repoRows = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, context.repositoryId))
    .limit(1);

  const repository = repoRows[0];
  if (!repository || !repository.hasActions || repository.isArchived) return [];

  // Die Workflow-Dateien werden aus dem auslösenden Commit gelesen, nicht aus
  // dem Default-Branch. Sonst liefe ein Workflow, der auf einem Feature-Branch
  // neu hinzugefügt wurde, erst nach dem Merge – also genau dann nicht, wenn
  // man ihn braucht.
  let files: { path: string; name: string }[];
  try {
    const entries = await listTree(context.repositoryId, context.headSha, WORKFLOW_DIR);
    files = entries
      .filter((entry) => entry.type === 'blob' && /\.(ya?ml)$/i.test(entry.name))
      .map((entry) => ({ path: entry.path, name: entry.name }));
  } catch {
    return [];
  }

  const createdRuns: string[] = [];

  for (const file of files) {
    if (context.workflowPath && file.path !== context.workflowPath) continue;

    let parsed: NormalizedWorkflow;
    try {
      const blob = await readBlob(context.repositoryId, context.headSha, file.path);
      if (!blob.content) continue;
      parsed = parseWorkflow(blob.content, file.path);
    } catch (error) {
      // Eine fehlerhafte Datei wird nicht stillschweigend übergangen: der
      // Fehler landet am Workflow, damit die Oberfläche zeigen kann, warum
      // hier nichts läuft. Ein unsichtbar kaputter Workflow ist schlimmer als
      // ein sichtbar kaputter.
      const message =
        error instanceof WorkflowParseError
          ? [error.message, ...error.details].join('\n')
          : error instanceof Error
            ? error.message
            : 'Unbekannter Fehler beim Lesen.';

      await db
        .insert(workflows)
        .values({
          repositoryId: context.repositoryId,
          name: file.name,
          path: file.path,
          parseError: message,
          isEnabled: true,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [workflows.repositoryId, workflows.path],
          set: { parseError: message, updatedAt: new Date() },
        })
        .catch(() => {});

      continue;
    }

    // Der Workflow-Datensatz wird hier angelegt oder aufgefrischt, damit er
    // auch dann in der Übersicht erscheint, wenn er nur auf einem Branch
    // existiert.
    const [workflow] = await db
      .insert(workflows)
      .values({
        repositoryId: context.repositoryId,
        name: parsed.name,
        path: file.path,
        parseError: null,
        schedules: parsed.triggers.schedules,
        isEnabled: true,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [workflows.repositoryId, workflows.path],
        set: {
          name: parsed.name,
          parseError: null,
          schedules: parsed.triggers.schedules,
          isEnabled: true,
          updatedAt: new Date(),
        },
      })
      .returning();

    let matches = false;

    switch (context.event) {
      case 'push':
        matches = pushTriggerMatches(parsed.triggers.push, {
          branch: context.headBranch,
          tag: context.tag ?? null,
          changedPaths: context.changedPaths ?? null,
        });
        break;
      case 'pull_request':
        matches = pullRequestTriggerMatches(parsed.triggers.pullRequest, context.baseBranch ?? '');
        break;
      case 'workflow_dispatch':
        matches = parsed.triggers.workflowDispatch !== null;
        break;
      case 'schedule':
        matches = parsed.triggers.schedules.length > 0;
        break;
      case 'release':
        matches = parsed.triggers.release;
        break;
    }

    if (!matches) continue;

    const runId = await createRun(repository, workflow!, parsed, context);
    createdRuns.push(runId);
  }

  return createdRuns;
}

async function createRun(
  repository: typeof repositories.$inferSelect,
  workflow: typeof workflows.$inferSelect,
  parsed: NormalizedWorkflow,
  context: TriggerContext,
): Promise<string> {
  return db.transaction(async (tx) => {
    // Laufende Nummer je Repository, atomar über eine Unterabfrage ermittelt.
    const numberRows = await tx
      .select({ max: sql<number>`COALESCE(MAX(${workflowRuns.runNumber}), 0)::int` })
      .from(workflowRuns)
      .where(eq(workflowRuns.repositoryId, repository.id));

    const runNumber = (numberRows[0]?.max ?? 0) + 1;

    const [run] = await tx
      .insert(workflowRuns)
      .values({
        repositoryId: repository.id,
        workflowId: workflow.id,
        runNumber,
        runAttempt: 1,
        event: context.event,
        status: 'queued',
        headBranch: context.headBranch,
        headSha: context.headSha,
        definition: parsed as unknown as Record<string, unknown>,
        triggeredById: context.triggeredById ?? null,
        issueId: context.issueId ?? null,
      })
      .returning();

    for (const job of parsed.jobs) {
      const [created] = await tx
        .insert(workflowJobs)
        .values({
          runId: run!.id,
          jobKey: job.key,
          name: job.name,
          // Ein Job mit Abhängigkeiten wartet, bis diese fertig sind.
          status: job.needs.length > 0 ? 'waiting' : 'queued',
          requiredLabels: job.runsOn,
          dependsOn: job.needs,
          timeoutMinutes: job.timeoutMinutes,
        })
        .returning();

      await tx.insert(workflowSteps).values(
        job.steps.map((step, index) => ({
          jobId: created!.id,
          stepNumber: index + 1,
          name: step.name,
          status: 'queued' as const,
        })),
      );
    }

    return run!.id;
  });
}

/** Startet einen Lauf erneut – als neuer Versuch mit derselben Nummer. */
export async function retryRun(runId: string, actorId: string): Promise<string> {
  const rows = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
  const previous = rows[0];
  if (!previous) throw notFound('Lauf nicht gefunden.');

  const parsed = previous.definition as unknown as NormalizedWorkflow;

  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(workflowRuns)
      .values({
        repositoryId: previous.repositoryId,
        workflowId: previous.workflowId,
        runNumber: previous.runNumber,
        runAttempt: previous.runAttempt + 1,
        event: previous.event,
        status: 'queued',
        headBranch: previous.headBranch,
        headSha: previous.headSha,
        definition: previous.definition,
        triggeredById: actorId,
        issueId: previous.issueId,
      })
      .returning();

    for (const job of parsed.jobs) {
      const [created] = await tx
        .insert(workflowJobs)
        .values({
          runId: run!.id,
          jobKey: job.key,
          name: job.name,
          status: job.needs.length > 0 ? 'waiting' : 'queued',
          requiredLabels: job.runsOn,
          dependsOn: job.needs,
          timeoutMinutes: job.timeoutMinutes,
        })
        .returning();

      await tx.insert(workflowSteps).values(
        job.steps.map((step, index) => ({
          jobId: created!.id,
          stepNumber: index + 1,
          name: step.name,
          status: 'queued' as const,
        })),
      );
    }

    return run!.id;
  });
}

// ---------------------------------------------------------------------------
// Jobzuweisung
// ---------------------------------------------------------------------------

export interface JobAssignment {
  jobId: string;
  runId: string;
  jobKey: string;
  name: string;
  repositoryFullName: string;
  cloneUrl: string;
  headSha: string;
  headBranch: string | null;
  image: string;
  steps: {
    stepNumber: number;
    name: string;
    run: string | null;
    uses: string | null;
    with: Record<string, string>;
    env: Record<string, string>;
    workingDirectory: string | null;
    continueOnError: boolean;
    shell: string;
    if: string | null;
  }[];
  env: Record<string, string>;
  secrets: Record<string, string>;
  timeoutMinutes: number;
}

/**
 * Weist einem Runner den nächsten passenden Job zu.
 *
 * Der entscheidende Teil ist das `UPDATE ... WHERE id = (SELECT ...)` mit
 * `FOR UPDATE SKIP LOCKED`: zwei Runner, die gleichzeitig fragen, bekommen
 * garantiert verschiedene Jobs, ohne dass eine Sperre den anderen blockiert.
 */
export async function claimJob(
  runnerId: string,
  labels: string[],
  leaseSeconds = 120,
): Promise<JobAssignment | null> {
  // In rohem SQL muss der Zeitstempel als ISO-Zeichenkette übergeben werden;
  // der Treiber serialisiert ein Date-Objekt dort nicht automatisch.
  const leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();

  // Die Labels werden als jsonb-Array übergeben und mit dem Containment-
  // Operator verglichen. Ein `= ANY(...)` mit einem JavaScript-Array würde
  // hier als Record übergeben und von PostgreSQL abgelehnt.
  const labelsJson = JSON.stringify(labels);

  const claimed = await db.execute(sql`
    UPDATE workflow_jobs
    SET status = 'running',
        runner_id = ${runnerId},
        lease_expires_at = ${leaseUntil}::timestamptz,
        started_at = COALESCE(started_at, now())
    WHERE id = (
      SELECT j.id
      FROM workflow_jobs j
      JOIN workflow_runs r ON r.id = j.run_id
      WHERE j.status = 'queued'
        AND r.status IN ('queued', 'running')
        AND (
          j.required_labels = '[]'::jsonb
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(j.required_labels) AS required(label)
            WHERE required.label IN (
              SELECT jsonb_array_elements_text(${labelsJson}::jsonb)
            )
          )
        )
      ORDER BY j.created_at ASC
      FOR UPDATE OF j SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, run_id
  `);

  const row = (claimed as unknown as { id: string; run_id: string }[])[0];
  if (!row) return null;

  return buildAssignment(row.id, row.run_id);
}

async function buildAssignment(jobId: string, runId: string): Promise<JobAssignment | null> {
  const jobRows = await db.select().from(workflowJobs).where(eq(workflowJobs.id, jobId)).limit(1);
  const job = jobRows[0];
  if (!job) return null;

  const runRows = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
  const run = runRows[0];
  if (!run) return null;

  // Den Lauf auf "running" setzen, sobald der erste Job startet.
  if (run.status === 'queued') {
    await db
      .update(workflowRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(workflowRuns.id, runId));
  }

  const repoRows = await db
    .select({ repository: repositories, ownerName: namespaces.name })
    .from(repositories)
    .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
    .where(eq(repositories.id, run.repositoryId))
    .limit(1);

  const repoRow = repoRows[0];
  if (!repoRow) return null;

  const definition = run.definition as unknown as NormalizedWorkflow;
  const jobDefinition = definition.jobs.find((entry) => entry.key === job.jobKey);
  if (!jobDefinition) return null;

  // Secrets werden erst hier entschlüsselt und nur an den Runner gegeben, der
  // diesen Job ausführt. Sie landen nie in der Lauf-Definition und nicht in
  // einer API-Antwort für die Oberfläche.
  const secretRows = await db
    .select()
    .from(secrets)
    .where(
      or(
        eq(secrets.repositoryId, run.repositoryId),
        repoRow.repository.ownerNamespaceId
          ? sql`${secrets.organizationId} = (
              SELECT id FROM organizations WHERE namespace_id = ${repoRow.repository.ownerNamespaceId}
            )`
          : sql`false`,
      ),
    );

  const secretValues: Record<string, string> = {};
  for (const row of secretRows) {
    try {
      secretValues[row.name] = decryptSecret(row.valueEnc);
    } catch {
      // Ein beschädigtes Secret darf den Job nicht verhindern; der Schritt
      // schlägt dann mit einer leeren Variable fehl, was im Log sichtbar ist.
    }
  }

  const variableRows = await db
    .select()
    .from(variables)
    .where(eq(variables.repositoryId, run.repositoryId));

  const fullName = `${repoRow.ownerName}/${repoRow.repository.name}`;

  const env: Record<string, string> = {
    ...definition.env,
    ...jobDefinition.env,
    ...Object.fromEntries(variableRows.map((row) => [row.name, row.value])),
    FORGE_REPOSITORY: fullName,
    FORGE_SHA: run.headSha,
    FORGE_REF: run.headBranch ? `refs/heads/${run.headBranch}` : run.headSha,
    FORGE_RUN_NUMBER: String(run.runNumber),
    FORGE_RUN_ATTEMPT: String(run.runAttempt),
    FORGE_EVENT: run.event,
    FORGE_JOB: job.jobKey,
    CI: 'true',
  };

  /**
   * Kontext für `${{ ... }}`-Ausdrücke.
   *
   * Secrets stehen hier bewusst NICHT drin: `interpolate` wandelt
   * `${{ secrets.X }}` in `${FORGE_SECRET_X}` um, das die Shell erst im
   * Container aus der Umgebung auflöst. Dadurch steht der Geheimniswert
   * nirgends im gespeicherten Kommandotext und damit auch nicht im Log.
   */
  const expressionContext: Record<string, string> = {
    ...Object.fromEntries(Object.entries(env).map(([key, value]) => [`env.${key}`, value])),
    ...Object.fromEntries(variableRows.map((row) => [`vars.${row.name}`, row.value])),
    'forge.repository': fullName,
    'forge.sha': run.headSha,
    'forge.ref': run.headBranch ? `refs/heads/${run.headBranch}` : run.headSha,
    'forge.event': run.event,
    'forge.run_number': String(run.runNumber),
    'forge.run_attempt': String(run.runAttempt),
    'forge.job': job.jobKey,
    'forge.actor': run.triggeredById ?? '',
  };

  const expand = (value: string | null | undefined): string | null =>
    value === null || value === undefined ? null : interpolate(value, expressionContext);

  const expandMap = (source: Record<string, string> | undefined | null): Record<string, string> =>
    source
      ? Object.fromEntries(
          Object.entries(source).map(([key, value]) => [key, interpolate(value, expressionContext)]),
        )
      : {};

  // Auch die Job-Umgebung selbst kann Ausdrücke enthalten.
  for (const [key, value] of Object.entries(env)) {
    env[key] = interpolate(value, expressionContext);
  }

  return {
    jobId: job.id,
    runId: run.id,
    jobKey: job.jobKey,
    name: job.name,
    repositoryFullName: fullName,
    cloneUrl: `/git/${fullName}.git`,
    headSha: run.headSha,
    headBranch: run.headBranch,
    image: jobDefinition.image,
    steps: jobDefinition.steps.map((step, index) => ({
      stepNumber: index + 1,
      name: step.name,
      run: expand(step.run),
      uses: step.uses,
      with: expandMap(step.with),
      env: expandMap(step.env),
      workingDirectory: step.workingDirectory,
      continueOnError: step.continueOnError,
      shell: step.shell,
      if: step.if,
    })),
    env,
    secrets: secretValues,
    timeoutMinutes: job.timeoutMinutes,
  };
}

/** Verlängert die Lease eines laufenden Jobs. */
export async function heartbeatJob(
  jobId: string,
  runnerId: string,
  leaseSeconds = 120,
): Promise<boolean> {
  const updated = await db
    .update(workflowJobs)
    .set({ leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000) })
    .where(
      and(
        eq(workflowJobs.id, jobId),
        eq(workflowJobs.runnerId, runnerId),
        eq(workflowJobs.status, 'running'),
      ),
    )
    .returning({ id: workflowJobs.id });

  return updated.length > 0;
}

/**
 * Gibt Jobs frei, deren Runner sich nicht mehr meldet.
 *
 * Ohne diesen Schritt bliebe ein Job nach einem Runner-Absturz für immer auf
 * "running" stehen und der Lauf nie fertig.
 */
export async function reclaimExpiredJobs(): Promise<number> {
  const expired = await db
    .update(workflowJobs)
    .set({
      status: 'queued',
      runnerId: null,
      leaseExpiresAt: null,
      startedAt: null,
    })
    .where(
      and(
        eq(workflowJobs.status, 'running'),
        lt(workflowJobs.leaseExpiresAt, new Date()),
      ),
    )
    .returning({ id: workflowJobs.id });

  return expired.length;
}

// ---------------------------------------------------------------------------
// Fortschritt melden
// ---------------------------------------------------------------------------

export async function appendLog(
  jobId: string,
  stepNumber: number | null,
  content: string,
): Promise<void> {
  const sequenceRows = await db
    .select({ max: sql<number>`COALESCE(MAX(${workflowLogChunks.sequence}), -1)::int` })
    .from(workflowLogChunks)
    .where(eq(workflowLogChunks.jobId, jobId));

  await db.insert(workflowLogChunks).values({
    jobId,
    stepNumber,
    sequence: (sequenceRows[0]?.max ?? -1) + 1,
    content,
  });
}

export async function updateStep(
  jobId: string,
  stepNumber: number,
  patch: { status: RunStatus; exitCode?: number | null; startedAt?: boolean; completedAt?: boolean },
): Promise<void> {
  await db
    .update(workflowSteps)
    .set({
      status: patch.status,
      ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
      ...(patch.startedAt ? { startedAt: new Date() } : {}),
      ...(patch.completedAt ? { completedAt: new Date() } : {}),
    })
    .where(and(eq(workflowSteps.jobId, jobId), eq(workflowSteps.stepNumber, stepNumber)));
}

/**
 * Schließt einen Job ab und zieht die Folgen für den Lauf.
 *
 * Danach werden wartende Jobs freigegeben, deren Abhängigkeiten erfüllt sind,
 * und geprüft, ob der Lauf insgesamt fertig ist.
 */
export async function completeJob(
  jobId: string,
  status: RunStatus,
  exitCode: number | null,
  errorMessage: string | null,
): Promise<void> {
  const jobRows = await db.select().from(workflowJobs).where(eq(workflowJobs.id, jobId)).limit(1);
  const job = jobRows[0];
  if (!job) return;

  await db
    .update(workflowJobs)
    .set({
      status,
      exitCode,
      errorMessage,
      completedAt: new Date(),
      leaseExpiresAt: null,
    })
    .where(eq(workflowJobs.id, jobId));

  await releaseDependentJobs(job.runId);
  await finalizeRunIfComplete(job.runId);
}

/**
 * Setzt wartende Jobs auf "queued", sobald alle Abhängigkeiten erfolgreich
 * abgeschlossen sind. Ist eine Abhängigkeit fehlgeschlagen, wird der Job
 * übersprungen statt ewig zu warten.
 */
async function releaseDependentJobs(runId: string): Promise<void> {
  const allJobs = await db.select().from(workflowJobs).where(eq(workflowJobs.runId, runId));
  const byKey = new Map(allJobs.map((job) => [job.jobKey, job]));

  for (const job of allJobs) {
    if (job.status !== 'waiting') continue;

    const dependencies = job.dependsOn.map((key) => byKey.get(key)).filter(Boolean);

    const allDone = dependencies.every(
      (dependency) =>
        dependency &&
        ['success', 'failure', 'cancelled', 'timed_out', 'skipped'].includes(dependency.status),
    );
    if (!allDone) continue;

    const allSucceeded = dependencies.every((dependency) => dependency?.status === 'success');

    await db
      .update(workflowJobs)
      .set(
        allSucceeded
          ? { status: 'queued' }
          : { status: 'skipped', completedAt: new Date(), errorMessage: 'Vorausgesetzter Job war nicht erfolgreich.' },
      )
      .where(eq(workflowJobs.id, job.id));
  }
}

/** Setzt den Gesamtstatus des Laufs, sobald kein Job mehr offen ist. */
async function finalizeRunIfComplete(runId: string): Promise<void> {
  const jobs = await db.select().from(workflowJobs).where(eq(workflowJobs.runId, runId));

  const open = jobs.filter((job) => ['queued', 'waiting', 'running'].includes(job.status));
  if (open.length > 0) return;

  const hasFailure = jobs.some((job) => job.status === 'failure');
  const hasTimeout = jobs.some((job) => job.status === 'timed_out');
  const hasCancelled = jobs.some((job) => job.status === 'cancelled');

  const status: RunStatus = hasTimeout
    ? 'timed_out'
    : hasFailure
      ? 'failure'
      : hasCancelled
        ? 'cancelled'
        : 'success';

  const updated = await db
    .update(workflowRuns)
    .set({ status, completedAt: new Date() })
    .where(and(eq(workflowRuns.id, runId), inArray(workflowRuns.status, ['queued', 'running'])))
    .returning();

  if (updated.length === 0) return;

  const run = updated[0]!;

  void dispatchWebhook({
    event: 'workflow_run',
    repositoryId: run.repositoryId,
    payload: {
      action: 'completed',
      run: { runNumber: run.runNumber, status, headSha: run.headSha, headBranch: run.headBranch },
    },
  });

  // Bei einem Fehlschlag wird der Auslösende benachrichtigt – wer eine CI
  // anstößt, will wissen, wenn sie rot wird.
  if (status !== 'success' && run.triggeredById) {
    const repoRows = await db
      .select({ name: repositories.name, ownerName: namespaces.name })
      .from(repositories)
      .innerJoin(namespaces, eq(namespaces.id, repositories.ownerNamespaceId))
      .where(eq(repositories.id, run.repositoryId))
      .limit(1);

    if (repoRows[0]) {
      const fullName = `${repoRows[0].ownerName}/${repoRows[0].name}`;
      await notify({
        repositoryId: run.repositoryId,
        subjectType: 'workflow_run',
        subjectId: run.id,
        title: `${fullName}: Lauf #${run.runNumber} ist fehlgeschlagen`,
        targetPath: `/${fullName}/actions/runs/${run.id}`,
        actorId: null,
        recipients: [{ userId: run.triggeredById, reason: 'workflow_failure' }],
      }).catch(() => {});
    }
  }
}

/** Bricht einen Lauf und alle seine offenen Jobs ab. */
export async function cancelRun(runId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(workflowJobs)
      .set({ status: 'cancelled', completedAt: new Date(), leaseExpiresAt: null })
      .where(
        and(
          eq(workflowJobs.runId, runId),
          inArray(workflowJobs.status, ['queued', 'waiting', 'running']),
        ),
      );

    await tx
      .update(workflowRuns)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(eq(workflowRuns.id, runId));
  });
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

export async function listWorkflows(repositoryId: string): Promise<WorkflowSummary[]> {
  const rows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.repositoryId, repositoryId))
    .orderBy(asc(workflows.name));

  return Promise.all(
    rows.map(async (row) => {
      const runRows = await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.workflowId, row.id))
        .orderBy(desc(workflowRuns.createdAt))
        .limit(1);

      return {
        id: row.id,
        name: row.name,
        path: row.path,
        isEnabled: row.isEnabled,
        parseError: row.parseError,
        lastRun: runRows[0] ? await toRunSummary(runRows[0], row.name) : null,
      };
    }),
  );
}

async function toRunSummary(
  row: typeof workflowRuns.$inferSelect,
  workflowName: string,
): Promise<WorkflowRunSummary> {
  const refs = await loadUserRefs([row.triggeredById]);

  const durationMs =
    row.startedAt && row.completedAt
      ? row.completedAt.getTime() - row.startedAt.getTime()
      : row.startedAt
        ? Date.now() - row.startedAt.getTime()
        : null;

  return {
    id: row.id,
    runNumber: row.runNumber,
    runAttempt: row.runAttempt,
    workflowName,
    event: row.event,
    status: row.status,
    headBranch: row.headBranch,
    headSha: row.headSha,
    triggeredBy: row.triggeredById ? (refs.get(row.triggeredById) ?? null) : null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    durationMs,
  };
}

export async function listRuns(
  repositoryId: string,
  filter: { status?: RunStatus; branch?: string; workflowId?: string; page: number; perPage: number },
): Promise<{ items: WorkflowRunSummary[]; totalCount: number }> {
  const conditions = [eq(workflowRuns.repositoryId, repositoryId)];
  if (filter.status) conditions.push(eq(workflowRuns.status, filter.status));
  if (filter.branch) conditions.push(eq(workflowRuns.headBranch, filter.branch));
  if (filter.workflowId) conditions.push(eq(workflowRuns.workflowId, filter.workflowId));

  const where = and(...conditions);

  const rows = await db
    .select({ run: workflowRuns, workflowName: workflows.name })
    .from(workflowRuns)
    .leftJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(where)
    .orderBy(desc(workflowRuns.createdAt))
    .limit(filter.perPage)
    .offset((filter.page - 1) * filter.perPage);

  const totalRows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(workflowRuns)
    .where(where);

  const items = await Promise.all(
    rows.map((row) => toRunSummary(row.run, row.workflowName ?? 'Workflow')),
  );

  return { items, totalCount: totalRows[0]?.total ?? 0 };
}

export async function getRunDetail(runId: string): Promise<WorkflowRunDetail | null> {
  const rows = await db
    .select({ run: workflowRuns, workflowName: workflows.name })
    .from(workflowRuns)
    .leftJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(eq(workflowRuns.id, runId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const summary = await toRunSummary(row.run, row.workflowName ?? 'Workflow');

  const jobRows = await db
    .select({ job: workflowJobs, runnerName: runners.name })
    .from(workflowJobs)
    .leftJoin(runners, eq(runners.id, workflowJobs.runnerId))
    .where(eq(workflowJobs.runId, runId))
    .orderBy(asc(workflowJobs.createdAt));

  const jobs: WorkflowJobDetail[] = await Promise.all(
    jobRows.map(async (entry) => {
      const steps = await db
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.jobId, entry.job.id))
        .orderBy(asc(workflowSteps.stepNumber));

      return {
        id: entry.job.id,
        jobKey: entry.job.jobKey,
        name: entry.job.name,
        status: entry.job.status,
        requiredLabels: entry.job.requiredLabels,
        dependsOn: entry.job.dependsOn,
        runnerName: entry.runnerName,
        exitCode: entry.job.exitCode,
        errorMessage: entry.job.errorMessage,
        startedAt: entry.job.startedAt?.toISOString() ?? null,
        completedAt: entry.job.completedAt?.toISOString() ?? null,
        steps: steps.map((step) => ({
          id: step.id,
          stepNumber: step.stepNumber,
          name: step.name,
          status: step.status,
          exitCode: step.exitCode,
          startedAt: step.startedAt?.toISOString() ?? null,
          completedAt: step.completedAt?.toISOString() ?? null,
        })),
      };
    }),
  );

  // Artefakte des Laufs. Sie entstehen erst während der Ausführung, deshalb
  // werden sie bei jedem Abruf frisch gelesen statt im Lauf gespeichert.
  const artifactRows = await db
    .select({
      id: workflowArtifacts.id,
      name: workflowArtifacts.name,
      sizeBytes: workflowArtifacts.sizeBytes,
      createdAt: workflowArtifacts.createdAt,
      expiresAt: workflowArtifacts.expiresAt,
    })
    .from(workflowArtifacts)
    .where(eq(workflowArtifacts.runId, runId))
    .orderBy(asc(workflowArtifacts.name));

  const artifacts = artifactRows.map((row) => ({
    id: row.id,
    name: row.name,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }));

  return { ...summary, jobs, artifacts };
}

export async function getJobLog(jobId: string): Promise<string> {
  const chunks = await db
    .select({ content: workflowLogChunks.content })
    .from(workflowLogChunks)
    .where(eq(workflowLogChunks.jobId, jobId))
    .orderBy(asc(workflowLogChunks.sequence));

  return chunks.map((chunk) => chunk.content).join('');
}
