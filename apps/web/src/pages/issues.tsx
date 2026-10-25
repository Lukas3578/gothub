/**
 * Issues: Liste, Detailansicht und Anlegen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  IssueDetail,
  IssueSummary,
  LabelRef,
  MilestoneRef,
  RepositoryDetail,
  TimelineEntry,
} from '@forge/shared';
import { hasAccess } from '@forge/shared';
import { ApiRequestError, api } from '../lib/api.js';
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
  cx,
  formatNumber,
  plural,
  relativeTime,
} from '../components/ui.js';
import { Avatar } from '../components/Shell.js';
import {
  CommentEditor,
  LabelChip,
  Reactions,
  SidebarSection,
  StateBadge,
  Timeline,
  TimelineItem,
  UserList,
} from '../components/conversation.js';
import { Markdown } from '../components/Markdown.js';

interface IssueListResponse {
  items: IssueSummary[];
  totalCount: number;
  openCount: number;
  closedCount: number;
}

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

export function IssueListPage({ repo }: { repo: RepositoryDetail }) {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<IssueListResponse | null>(null);
  const [labels, setLabels] = useState<LabelRef[]>([]);
  const [error, setError] = useState<unknown>(null);
  const { viewer } = useSession();

  const state = params.get('state') ?? 'open';
  const search = params.get('q') ?? '';
  const labelFilter = params.get('labels') ?? '';
  const sort = params.get('sort') ?? 'newest';
  const base = `/${repo.ownerName}/${repo.name}`;

  const update = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params);
      if (value) next.set(key, value);
      else next.delete(key);
      setParams(next);
    },
    [params, setParams],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ state, sort, perPage: '25' });
      if (search) query.set('search', search);
      if (labelFilter) query.set('labels', labelFilter);

      api
        .get<IssueListResponse>(
          `/api/v1/repos/${repo.ownerName}/${repo.name}/issues?${query}`,
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
  }, [repo.ownerName, repo.name, state, search, labelFilter, sort]);

  useEffect(() => {
    api
      .get<{ items: LabelRef[] }>(`/api/v1/repos/${repo.ownerName}/${repo.name}/labels`)
      .then((d) => setLabels(d.items))
      .catch(() => {});
  }, [repo.ownerName, repo.name]);

  if (error) return <ErrorBox error={error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <Input
            placeholder="Issues durchsuchen"
            value={search}
            onChange={(event) => update('q', event.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <div className="w-44">
          <Select
            value={labelFilter}
            onChange={(event) => update('labels', event.target.value)}
            className="h-8 text-xs"
          >
            <option value="">Alle Labels</option>
            {labels.map((label) => (
              <option key={label.id} value={label.name}>
                {label.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <Select
            value={sort}
            onChange={(event) => update('sort', event.target.value)}
            className="h-8 text-xs"
          >
            <option value="newest">Neueste zuerst</option>
            <option value="oldest">Älteste zuerst</option>
            <option value="updated">Zuletzt aktualisiert</option>
            <option value="comments">Meiste Kommentare</option>
          </Select>
        </div>
        <Link
          to={`${base}/issues/new`}
          className="flex h-8 items-center border border-accent bg-accent px-3 text-xs font-medium text-accent-ink hover:bg-accent/90"
        >
          Neues Issue
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
              className={cx(
                'font-medium',
                state === 'closed' ? 'text-ink' : 'text-muted hover:text-ink',
              )}
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
            title="Keine Issues gefunden"
            description={
              state === 'open'
                ? 'Alles erledigt – oder noch nichts gemeldet.'
                : 'Hier ist noch nichts geschlossen worden.'
            }
          />
        ) : (
          data.items.map((issue) => (
            <IssueRow key={issue.id} issue={issue} base={base} kind="issues" />
          ))
        )}
      </Panel>
    </div>
  );
}

export function IssueRow({
  issue,
  base,
  kind,
}: {
  issue: IssueSummary;
  base: string;
  kind: 'issues' | 'pulls';
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-raised/50">
      <span className="mt-0.5 shrink-0">
        <StateIcon
          state={issue.state}
          merged={issue.pullRequest?.merged}
          isDraft={issue.pullRequest?.isDraft}
        />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`${base}/${kind}/${issue.number}`} className="text-sm font-semibold hover:text-accent">
            {issue.title}
          </Link>
          {issue.labels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
        </div>

        <p className="mt-1 text-2xs text-faint">
          #{issue.number} · {issue.state === 'open' ? 'geöffnet' : 'geschlossen'}{' '}
          {relativeTime(issue.state === 'open' ? issue.createdAt : issue.closedAt)}
          {issue.author && (
            <>
              {' '}von{' '}
              <Link to={`/${issue.author.username}`} className="hover:text-ink">
                {issue.author.username}
              </Link>
            </>
          )}
          {issue.pullRequest && (
            <>
              {' '}· <code className="font-mono">{issue.pullRequest.headBranch}</code> →{' '}
              <code className="font-mono">{issue.pullRequest.baseBranch}</code>
            </>
          )}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {issue.assignees.slice(0, 3).map((user) => (
          <Avatar key={user.id} name={user.username} size={18} url={user.avatarUrl} />
        ))}
        {issue.commentCount > 0 && (
          <span className="text-2xs text-faint">💬 {issue.commentCount}</span>
        )}
      </div>
    </div>
  );
}

function StateIcon({
  state,
  merged,
  isDraft,
}: {
  state: string;
  merged?: boolean;
  isDraft?: boolean;
}) {
  const color = merged
    ? '#8957e5'
    : isDraft && state === 'open'
      ? 'rgb(var(--faint))'
      : state === 'open'
        ? 'rgb(var(--success))'
        : 'rgb(var(--danger))';

  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill={color} aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke={color} strokeWidth="1.8" />
      <circle cx="8" cy="8" r="2.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Neues Issue
// ---------------------------------------------------------------------------

export function NewIssuePage({ repo }: { repo: RepositoryDetail }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const base = `/${repo.ownerName}/${repo.name}`;

  async function submit() {
    if (!title.trim()) {
      setError('Der Titel darf nicht leer sein.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<IssueDetail>(
        `/api/v1/repos/${repo.ownerName}/${repo.name}/issues`,
        { title, body: body || null },
      );
      navigate(`${base}/issues/${created.number}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anlegen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h2 className="text-lg font-semibold">Neues Issue</h2>
      {error && <Alert tone="danger">{error}</Alert>}

      <Input
        label="Titel"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Kurze Beschreibung des Problems"
        autoFocus
        required
      />

      <CommentEditor
        value={body}
        onChange={setBody}
        onSubmit={submit}
        submitLabel="Issue anlegen"
        placeholder="Was ist passiert? Was hast du erwartet? Wie lässt es sich nachstellen?"
        busy={busy}
        minRows={10}
        extraActions={
          <Button size="sm" onClick={() => navigate(`${base}/issues`)}>
            Abbrechen
          </Button>
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

interface IssueResponse {
  issue: IssueDetail;
  timeline: TimelineEntry[];
  links: { linkType: string; number: number; title: string; state: string; kind: string }[];
}

export function IssueDetailPage({ repo }: { repo: RepositoryDetail }) {
  const { number = '' } = useParams();
  const { viewer } = useSession();
  const [data, setData] = useState<IssueResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const repoPath = `${repo.ownerName}/${repo.name}`;
  const base = `/${repoPath}`;

  const reload = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<IssueResponse>(`/api/v1/repos/${repoPath}/issues/${number}`, controller.signal)
      .then(setData)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [repoPath, number, version]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Spin />;

  const { issue } = data;

  async function submitComment(closeAfter?: boolean) {
    setBusy(true);
    try {
      if (comment.trim()) {
        await api.post(`/api/v1/repos/${repoPath}/issues/${number}/comments`, { body: comment });
        setComment('');
      }
      if (closeAfter !== undefined) {
        await api.patch(`/api/v1/repos/${repoPath}/issues/${number}`, {
          state: closeAfter ? 'closed' : 'open',
        });
      }
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function toggleReaction(content: string) {
    await api.post(`/api/v1/repos/${repoPath}/reactions/issue/${issue.id}`, { content });
    reload();
  }

  return (
    <div className="space-y-4">
      <IssueHeader issue={issue} repoPath={repoPath} onReload={reload} />

      <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
        <div className="space-y-3">
          <TimelineItem last={data.timeline.length === 0}>
            <article className="panel">
              <header className="panel-header">
                <div className="flex items-center gap-2 text-xs">
                  <Avatar name={issue.author?.username ?? '?'} size={20} url={issue.author?.avatarUrl} />
                  {issue.author && (
                    <Link to={`/${issue.author.username}`} className="font-semibold hover:text-accent">
                      {issue.author.username}
                    </Link>
                  )}
                  <span className="text-faint">eröffnete {relativeTime(issue.createdAt)}</span>
                </div>
              </header>
              <div className="p-4">
                {issue.body ? (
                  <Markdown source={issue.body} />
                ) : (
                  <p className="text-sm italic text-faint">Keine Beschreibung angegeben.</p>
                )}
              </div>
              <footer className="border-t border-line px-4 py-2">
                <Reactions
                  reactions={issue.reactions}
                  onToggle={toggleReaction}
                  disabled={!viewer}
                />
              </footer>
            </article>
          </TimelineItem>

          <Timeline entries={data.timeline} repoPath={repoPath} onReload={reload} />

          {viewer ? (
            issue.isLocked && !hasAccess(repo.viewerAccess, 'write') ? (
              <Alert tone="warning">Diese Unterhaltung ist gesperrt.</Alert>
            ) : (
              <CommentEditor
                value={comment}
                onChange={setComment}
                onSubmit={() => submitComment()}
                submitLabel="Kommentieren"
                busy={busy}
                extraActions={
                  issue.viewerCanClose ? (
                    <Button
                      size="sm"
                      onClick={() => submitComment(issue.state === 'open')}
                      disabled={busy}
                    >
                      {issue.state === 'open'
                        ? comment.trim()
                          ? 'Kommentieren und schließen'
                          : 'Schließen'
                        : comment.trim()
                          ? 'Kommentieren und wieder öffnen'
                          : 'Wieder öffnen'}
                    </Button>
                  ) : null
                }
              />
            )
          ) : (
            <Alert tone="info">
              <Link to="/login" className="link">
                Melde dich an
              </Link>
              , um zu kommentieren.
            </Alert>
          )}
        </div>

        <IssueSidebar
          issue={issue}
          repo={repo}
          links={data.links}
          onReload={reload}
        />
      </div>
    </div>
  );
}

function IssueHeader({
  issue,
  repoPath,
  onReload,
}: {
  issue: IssueDetail;
  repoPath: string;
  onReload: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(issue.title);

  async function save() {
    await api.patch(`/api/v1/repos/${repoPath}/issues/${issue.number}`, { title });
    setEditing(false);
    onReload();
  }

  return (
    <header className="border-b border-line pb-4">
      {editing ? (
        <div className="flex gap-2">
          <Input value={title} onChange={(event) => setTitle(event.target.value)} className="flex-1" />
          <Button variant="primary" onClick={save}>
            Speichern
          </Button>
          <Button onClick={() => setEditing(false)}>Abbrechen</Button>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-semibold">
            {issue.title} <span className="font-normal text-faint">#{issue.number}</span>
          </h1>
          {issue.viewerCanEdit && (
            <Button size="sm" onClick={() => setEditing(true)}>
              Bearbeiten
            </Button>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted">
        <StateBadge state={issue.state} kind={issue.kind} />
        <span>
          {issue.author && <strong className="text-ink">{issue.author.username}</strong>} eröffnete
          dies {relativeTime(issue.createdAt)} ·{' '}
          {plural(issue.commentCount, 'Kommentar', 'Kommentare')}
        </span>
        {issue.closeReason && issue.state === 'closed' && (
          <Badge>
            {issue.closeReason === 'completed'
              ? 'erledigt'
              : issue.closeReason === 'not_planned'
                ? 'nicht geplant'
                : issue.closeReason === 'merged'
                  ? 'gemergt'
                  : 'Duplikat'}
          </Badge>
        )}
      </div>
    </header>
  );
}

function IssueSidebar({
  issue,
  repo,
  links,
  onReload,
}: {
  issue: IssueDetail;
  repo: RepositoryDetail;
  links: { linkType: string; number: number; title: string; state: string; kind: string }[];
  onReload: () => void;
}) {
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const canTriage = hasAccess(repo.viewerAccess, 'triage');

  const [labels, setLabels] = useState<LabelRef[]>([]);
  const [milestones, setMilestones] = useState<MilestoneRef[]>([]);
  const [editingLabels, setEditingLabels] = useState(false);

  useEffect(() => {
    if (!canTriage) return;
    Promise.all([
      api.get<{ items: LabelRef[] }>(`/api/v1/repos/${repoPath}/labels`),
      api.get<{ items: MilestoneRef[] }>(`/api/v1/repos/${repoPath}/milestones?state=open`),
    ])
      .then(([l, m]) => {
        setLabels(l.items);
        setMilestones(m.items);
      })
      .catch(() => {});
  }, [repoPath, canTriage]);

  async function toggleLabel(name: string) {
    const current = issue.labels.map((label) => label.name);
    const next = current.includes(name)
      ? current.filter((label) => label !== name)
      : [...current, name];

    await api.patch(`/api/v1/repos/${repoPath}/issues/${issue.number}`, { labels: next });
    onReload();
  }

  async function assignSelf(username: string) {
    const current = issue.assignees.map((user) => user.username);
    const next = current.includes(username)
      ? current.filter((name) => name !== username)
      : [...current, username];
    await api.patch(`/api/v1/repos/${repoPath}/issues/${issue.number}`, { assignees: next });
    onReload();
  }

  const { viewer } = useSession();

  return (
    <aside className="panel px-4">
      <SidebarSection
        title="Labels"
        action={
          canTriage && (
            <button
              type="button"
              onClick={() => setEditingLabels((value) => !value)}
              className="text-2xs text-muted hover:text-ink"
            >
              {editingLabels ? 'Fertig' : 'Ändern'}
            </button>
          )
        }
      >
        {editingLabels ? (
          <div className="space-y-1">
            {labels.map((label) => {
              const active = issue.labels.some((entry) => entry.id === label.id);
              return (
                <button
                  key={label.id}
                  type="button"
                  onClick={() => toggleLabel(label.name)}
                  className={cx(
                    'flex w-full items-center gap-2 border px-2 py-1 text-left text-2xs',
                    active ? 'border-accent bg-accent/10' : 'border-line hover:bg-raised',
                  )}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0"
                    style={{ background: `#${label.color}` }}
                  />
                  {label.name}
                </button>
              );
            })}
          </div>
        ) : issue.labels.length === 0 ? (
          <p className="text-xs text-faint">Keine Labels gesetzt.</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {issue.labels.map((label) => (
              <LabelChip key={label.id} label={label} />
            ))}
          </div>
        )}
      </SidebarSection>

      <SidebarSection
        title="Zuständig"
        action={
          viewer && (
            <button
              type="button"
              onClick={() => assignSelf(viewer.username)}
              className="text-2xs text-muted hover:text-ink"
            >
              {issue.assignees.some((user) => user.id === viewer.id) ? 'Mich entfernen' : 'Mir zuweisen'}
            </button>
          )
        }
      >
        <UserList users={issue.assignees} empty="Niemand zugewiesen." />
      </SidebarSection>

      <SidebarSection title="Milestone">
        {issue.milestone ? (
          <p className="text-xs">{issue.milestone.title}</p>
        ) : (
          <p className="text-xs text-faint">Keinem Milestone zugeordnet.</p>
        )}
      </SidebarSection>

      {links.length > 0 && (
        <SidebarSection title="Verknüpfungen">
          <ul className="space-y-1">
            {links.map((link) => (
              <li key={`${link.linkType}-${link.number}`}>
                <Link
                  to={`/${repoPath}/${link.kind === 'pull_request' ? 'pulls' : 'issues'}/${link.number}`}
                  className="text-xs hover:text-accent"
                >
                  #{link.number} {link.title.slice(0, 40)}
                </Link>
              </li>
            ))}
          </ul>
        </SidebarSection>
      )}
    </aside>
  );
}
