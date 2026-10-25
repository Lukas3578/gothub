/**
 * Pull Requests: Liste, Anlegen, Detailansicht mit Unterhaltung, Änderungen
 * und Commits.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  BranchInfo,
  CommitSummary,
  DiffFile,
  DiffStats,
  IssueSummary,
  PullRequestDetail,
  RepositoryDetail,
  ReviewComment,
  TimelineEntry,
} from '@forge/shared';
import { hasAccess } from '@forge/shared';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Input,
  Panel,
  Select,
  Spin,
  Textarea,
  cx,
  formatNumber,
  plural,
  relativeTime,
} from '../components/ui.js';
import { Avatar } from '../components/Shell.js';
import {
  CommentEditor,
  Reactions,
  SidebarSection,
  StateBadge,
  Timeline,
  UserList,
} from '../components/conversation.js';
import { DiffPanel } from './repository.js';
import { Markdown } from '../components/Markdown.js';
import { IssueRow } from './issues.js';

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

export function PullListPage({ repo }: { repo: RepositoryDetail }) {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<{
    items: IssueSummary[];
    openCount: number;
    closedCount: number;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);

  const state = params.get('state') ?? 'open';
  const search = params.get('q') ?? '';
  const base = `/${repo.ownerName}/${repo.name}`;

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ state, perPage: '25' });
      if (search) query.set('search', search);

      api
        .get<typeof data>(
          `/api/v1/repos/${repo.ownerName}/${repo.name}/pulls?${query}`,
          controller.signal,
        )
        .then(setData)
        .catch((err) => {
          if (err.name !== 'AbortError') setError(err);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [repo.ownerName, repo.name, state, search]);

  if (error) return <ErrorBox error={error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <Input
            placeholder="Pull Requests durchsuchen"
            value={search}
            onChange={(event) => update('q', event.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <Link
          to={`${base}/pulls/new`}
          className="flex h-8 items-center border border-accent bg-accent px-3 text-xs font-medium text-accent-ink hover:bg-accent/90"
        >
          Neuer Pull Request
        </Link>
      </div>

      <Panel
        title={
          <div className="flex gap-4 text-xs">
            <button
              type="button"
              onClick={() => update('state', 'open')}
              className={cx('font-medium', state === 'open' ? 'text-ink' : 'text-muted hover:text-ink')}
            >
              {formatNumber(data?.openCount ?? 0)} offen
            </button>
            <button
              type="button"
              onClick={() => update('state', 'closed')}
              className={cx('font-medium', state === 'closed' ? 'text-ink' : 'text-muted hover:text-ink')}
            >
              {formatNumber(data?.closedCount ?? 0)} geschlossen
            </button>
          </div>
        }
        bodyClassName="divide-y divide-line"
      >
        {!data ? (
          <Spin />
        ) : data.items.length === 0 ? (
          <EmptyState
            title="Keine Pull Requests"
            description="Pushe einen Branch und schlage deine Änderungen vor."
          />
        ) : (
          data.items.map((issue) => (
            <IssueRow key={issue.id} issue={issue} base={base} kind="pulls" />
          ))
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Neuer Pull Request
// ---------------------------------------------------------------------------

export function NewPullPage({ repo }: { repo: RepositoryDetail }) {
  const navigate = useNavigate();
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [baseBranch, setBaseBranch] = useState(repo.defaultBranch);
  const [headBranch, setHeadBranch] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [compare, setCompare] = useState<{
    commits: CommitSummary[];
    files: DiffFile[];
    stats: DiffStats;
    mergeable: boolean;
    conflictingFiles: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const repoPath = `${repo.ownerName}/${repo.name}`;

  useEffect(() => {
    api
      .get<{ items: BranchInfo[] }>(`/api/v1/repos/${repoPath}/branches`)
      .then((d) => {
        setBranches(d.items);
        const candidate = d.items.find((branch) => !branch.isDefault);
        if (candidate) setHeadBranch(candidate.name);
      })
      .catch(() => {});
  }, [repoPath]);

  // Vergleich laden, sobald beide Branches feststehen. Daraus wird auch ein
  // Titelvorschlag abgeleitet.
  useEffect(() => {
    if (!headBranch || headBranch === baseBranch) {
      setCompare(null);
      return;
    }
    const controller = new AbortController();
    api
      .get<typeof compare>(
        `/api/v1/repos/${repoPath}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}`,
        controller.signal,
      )
      .then((data) => {
        setCompare(data);
        if (!title && data?.commits.length) {
          setTitle(
            data.commits.length === 1 ? data.commits[0]!.subject : `Änderungen aus ${headBranch}`,
          );
        }
      })
      .catch(() => setCompare(null));
    return () => controller.abort();
  }, [repoPath, baseBranch, headBranch]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<PullRequestDetail>(`/api/v1/repos/${repoPath}/pulls`, {
        title,
        body: body || null,
        base: baseBranch,
        head: headBranch,
        draft,
      });
      navigate(`/${repoPath}/pulls/${created.number}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anlegen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h2 className="text-lg font-semibold">Neuer Pull Request</h2>
      {error && <Alert tone="danger">{error}</Alert>}

      <Panel bodyClassName="flex flex-wrap items-end gap-3 p-4">
        <div className="w-56">
          <Select
            label="Basis (wohin)"
            value={baseBranch}
            onChange={(event) => setBaseBranch(event.target.value)}
          >
            {branches.map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name}
              </option>
            ))}
          </Select>
        </div>
        <span className="pb-2 text-muted">←</span>
        <div className="w-56">
          <Select
            label="Quelle (woher)"
            value={headBranch}
            onChange={(event) => setHeadBranch(event.target.value)}
          >
            <option value="">Branch wählen…</option>
            {branches.map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name}
              </option>
            ))}
          </Select>
        </div>

        {compare && (
          <div className="pb-1 text-xs text-muted">
            {plural(compare.commits.length, 'Commit', 'Commits')} ·{' '}
            {plural(compare.stats.filesChanged, 'Datei', 'Dateien')} ·{' '}
            <span className="text-success">+{compare.stats.additions}</span>{' '}
            <span className="text-danger">−{compare.stats.deletions}</span>
            {!compare.mergeable && (
              <span className="ml-2 text-danger">
                Konflikte in {plural(compare.conflictingFiles.length, 'Datei', 'Dateien')}
              </span>
            )}
          </div>
        )}
      </Panel>

      {headBranch && headBranch !== baseBranch && (
        <>
          <Input
            label="Titel"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />

          <CommentEditor
            value={body}
            onChange={setBody}
            onSubmit={submit}
            submitLabel={draft ? 'Als Entwurf anlegen' : 'Pull Request anlegen'}
            placeholder="Was ändert dieser Pull Request? Schreibe &quot;Closes #12&quot;, um ein Issue beim Mergen automatisch zu schließen."
            busy={busy}
            minRows={8}
            extraActions={
              <label className="flex items-center gap-1.5 text-2xs text-muted">
                <input
                  type="checkbox"
                  checked={draft}
                  onChange={(event) => setDraft(event.target.checked)}
                  className="accent-[rgb(var(--accent))]"
                />
                Als Entwurf
              </label>
            }
          />

          {compare && compare.commits.length > 0 && (
            <Panel title={plural(compare.commits.length, 'Commit', 'Commits')} bodyClassName="divide-y divide-line">
              {compare.commits.map((commit) => (
                <div key={commit.oid} className="flex items-center gap-3 px-4 py-2 text-xs">
                  <code className="font-mono text-faint">{commit.shortOid}</code>
                  <span className="truncate">{commit.subject}</span>
                  <span className="ml-auto shrink-0 text-faint">{commit.author.name}</span>
                </div>
              ))}
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function PullDetailPage({ repo }: { repo: RepositoryDetail }) {
  const { number = '' } = useParams();
  const [data, setData] = useState<{ pullRequest: PullRequestDetail; timeline: TimelineEntry[] } | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);

  const repoPath = `${repo.ownerName}/${repo.name}`;
  const reload = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<typeof data>(`/api/v1/repos/${repoPath}/pulls/${number}`, controller.signal)
      .then(setData)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [repoPath, number, version]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Spin />;

  const pr = data.pullRequest;
  const base = `/${repoPath}/pulls/${number}`;

  return (
    <div className="space-y-4">
      <header className="border-b border-line pb-3">
        <h1 className="text-xl font-semibold">
          {pr.title} <span className="font-normal text-faint">#{pr.number}</span>
        </h1>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted">
          <StateBadge state={pr.state} kind="pull_request" merged={pr.merged} isDraft={pr.isDraft} />
          <span>
            {pr.author && <strong className="text-ink">{pr.author.username}</strong>} möchte{' '}
            {pr.commitCount} {pr.commitCount === 1 ? 'Commit' : 'Commits'} von{' '}
            <code className="font-mono text-ink">{pr.head.branch}</code> nach{' '}
            <code className="font-mono text-ink">{pr.base.branch}</code> übernehmen
          </span>
        </div>

        <nav className="-mb-px mt-3 flex gap-1">
          <PullTab to={base} end>
            Unterhaltung
          </PullTab>
          <PullTab to={`${base}/files`}>
            Änderungen{' '}
            <span className="ml-1 border border-line-strong px-1 text-2xs">{pr.changedFiles}</span>
          </PullTab>
          <PullTab to={`${base}/commits`}>
            Commits{' '}
            <span className="ml-1 border border-line-strong px-1 text-2xs">{pr.commitCount}</span>
          </PullTab>
        </nav>
      </header>

      <Routes>
        <Route index element={<PullConversation pr={pr} data={data} repo={repo} onReload={reload} />} />
        <Route path="files" element={<PullFiles pr={pr} repo={repo} onReload={reload} />} />
        <Route path="commits" element={<PullCommits pr={pr} repo={repo} />} />
      </Routes>
    </div>
  );
}

function PullTab({ to, end, children }: { to: string; end?: boolean; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'border-b-2 px-3 py-1.5 text-xs font-medium',
          isActive
            ? 'border-accent text-ink'
            : 'border-transparent text-muted hover:border-line-strong hover:text-ink',
        )
      }
    >
      {children}
    </NavLink>
  );
}

// ---------------------------------------------------------------------------

function PullConversation({
  pr,
  data,
  repo,
  onReload,
}: {
  pr: PullRequestDetail;
  data: { timeline: TimelineEntry[] };
  repo: RepositoryDetail;
  onReload: () => void;
}) {
  const { viewer } = useSession();
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  async function submitComment() {
    setBusy(true);
    try {
      await api.post(`/api/v1/repos/${repoPath}/issues/${pr.number}/comments`, { body: comment });
      setComment('');
      onReload();
    } finally {
      setBusy(false);
    }
  }

  async function toggleReaction(content: string) {
    await api.post(`/api/v1/repos/${repoPath}/reactions/issue/${pr.id}`, { content });
    onReload();
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
      <div className="space-y-3">
        <article className="panel">
          <header className="panel-header">
            <div className="flex items-center gap-2 text-xs">
              <Avatar name={pr.author?.username ?? '?'} size={20} url={pr.author?.avatarUrl} />
              {pr.author && (
                <Link to={`/${pr.author.username}`} className="font-semibold hover:text-accent">
                  {pr.author.username}
                </Link>
              )}
              <span className="text-faint">eröffnete {relativeTime(pr.createdAt)}</span>
            </div>
          </header>
          <div className="p-4">
            {pr.body ? (
              <Markdown source={pr.body} />
            ) : (
              <p className="text-sm italic text-faint">Keine Beschreibung angegeben.</p>
            )}
          </div>
          <footer className="border-t border-line px-4 py-2">
            <Reactions reactions={pr.reactions} onToggle={toggleReaction} disabled={!viewer} />
          </footer>
        </article>

        <Timeline entries={data.timeline} repoPath={repoPath} onReload={onReload} />

        <MergeBox pr={pr} repo={repo} onReload={onReload} />

        {viewer && (
          <CommentEditor
            value={comment}
            onChange={setComment}
            onSubmit={submitComment}
            submitLabel="Kommentieren"
            busy={busy}
          />
        )}

        {viewer && !pr.merged && pr.state === 'open' && (
          <ReviewBox pr={pr} repoPath={repoPath} onReload={onReload} />
        )}
      </div>

      <aside className="panel px-4">
        <SidebarSection title="Reviewer">
          {pr.reviewers.length === 0 ? (
            <p className="text-xs text-faint">Noch keine Reviewer.</p>
          ) : (
            <ul className="space-y-1.5">
              {pr.reviewers.map((entry) => (
                <li key={entry.user.id} className="flex items-center gap-2">
                  <Avatar name={entry.user.username} size={18} url={entry.user.avatarUrl} />
                  <Link to={`/${entry.user.username}`} className="text-xs hover:text-accent">
                    {entry.user.username}
                  </Link>
                  <span
                    className={cx(
                      'ml-auto text-2xs',
                      entry.state === 'approved'
                        ? 'text-success'
                        : entry.state === 'changes_requested'
                          ? 'text-danger'
                          : 'text-faint',
                    )}
                  >
                    {entry.state === 'approved'
                      ? '✓'
                      : entry.state === 'changes_requested'
                        ? '✗'
                        : '○'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SidebarSection>

        <SidebarSection title="Zuständig">
          <UserList users={pr.assignees} empty="Niemand zugewiesen." />
        </SidebarSection>

        <SidebarSection title="Änderungen">
          <dl className="space-y-1 text-2xs">
            <div className="flex justify-between">
              <dt className="text-faint">Dateien</dt>
              <dd>{pr.changedFiles}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-faint">Hinzugefügt</dt>
              <dd className="text-success">+{pr.additions}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-faint">Entfernt</dt>
              <dd className="text-danger">−{pr.deletions}</dd>
            </div>
          </dl>
        </SidebarSection>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------

function MergeBox({
  pr,
  repo,
  onReload,
}: {
  pr: PullRequestDetail;
  repo: RepositoryDetail;
  onReload: () => void;
}) {
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const canWrite = hasAccess(repo.viewerAccess, 'write');
  const [strategy, setStrategy] = useState(pr.allowedStrategies[0] ?? 'merge');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(true);

  if (pr.merged) {
    return (
      <Panel bodyClassName="p-4">
        <p className="text-sm">
          <span className="font-semibold text-[#8957e5]">Gemergt</span>{' '}
          {pr.mergedBy && (
            <>
              von <strong>{pr.mergedBy.username}</strong>
            </>
          )}{' '}
          {relativeTime(pr.mergedAt)} mit Strategie <code className="code">{pr.mergeStrategy}</code>.
        </p>
        {pr.mergeCommitSha && (
          <Link
            to={`/${repoPath}/commit/${pr.mergeCommitSha}`}
            className="mt-1 block font-mono text-2xs text-accent hover:underline"
          >
            {pr.mergeCommitSha.slice(0, 8)}
          </Link>
        )}
      </Panel>
    );
  }

  if (pr.state === 'closed') {
    return (
      <Panel bodyClassName="p-4">
        <p className="text-sm text-muted">Dieser Pull Request wurde ohne Merge geschlossen.</p>
      </Panel>
    );
  }

  async function merge() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/repos/${repoPath}/pulls/${pr.number}/merge`, {
        strategy,
        deleteBranch,
      });
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Merge fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleDraft() {
    await api.patch(`/api/v1/repos/${repoPath}/pulls/${pr.number}`, { draft: !pr.isDraft });
    onReload();
  }

  return (
    <Panel bodyClassName="p-4 space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}

      <ul className="space-y-1.5">
        {pr.checks.items.map((check) => (
          <li key={check.key} className="flex items-start gap-2 text-xs">
            <span className={check.passed ? 'text-success' : 'text-danger'}>
              {check.passed ? '✓' : '✗'}
            </span>
            <span className={check.passed ? 'text-muted' : 'text-ink'}>
              {check.label}
              {check.detail && <span className="block text-2xs text-faint">{check.detail}</span>}
            </span>
          </li>
        ))}
      </ul>

      {pr.conflictingFiles.length > 0 && (
        <Alert tone="danger" title="Merge-Konflikte">
          <ul className="mt-1 space-y-0.5 font-mono text-2xs">
            {pr.conflictingFiles.slice(0, 10).map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            Hole dir die Basis in deinen Branch und löse die Konflikte lokal:
          </p>
          <pre className="mt-1 overflow-x-auto bg-canvas p-2 font-mono text-2xs">
            <code>{`git checkout ${pr.head.branch}
git fetch origin
git merge origin/${pr.base.branch}
# Konflikte lösen, dann
git push`}</code>
          </pre>
        </Alert>
      )}

      {canWrite && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {pr.isDraft ? (
            <Button variant="primary" onClick={toggleDraft}>
              Zur Prüfung freigeben
            </Button>
          ) : (
            <>
              <div className="w-44">
                <Select
                  value={strategy}
                  onChange={(event) => setStrategy(event.target.value as typeof strategy)}
                  className="h-8 text-xs"
                >
                  {pr.allowedStrategies.map((option) => (
                    <option key={option} value={option}>
                      {option === 'merge'
                        ? 'Merge-Commit'
                        : option === 'squash'
                          ? 'Squash und Merge'
                          : 'Rebase und Merge'}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                variant="primary"
                onClick={merge}
                loading={busy}
                disabled={!pr.checks.canMerge}
              >
                Pull Request mergen
              </Button>
              <label className="flex items-center gap-1.5 text-2xs text-muted">
                <input
                  type="checkbox"
                  checked={deleteBranch}
                  onChange={(event) => setDeleteBranch(event.target.checked)}
                  className="accent-[rgb(var(--accent))]"
                />
                Branch danach löschen
              </label>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function ReviewBox({
  pr,
  repoPath,
  onReload,
}: {
  pr: PullRequestDetail;
  repoPath: string;
  onReload: () => void;
}) {
  const { viewer } = useSession();
  const [body, setBody] = useState('');
  const [state, setState] = useState<'commented' | 'approved' | 'changes_requested'>('commented');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAuthor = viewer?.id === pr.author?.id;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/repos/${repoPath}/pulls/${pr.number}/reviews`, {
        state,
        body: body || null,
      });
      setBody('');
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Review fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Review abgeben" bodyClassName="space-y-3 p-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <Textarea
        rows={3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Zusammenfassende Anmerkung (optional)"
      />

      <div className="space-y-1.5">
        {(
          [
            ['commented', 'Nur kommentieren', 'Eine Anmerkung ohne ausdrückliche Zustimmung.'],
            ['approved', 'Zustimmen', 'Die Änderungen können aus deiner Sicht übernommen werden.'],
            [
              'changes_requested',
              'Änderungen anfordern',
              'Blockiert den Merge, bis nachgebessert wurde.',
            ],
          ] as const
        ).map(([value, label, hint]) => {
          const disabled = value === 'approved' && isAuthor;
          return (
            <label
              key={value}
              className={cx(
                'flex items-start gap-2 border p-2',
                disabled
                  ? 'cursor-not-allowed border-line opacity-50'
                  : state === value
                    ? 'cursor-pointer border-accent bg-accent/5'
                    : 'cursor-pointer border-line hover:bg-raised',
              )}
            >
              <input
                type="radio"
                name="review-state"
                checked={state === value}
                disabled={disabled}
                onChange={() => setState(value)}
                className="mt-0.5 accent-[rgb(var(--accent))]"
              />
              <span>
                <span className="block text-xs font-medium">{label}</span>
                <span className="block text-2xs text-faint">
                  {disabled ? 'Dem eigenen Pull Request kannst du nicht zustimmen.' : hint}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      <Button variant="primary" onClick={submit} loading={busy}>
        Review absenden
      </Button>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function PullFiles({
  pr,
  repo,
  onReload,
}: {
  pr: PullRequestDetail;
  repo: RepositoryDetail;
  onReload: () => void;
}) {
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const [data, setData] = useState<{
    files: DiffFile[];
    stats: DiffStats;
    comments: ReviewComment[];
  } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<typeof data>(`/api/v1/repos/${repoPath}/pulls/${pr.number}/files`, controller.signal)
      .then(setData)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [repoPath, pr.number]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Spin />;

  const commentsByPath = new Map<string, ReviewComment[]>();
  for (const comment of data.comments) {
    const list = commentsByPath.get(comment.path) ?? [];
    list.push(comment);
    commentsByPath.set(comment.path, list);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 text-xs text-muted">
        <span>{data.stats.filesChanged} geänderte Dateien</span>
        <span className="text-success">+{data.stats.additions}</span>
        <span className="text-danger">−{data.stats.deletions}</span>
      </div>

      {data.files.map((file) => (
        <div key={file.path} className="space-y-2">
          <DiffPanel file={file} />
          <FileComments
            path={file.path}
            comments={commentsByPath.get(file.path) ?? []}
            pr={pr}
            repoPath={repoPath}
            onReload={onReload}
          />
        </div>
      ))}
    </div>
  );
}

function FileComments({
  path,
  comments,
  pr,
  repoPath,
  onReload,
}: {
  path: string;
  comments: ReviewComment[];
  pr: PullRequestDetail;
  repoPath: string;
  onReload: () => void;
}) {
  const { viewer } = useSession();
  const [adding, setAdding] = useState(false);
  const [body, setBody] = useState('');
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/api/v1/repos/${repoPath}/pulls/${pr.number}/comments`, {
        body,
        path,
        line: line ? Number(line) : null,
        diffSide: 'right',
      });
      setBody('');
      setLine('');
      setAdding(false);
      onReload();
    } finally {
      setBusy(false);
    }
  }

  async function toggleResolved(commentId: string, resolved: boolean) {
    await api.post(`/api/v1/repos/${repoPath}/review-comments/${commentId}/resolve`, { resolved });
    onReload();
  }

  if (comments.length === 0 && !viewer) return null;

  return (
    <div className="ml-4 space-y-2 border-l-2 border-line pl-4">
      {comments.map((comment) => (
        <div key={comment.id} className="panel">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-2xs">
              <Avatar name={comment.author?.username ?? '?'} size={16} />
              <span className="font-semibold">{comment.author?.username}</span>
              {comment.line !== null && (
                <span className="font-mono text-faint">Zeile {comment.line}</span>
              )}
              <span className="text-faint">{relativeTime(comment.createdAt)}</span>
              {comment.isResolved && <Badge tone="success">erledigt</Badge>}
            </div>
            {viewer && (
              <button
                type="button"
                onClick={() => toggleResolved(comment.id, !comment.isResolved)}
                className="text-2xs text-muted hover:text-ink"
              >
                {comment.isResolved ? 'Wieder öffnen' : 'Als erledigt markieren'}
              </button>
            )}
          </div>
          <div className="p-3">
            <Markdown source={comment.body} />
          </div>
        </div>
      ))}

      {viewer &&
        (adding ? (
          <div className="space-y-2">
            <Input
              placeholder="Zeilennummer (optional)"
              value={line}
              onChange={(event) => setLine(event.target.value)}
              className="h-7 w-48 text-xs"
            />
            <CommentEditor
              value={body}
              onChange={setBody}
              onSubmit={submit}
              submitLabel="Anmerkung speichern"
              busy={busy}
              minRows={3}
              extraActions={
                <Button size="sm" onClick={() => setAdding(false)}>
                  Abbrechen
                </Button>
              }
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-2xs text-muted hover:text-accent"
          >
            + Anmerkung zu dieser Datei
          </button>
        ))}
    </div>
  );
}

function PullCommits({ pr, repo }: { pr: PullRequestDetail; repo: RepositoryDetail }) {
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const [commits, setCommits] = useState<CommitSummary[] | null>(null);

  useEffect(() => {
    api
      .get<{ commits: CommitSummary[] }>(`/api/v1/repos/${repoPath}/pulls/${pr.number}/files`)
      .then((d) => setCommits(d.commits))
      .catch(() => setCommits([]));
  }, [repoPath, pr.number]);

  if (!commits) return <Spin />;

  return (
    <Panel title={plural(commits.length, 'Commit', 'Commits')} bodyClassName="divide-y divide-line">
      {commits.map((commit) => (
        <div key={commit.oid} className="flex items-center gap-3 px-4 py-2.5">
          <Avatar name={commit.author.name} size={22} />
          <div className="min-w-0 flex-1">
            <Link
              to={`/${repoPath}/commit/${commit.oid}`}
              className="block truncate text-sm hover:text-accent"
            >
              {commit.subject}
            </Link>
            <p className="text-2xs text-faint">
              {commit.author.name} · {relativeTime(commit.author.date)}
            </p>
          </div>
          <code className="shrink-0 border border-line-strong px-1.5 py-0.5 font-mono text-2xs text-muted">
            {commit.shortOid}
          </code>
        </div>
      ))}
    </Panel>
  );
}
