/**
 * Actions: Workflows, Läufe, Jobs und Logs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  RepositoryDetail,
  RunStatus,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowSummary,
} from '@forge/shared';
import { hasAccess, isTerminalStatus } from '@forge/shared';
import { BASE_URL, api } from '../lib/api.js';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Panel,
  Select,
  Spin,
  cx,
  formatBytes,
  relativeTime,
} from '../components/ui.js';
import { Avatar } from '../components/Shell.js';

// ---------------------------------------------------------------------------
// Statusanzeige
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<RunStatus, { label: string; color: string; icon: string }> = {
  queued: { label: 'Wartet', color: 'text-warning', icon: '○' },
  waiting: { label: 'Blockiert', color: 'text-faint', icon: '◌' },
  running: { label: 'Läuft', color: 'text-warning', icon: '◐' },
  success: { label: 'Erfolgreich', color: 'text-success', icon: '✓' },
  failure: { label: 'Fehlgeschlagen', color: 'text-danger', icon: '✗' },
  cancelled: { label: 'Abgebrochen', color: 'text-faint', icon: '⊘' },
  timed_out: { label: 'Zeitüberschreitung', color: 'text-danger', icon: '⏱' },
  skipped: { label: 'Übersprungen', color: 'text-faint', icon: '–' },
};

export function StatusIcon({ status }: { status: RunStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 text-xs font-medium',
        config.color,
        status === 'running' && 'animate-pulse',
      )}
      title={config.label}
    >
      <span>{config.icon}</span>
    </span>
  );
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '–';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

// ---------------------------------------------------------------------------
// Übersicht
// ---------------------------------------------------------------------------

export function ActionsPage({ repo }: { repo: RepositoryDetail }) {
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);

  const canWrite = hasAccess(repo.viewerAccess, 'write');

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api.get<{ items: WorkflowSummary[] }>(`/api/v1/repos/${repoPath}/workflows`, controller.signal),
      api.get<{ items: WorkflowRunSummary[] }>(
        `/api/v1/repos/${repoPath}/actions/runs?perPage=25${filter ? `&workflowId=${filter}` : ''}`,
        controller.signal,
      ),
    ])
      .then(([w, r]) => {
        setWorkflows(w.items);
        setRuns(r.items);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [repoPath, filter, version]);

  // Solange ein Lauf aktiv ist, wird regelmäßig neu geladen. Für eine Seite,
  // die man ohnehin nur beim Zuschauen offen hat, ist das angemessen und
  // kommt ohne zusätzliche Verbindung aus.
  useEffect(() => {
    if (!runs?.some((run) => !isTerminalStatus(run.status))) return;
    const timer = setInterval(() => setVersion((value) => value + 1), 4000);
    return () => clearInterval(timer);
  }, [runs]);

  if (error) return <ErrorBox error={error} />;
  if (!workflows || !runs) return <Spin />;

  const broken = workflows.filter((workflow) => workflow.parseError);

  return (
    <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
      <aside className="space-y-3">
        <Panel title="Workflows" bodyClassName="divide-y divide-line">
          <button
            type="button"
            onClick={() => setFilter('')}
            className={cx(
              'block w-full px-4 py-2 text-left text-xs',
              !filter ? 'bg-raised font-medium text-ink' : 'text-muted hover:bg-raised',
            )}
          >
            Alle Läufe
          </button>
          {workflows.map((workflow) => (
            <button
              key={workflow.id}
              type="button"
              onClick={() => setFilter(workflow.id)}
              className={cx(
                'block w-full px-4 py-2 text-left text-xs',
                filter === workflow.id ? 'bg-raised font-medium text-ink' : 'text-muted hover:bg-raised',
              )}
            >
              <span className="flex items-center gap-1.5">
                {workflow.parseError && <span className="text-danger">⚠</span>}
                {!workflow.isEnabled && <span className="text-faint">○</span>}
                {workflow.name}
              </span>
              <span className="block font-mono text-[0.65rem] text-faint">{workflow.path}</span>
            </button>
          ))}
          {workflows.length === 0 && (
            <p className="px-4 py-3 text-xs text-faint">Keine Workflow-Dateien gefunden.</p>
          )}
        </Panel>

        {canWrite && (
          <Panel title="Runner" bodyClassName="p-3">
            <Link to={`/${repoPath}/settings/runners`} className="text-xs text-accent hover:underline">
              Runner verwalten →
            </Link>
          </Panel>
        )}
      </aside>

      <div className="space-y-4">
        {broken.map((workflow) => (
          <Alert key={workflow.id} tone="danger" title={`${workflow.path} ist fehlerhaft`}>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-2xs">{workflow.parseError}</pre>
          </Alert>
        ))}

        {workflows.length === 0 && (
          <Panel title="Noch keine Workflows" bodyClassName="space-y-3 p-5">
            <p className="text-sm text-muted">
              Lege eine Datei unter <code className="code">.forge/workflows/</code> an. Hier ein
              Beispiel zum Einstieg:
            </p>
            <pre className="overflow-x-auto border border-line bg-raised p-3 font-mono text-2xs leading-relaxed">
              <code>{`name: Build

on:
  push:
    branches:
      - ${repo.defaultBranch}

jobs:
  bauen:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: forge/checkout@v1
      - name: Tests
        run: |
          echo "Hier kommen deine Tests hin"`}</code>
            </pre>
            <p className="text-xs text-faint">
              Danach brauchst du einen Runner, der die Jobs ausführt.
            </p>
          </Panel>
        )}

        <Panel title={`${runs.length} Läufe`} bodyClassName="divide-y divide-line">
          {runs.length === 0 ? (
            <EmptyState
              title="Noch keine Läufe"
              description="Ein Push auf einen passenden Branch startet den ersten Lauf."
            />
          ) : (
            runs.map((run) => (
              <Link
                key={run.id}
                to={`/${repoPath}/actions/runs/${run.id}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-raised/50"
              >
                <StatusIcon status={run.status} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{run.workflowName}</p>
                  <p className="text-2xs text-faint">
                    #{run.runNumber}
                    {run.runAttempt > 1 && `.${run.runAttempt}`} · {run.event}
                    {run.headBranch && (
                      <>
                        {' '}auf <code className="font-mono">{run.headBranch}</code>
                      </>
                    )}{' '}
                    · <code className="font-mono">{run.headSha.slice(0, 7)}</code>
                  </p>
                </div>
                <div className="shrink-0 text-right text-2xs text-faint">
                  <p>{formatDuration(run.durationMs)}</p>
                  <p>{relativeTime(run.createdAt)}</p>
                </div>
              </Link>
            ))
          )}
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lauf-Detail
// ---------------------------------------------------------------------------

export function RunDetailPage({ repo }: { repo: RepositoryDetail }) {
  const { runId = '' } = useParams();
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const [data, setData] = useState<{
    run: WorkflowRunDetail;
    artifacts: { id: string; name: string; sizeBytes: number; expiresAt: string | null }[];
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);

  const canWrite = hasAccess(repo.viewerAccess, 'write');
  const reload = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<typeof data>(`/api/v1/repos/${repoPath}/actions/runs/${runId}`, controller.signal)
      .then((result) => {
        setData(result);
        if (!selectedJob && result?.run.jobs[0]) setSelectedJob(result.run.jobs[0].id);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [repoPath, runId, version]);

  useEffect(() => {
    if (!data || isTerminalStatus(data.run.status)) return;
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, [data, reload]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Spin />;

  const { run } = data;

  async function retry() {
    const result = await api.post<{ runId: string }>(
      `/api/v1/repos/${repoPath}/actions/runs/${runId}/retry`,
    );
    window.location.href = `/${repoPath}/actions/runs/${result.runId}`;
  }

  async function cancel() {
    await api.post(`/api/v1/repos/${repoPath}/actions/runs/${runId}/cancel`);
    reload();
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <StatusIcon status={run.status} />
            {run.workflowName}
            <span className="font-normal text-faint">
              #{run.runNumber}
              {run.runAttempt > 1 && `.${run.runAttempt}`}
            </span>
          </h2>
          <p className="mt-1 text-xs text-muted">
            {STATUS_CONFIG[run.status].label} · ausgelöst durch {run.event}
            {run.triggeredBy && (
              <>
                {' '}von{' '}
                <Link to={`/${run.triggeredBy.username}`} className="link">
                  {run.triggeredBy.username}
                </Link>
              </>
            )}{' '}
            · {formatDuration(run.durationMs)} · {relativeTime(run.createdAt)}
          </p>
          <p className="mt-1 text-2xs text-faint">
            {run.headBranch && (
              <>
                Branch <code className="font-mono">{run.headBranch}</code> ·{' '}
              </>
            )}
            <Link to={`/${repoPath}/commit/${run.headSha}`} className="font-mono hover:text-accent">
              {run.headSha.slice(0, 8)}
            </Link>
          </p>
        </div>

        {canWrite && (
          <div className="flex gap-2">
            {!isTerminalStatus(run.status) && (
              <Button size="sm" variant="danger" onClick={cancel}>
                Abbrechen
              </Button>
            )}
            {isTerminalStatus(run.status) && (
              <Button size="sm" onClick={retry}>
                Erneut ausführen
              </Button>
            )}
          </div>
        )}
      </header>

      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <aside className="space-y-3">
          <Panel title="Jobs" bodyClassName="divide-y divide-line">
            {run.jobs.map((job) => (
              <button
                key={job.id}
                type="button"
                onClick={() => setSelectedJob(job.id)}
                className={cx(
                  'block w-full px-3 py-2 text-left',
                  selectedJob === job.id ? 'bg-raised' : 'hover:bg-raised/60',
                )}
              >
                <span className="flex items-center gap-2 text-xs font-medium">
                  <StatusIcon status={job.status} />
                  {job.name}
                </span>
                <span className="mt-0.5 block text-2xs text-faint">
                  {job.dependsOn.length > 0 && `braucht: ${job.dependsOn.join(', ')} · `}
                  {job.runnerName ?? 'kein Runner'}
                </span>
              </button>
            ))}
          </Panel>

          {data.artifacts.length > 0 && (
            <Panel title="Artefakte" bodyClassName="divide-y divide-line">
              {data.artifacts.map((artifact) => (
                <a
                  key={artifact.id}
                  href={`${BASE_URL}/api/v1/repos/${repoPath}/actions/artifacts/${artifact.id}`}
                  className="flex items-center justify-between px-3 py-2 text-xs hover:bg-raised"
                >
                  <span className="truncate">{artifact.name}</span>
                  <span className="shrink-0 text-2xs text-faint">
                    {formatBytes(artifact.sizeBytes)}
                  </span>
                </a>
              ))}
            </Panel>
          )}
        </aside>

        <div>
          {selectedJob && (
            <JobView
              job={run.jobs.find((job) => job.id === selectedJob)!}
              repoPath={repoPath}
              live={!isTerminalStatus(run.status)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function JobView({
  job,
  repoPath,
  live,
}: {
  job: WorkflowRunDetail['jobs'][number];
  repoPath: string;
  live: boolean;
}) {
  const [log, setLog] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch(
          `${BASE_URL}/api/v1/repos/${repoPath}/actions/jobs/${job.id}/logs`,
          { credentials: 'include' },
        );
        if (!response.ok) return;
        const text = await response.text();
        if (!cancelled) {
          setLog(text);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    if (!live) return () => {
      cancelled = true;
    };

    const timer = setInterval(load, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [repoPath, job.id, live]);

  // Beim Mitlesen eines laufenden Jobs ans Ende springen – aber nur, wenn der
  // Benutzer nicht selbst nach oben gescrollt hat.
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log, autoScroll]);

  return (
    <div className="space-y-3">
      <Panel title={job.name} bodyClassName="divide-y divide-line">
        {job.steps.map((step) => (
          <div key={step.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
            <StatusIcon status={step.status} />
            <span className="flex-1 truncate">{step.name}</span>
            {step.exitCode !== null && step.exitCode !== 0 && (
              <Badge tone="danger">Code {step.exitCode}</Badge>
            )}
            {step.startedAt && step.completedAt && (
              <span className="text-2xs text-faint">
                {formatDuration(
                  new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime(),
                )}
              </span>
            )}
          </div>
        ))}
      </Panel>

      {job.errorMessage && <Alert tone="danger">{job.errorMessage}</Alert>}

      <Panel
        title="Ausgabe"
        actions={
          live && (
            <label className="flex items-center gap-1.5 text-2xs text-muted">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(event) => setAutoScroll(event.target.checked)}
                className="accent-[rgb(var(--accent))]"
              />
              Mitlaufen
            </label>
          )
        }
        bodyClassName=""
      >
        {loading ? (
          <Spin label="Log wird geladen…" />
        ) : log ? (
          <pre
            ref={logRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              const atBottom =
                element.scrollHeight - element.scrollTop - element.clientHeight < 40;
              if (!atBottom && autoScroll) setAutoScroll(false);
            }}
            className="max-h-[600px] overflow-auto bg-canvas p-3 font-mono text-[0.75rem] leading-relaxed text-muted"
          >
            {log}
          </pre>
        ) : (
          <p className="p-6 text-center text-sm text-faint">
            {job.status === 'queued' || job.status === 'waiting'
              ? 'Der Job wartet noch auf einen Runner.'
              : 'Keine Ausgabe.'}
          </p>
        )}
      </Panel>
    </div>
  );
}
