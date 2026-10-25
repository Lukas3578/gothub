/**
 * Repository-Ansicht: Dateibrowser, Dateiinhalt, Commits, Branches, Tags,
 * Einstellungen.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import hljs from 'highlight.js/lib/common';
import { marked } from 'marked';
import type {
  BlobContent,
  BranchInfo,
  CommitDetail,
  CommitSummary,
  RepositoryDetail,
  TagInfo,
  TreeEntry,
} from '@forge/shared';
import { hasAccess } from '@forge/shared';
import { ApiRequestError, BASE_URL, api } from '../lib/api.js';
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
  formatBytes,
  formatNumber,
  languageColor,
  plural,
  relativeTime,
} from '../components/ui.js';
import { Avatar } from '../components/Shell.js';
import { IssueDetailPage, IssueListPage, NewIssuePage } from './issues.js';
import { NewPullPage, PullDetailPage, PullListPage } from './pulls.js';
import { ActionsPage, RunDetailPage } from './actions.js';
import { ReleasesPage } from './misc.js';
import { ProjectBoardPage, ProjectListPage, WikiPage } from './extras.js';
import { RepoSettingsLayout } from './repo-settings.js';
import { Markdown } from '../components/Markdown.js';

/**
 * Der Editor bringt CodeMirror mit – rund 250 KB, die nur braucht, wer
 * wirklich eine Datei bearbeitet. Deshalb erst beim Aufruf nachladen.
 */
const FileEditPage = lazy(() =>
  import('./file-edit.js').then((m) => ({ default: m.FileEditPage })),
);
const FileUploadPage = lazy(() =>
  import('./file-edit.js').then((m) => ({ default: m.FileUploadPage })),
);
const FileDeletePage = lazy(() =>
  import('./file-edit.js').then((m) => ({ default: m.FileDeletePage })),
);

interface RepoContext {
  repo: RepositoryDetail;
  reload: () => void;
}

export function RepositoryPage() {
  const { owner = '', repo: repoName = '' } = useParams();
  const [repo, setRepo] = useState<RepositoryDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    api
      .get<RepositoryDetail>(
        `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`,
        controller.signal,
      )
      .then(setRepo)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [owner, repoName, version]);

  if (error) {
    const notFound = error instanceof ApiRequestError && error.status === 404;
    return (
      <div className="mx-auto max-w-[1100px] px-4 py-16">
        {notFound ? (
          <EmptyState
            title="Repository nicht gefunden"
            description="Entweder existiert es nicht, oder du hast keinen Zugriff darauf."
            action={
              <Link to="/explore" className="link text-sm">
                Zurück zur Übersicht
              </Link>
            }
          />
        ) : (
          <ErrorBox error={error} />
        )}
      </div>
    );
  }

  if (!repo) return <Spin />;

  const context: RepoContext = { repo, reload };

  return (
    <div>
      <RepoHeader {...context} />
      <div className="page py-5">
        <Routes>
          <Route index element={<FileBrowser {...context} />} />
          <Route path="tree/*" element={<FileBrowser {...context} />} />
          <Route path="blob/*" element={<FileView {...context} />} />
          <Route
            path="new/*"
            element={
              <Suspense fallback={<Spin label="Editor wird geladen…" />}>
                <FileEditPage repo={repo} mode="create" />
              </Suspense>
            }
          />
          <Route
            path="edit/*"
            element={
              <Suspense fallback={<Spin label="Editor wird geladen…" />}>
                <FileEditPage repo={repo} mode="edit" />
              </Suspense>
            }
          />
          <Route
            path="upload/*"
            element={
              <Suspense fallback={<Spin />}>
                <FileUploadPage repo={repo} />
              </Suspense>
            }
          />
          <Route
            path="delete/*"
            element={
              <Suspense fallback={<Spin />}>
                <FileDeletePage repo={repo} />
              </Suspense>
            }
          />
          <Route path="commits" element={<CommitList {...context} />} />
          <Route path="commit/:oid" element={<CommitView {...context} />} />
          <Route path="branches" element={<BranchList {...context} />} />
          <Route path="tags" element={<TagList {...context} />} />
          <Route path="issues" element={<IssueListPage repo={repo} />} />
          <Route path="issues/new" element={<NewIssuePage repo={repo} />} />
          <Route path="issues/:number" element={<IssueDetailPage repo={repo} />} />
          <Route path="pulls" element={<PullListPage repo={repo} />} />
          <Route path="pulls/new" element={<NewPullPage repo={repo} />} />
          <Route path="pulls/:number/*" element={<PullDetailPage repo={repo} />} />
          <Route path="actions" element={<ActionsPage repo={repo} />} />
          <Route path="actions/runs/:runId" element={<RunDetailPage repo={repo} />} />
          <Route path="releases" element={<ReleasesPage repo={repo} />} />
          <Route path="wiki" element={<WikiPage repo={repo} />} />
          <Route path="projects" element={<ProjectListPage repo={repo} />} />
          <Route path="projects/:number" element={<ProjectBoardPage repo={repo} />} />
          <Route
            path="settings/*"
            element={<RepoSettingsLayout repo={repo} general={<RepoSettings {...context} />} />}
          />
          <Route path="*" element={<Navigate to="." replace />} />
        </Routes>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kopfbereich
// ---------------------------------------------------------------------------

function RepoHeader({ repo, reload }: RepoContext) {
  const { viewer } = useSession();
  const base = `/${repo.ownerName}/${repo.name}`;
  const [busy, setBusy] = useState(false);

  async function toggleStar() {
    setBusy(true);
    try {
      await api[repo.viewerHasStarred ? 'delete' : 'put'](
        `/api/v1/repos/${repo.ownerName}/${repo.name}/star`,
      );
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function toggleWatch() {
    setBusy(true);
    try {
      await api[repo.viewerIsWatching ? 'delete' : 'put'](
        `/api/v1/repos/${repo.ownerName}/${repo.name}/watch`,
      );
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-line bg-surface">
      <div className="page pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-lg">
              <Avatar name={repo.ownerName} size={20} />
              <Link to={`/${repo.ownerName}`} className="link">
                {repo.ownerName}
              </Link>
              <span className="text-faint">/</span>
              <Link to={base} className="link font-semibold">
                {repo.name}
              </Link>
              {repo.visibility !== 'public' && (
                <Badge>{repo.visibility === 'private' ? 'privat' : 'intern'}</Badge>
              )}
              {repo.isArchived && <Badge tone="warning">archiviert</Badge>}
            </h1>

            {repo.parent && (
              <p className="mt-1 text-2xs text-faint">
                Fork von{' '}
                <Link to={`/${repo.parent.fullName}`} className="link">
                  {repo.parent.fullName}
                </Link>
              </p>
            )}
            {repo.description && <p className="mt-2 max-w-2xl text-sm text-muted">{repo.description}</p>}

            {repo.topics.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {repo.topics.map((topic) => (
                  <span
                    key={topic}
                    className="border border-accent/40 bg-accent/10 px-2 py-0.5 text-2xs text-accent"
                  >
                    {topic}
                  </span>
                ))}
              </div>
            )}
          </div>

          {viewer && (
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" onClick={toggleWatch} disabled={busy}>
                {repo.viewerIsWatching ? 'Nicht mehr beobachten' : 'Beobachten'}
                <span className="ml-1 border-l border-line-strong pl-1.5 text-faint">
                  {formatNumber(repo.watcherCount)}
                </span>
              </Button>
              <Button
                size="sm"
                onClick={toggleStar}
                disabled={busy}
                variant={repo.viewerHasStarred ? 'primary' : 'default'}
              >
                ★ {repo.viewerHasStarred ? 'Markiert' : 'Merken'}
                <span className="ml-1 border-l border-current/30 pl-1.5 opacity-70">
                  {formatNumber(repo.starCount)}
                </span>
              </Button>
              <ForkButton repo={repo} />
            </div>
          )}
        </div>

        <nav className="-mb-px mt-4 flex gap-1 overflow-x-auto">
          <RepoTab to={base} end>
            Code
          </RepoTab>
          {repo.hasIssues && (
            <RepoTab to={`${base}/issues`}>
              Issues
              {repo.openIssueCount > 0 && (
                <span className="ml-1.5 border border-line-strong px-1 text-[0.65rem]">
                  {repo.openIssueCount}
                </span>
              )}
            </RepoTab>
          )}
          {repo.hasPullRequests && <RepoTab to={`${base}/pulls`}>Pull Requests</RepoTab>}
          {repo.hasActions && <RepoTab to={`${base}/actions`}>Actions</RepoTab>}
          {repo.hasReleases && <RepoTab to={`${base}/releases`}>Releases</RepoTab>}
          {repo.hasWiki && <RepoTab to={`${base}/wiki`}>Wiki</RepoTab>}
          <RepoTab to={`${base}/projects`}>Projekte</RepoTab>
          <RepoTab to={`${base}/commits`}>Commits</RepoTab>
          <RepoTab to={`${base}/branches`}>Branches</RepoTab>
          {hasAccess(repo.viewerAccess, 'admin') && (
            <RepoTab to={`${base}/settings`}>Einstellungen</RepoTab>
          )}
        </nav>
      </div>
    </div>
  );
}

function RepoTab({ to, end, children }: { to: string; end?: boolean; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'border-b-2 px-3 py-2 text-xs font-medium transition-colors',
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

function ForkButton({ repo }: { repo: RepositoryDetail }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fork() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ fullName: string }>(
        `/api/v1/repos/${repo.ownerName}/${repo.name}/fork`,
        {},
      );
      navigate(`/${created.fullName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fork fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <Button size="sm" onClick={fork} loading={busy} disabled={repo.isEmpty}>
        ⑂ Fork
        <span className="ml-1 border-l border-line-strong pl-1.5 text-faint">
          {formatNumber(repo.forkCount)}
        </span>
      </Button>
      {error && (
        <div className="absolute right-0 top-9 z-20 w-64">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ref-Auswahl und Klon-Box
// ---------------------------------------------------------------------------

function useRef_(repo: RepositoryDetail): [string, (ref: string) => void] {
  const [params, setParams] = useSearchParams();
  const ref = params.get('ref') ?? repo.defaultBranch;

  const setRef = useCallback(
    (next: string) => {
      const updated = new URLSearchParams(params);
      if (next === repo.defaultBranch) updated.delete('ref');
      else updated.set('ref', next);
      setParams(updated);
    },
    [params, setParams, repo.defaultBranch],
  );

  return [ref, setRef];
}

export function RefPicker({ repo, value, onChange }: { repo: RepositoryDetail; value: string; onChange: (v: string) => void }) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);

  useEffect(() => {
    if (repo.isEmpty) return;
    const controller = new AbortController();
    Promise.all([
      api.get<{ items: BranchInfo[] }>(
        `/api/v1/repos/${repo.ownerName}/${repo.name}/branches`,
        controller.signal,
      ),
      api.get<{ items: TagInfo[] }>(
        `/api/v1/repos/${repo.ownerName}/${repo.name}/tags`,
        controller.signal,
      ),
    ])
      .then(([b, t]) => {
        setBranches(b.items);
        setTags(t.items);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [repo.ownerName, repo.name, repo.isEmpty]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 border border-line-strong bg-raised px-2 text-xs font-medium focus:border-accent focus:outline-none"
      aria-label="Branch oder Tag wählen"
    >
      <optgroup label="Branches">
        {branches.map((branch) => (
          <option key={branch.name} value={branch.name}>
            {branch.name}
          </option>
        ))}
      </optgroup>
      {tags.length > 0 && (
        <optgroup label="Tags">
          {tags.map((tag) => (
            <option key={tag.name} value={tag.name}>
              {tag.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

/**
 * Einstieg zum Anlegen und Hochladen von Dateien.
 *
 * Als Menü statt zweier Schaltflächen, weil die Leiste darüber auf dem
 * Telefon sonst umbricht und der Dateibrowser nach unten rutscht.
 */
function AddFileMenu({
  base,
  path,
  refQuery,
}: {
  base: string;
  path: string;
  refQuery: string;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);

  // Klick daneben und Escape schließen das Menü – ohne beides bliebe es
  // offen stehen, sobald man woandershin klickt.
  useEffect(() => {
    if (!open) return;

    const onPointer = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const suffix = path ? `/${path}` : '';

  return (
    <div ref={container} className="relative">
      <Button size="sm" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        Datei hinzufügen
        <span aria-hidden="true" className="text-faint">
          ▾
        </span>
      </Button>

      {open && (
        <div
          role="menu"
          className="overlay absolute right-0 z-20 mt-1 w-56"
        >
          <Link
            role="menuitem"
            to={`${base}/new${suffix}${refQuery}`}
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-xs hover:bg-raised"
          >
            Neue Datei anlegen
          </Link>
          <Link
            role="menuitem"
            to={`${base}/upload${suffix}${refQuery}`}
            onClick={() => setOpen(false)}
            className="block border-t border-line px-3 py-2 text-xs hover:bg-raised"
          >
            Dateien hochladen
          </Link>
        </div>
      )}
    </div>
  );
}

function CloneBox({ repo }: { repo: RepositoryDetail }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(repo.cloneUrlHttp);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Zwischenablage nicht verfügbar – die URL steht ohnehin im Feld.
    }
  }

  return (
    <div className="flex items-stretch">
      <input
        readOnly
        value={repo.cloneUrlHttp}
        onFocus={(e) => e.currentTarget.select()}
        className="h-7 w-[300px] max-w-full border border-line-strong bg-canvas px-2 font-mono text-2xs text-muted focus:outline-none"
        aria-label="Clone-URL"
      />
      <button
        type="button"
        onClick={copy}
        className="h-7 border border-l-0 border-line-strong bg-raised px-2.5 text-2xs font-medium hover:bg-line/60"
      >
        {copied ? 'Kopiert' : 'Kopieren'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dateibrowser
// ---------------------------------------------------------------------------

function FileBrowser({ repo, reload }: RepoContext) {
  const params = useParams();
  const path = params['*'] ?? '';
  const [ref, setRef] = useRef_(repo);

  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [readme, setReadme] = useState<BlobContent | null>(null);

  useEffect(() => {
    if (repo.isEmpty) {
      setEntries([]);
      return;
    }

    const controller = new AbortController();
    setEntries(null);
    setError(null);
    setReadme(null);

    const url = path
      ? `/api/v1/repos/${repo.ownerName}/${repo.name}/tree/${path}?ref=${encodeURIComponent(ref)}`
      : `/api/v1/repos/${repo.ownerName}/${repo.name}/tree?ref=${encodeURIComponent(ref)}`;

    api
      .get<{ entries: TreeEntry[] }>(url, controller.signal)
      .then((data) => {
        setEntries(data.entries);

        // README im aktuellen Verzeichnis automatisch darstellen.
        const readmeEntry = data.entries.find(
          (entry) => entry.type === 'blob' && /^readme(\.md|\.markdown|\.txt)?$/i.test(entry.name),
        );
        if (readmeEntry) {
          api
            .get<BlobContent>(
              `/api/v1/repos/${repo.ownerName}/${repo.name}/blob/${readmeEntry.path}?ref=${encodeURIComponent(ref)}`,
              controller.signal,
            )
            .then(setReadme)
            .catch(() => {});
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });

    return () => controller.abort();
  }, [repo.ownerName, repo.name, repo.isEmpty, ref, path]);

  if (repo.isEmpty) return <EmptyRepository repo={repo} />;

  const base = `/${repo.ownerName}/${repo.name}`;
  const refQuery = ref === repo.defaultBranch ? '' : `?ref=${encodeURIComponent(ref)}`;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <RefPicker repo={repo} value={ref} onChange={setRef} />
          <Breadcrumbs base={base} path={path} refQuery={refQuery} repoName={repo.name} />
          <div className="ml-auto flex items-center gap-2">
            {hasAccess(repo.viewerAccess, 'write') && (
              <AddFileMenu base={base} path={path} refQuery={refQuery} />
            )}
            <CloneBox repo={repo} />
          </div>
        </div>

        {error ? (
          <ErrorBox error={error} />
        ) : !entries ? (
          <Spin />
        ) : (
          <Panel bodyClassName="">
            <table className="w-full text-sm">
              <tbody>
                {path && (
                  <tr className="table-row">
                    <td colSpan={3} className="px-4 py-2">
                      <Link
                        to={`${base}/tree/${path.split('/').slice(0, -1).join('/')}${refQuery}`}
                        className="text-muted hover:text-ink"
                      >
                        ..
                      </Link>
                    </td>
                  </tr>
                )}
                {entries.map((entry) => (
                  <tr key={entry.path} className="table-row">
                    <td className="w-full px-4 py-2">
                      <Link
                        to={`${base}/${entry.type === 'tree' ? 'tree' : 'blob'}/${entry.path}${refQuery}`}
                        className="flex items-center gap-2 hover:text-accent"
                      >
                        <EntryIcon type={entry.type} />
                        <span className="truncate">{entry.name}</span>
                      </Link>
                    </td>
                    <td className="hidden max-w-[320px] truncate px-4 py-2 text-xs text-muted sm:table-cell">
                      {entry.lastCommit?.subject}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right text-2xs text-faint">
                      {entry.lastCommit ? relativeTime(entry.lastCommit.committer.date) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}

        {readme && readme.content && !readme.isBinary && (
          <Panel title={readme.path.split('/').pop()} bodyClassName="p-6">
            <Markdown source={readme.content} />
          </Panel>
        )}
      </div>

      <aside className="space-y-4">
        <Panel title="Über" bodyClassName="space-y-3 p-4 text-sm">
          <p className="text-muted">{repo.description ?? 'Keine Beschreibung angegeben.'}</p>
          <dl className="space-y-1.5 border-t border-line pt-3 text-2xs">
            <SideFact label="Sterne" value={formatNumber(repo.starCount)} />
            <SideFact label="Forks" value={formatNumber(repo.forkCount)} />
            <SideFact label="Beobachter" value={formatNumber(repo.watcherCount)} />
            <SideFact label="Größe" value={formatBytes(repo.sizeBytes)} />
            <SideFact label="Letzter Push" value={relativeTime(repo.pushedAt)} />
          </dl>
        </Panel>

        <LanguageBar repo={repo} />
      </aside>
    </div>
  );
}

function SideFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-faint">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function LanguageBar({ repo }: { repo: RepositoryDetail }) {
  const [languages, setLanguages] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    // Die Sprachverteilung liegt im Repository-Datensatz; sie wird hier nur
    // ausgelesen, nicht separat geladen.
    setLanguages((repo as unknown as { languages?: Record<string, number> }).languages ?? null);
  }, [repo]);

  if (!repo.primaryLanguage) return null;

  const entries = Object.entries(languages ?? { [repo.primaryLanguage]: 1 }).sort(
    (a, b) => b[1] - a[1],
  );
  const total = entries.reduce((sum, [, value]) => sum + value, 0) || 1;

  return (
    <Panel title="Sprachen" bodyClassName="p-4">
      {/*
        Die Sprachfarben stammen aus der verbreiteten Konvention (JavaScript
        gelb, Go türkis). Manche davon sind auf weißem Grund fast unsichtbar,
        deshalb bekommt der Balken eine Linie – die Farbe bleibt erkennbar,
        die Form auch.
      */}
      <div className="flex h-2 w-full overflow-hidden border border-line">
        {entries.map(([language, bytes]) => (
          <span
            key={language}
            style={{ width: `${(bytes / total) * 100}%`, background: languageColor(language) }}
            title={language}
          />
        ))}
      </div>
      <ul className="mt-3 space-y-1 text-2xs">
        {entries.slice(0, 6).map(([language, bytes]) => (
          <li key={language} className="flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 border border-line"
                style={{ background: languageColor(language) }}
              />
              {language}
            </span>
            <span className="text-faint">{((bytes / total) * 100).toFixed(1)} %</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function EntryIcon({ type }: { type: TreeEntry['type'] }) {
  if (type === 'tree') {
    return (
      <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-accent" fill="currentColor">
        <path d="M1.5 3h4.2l1.3 1.6h7.5v8.9H1.5z" />
      </svg>
    );
  }
  if (type === 'commit') {
    return (
      <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-info" fill="currentColor">
        <circle cx="8" cy="8" r="3.2" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-faint" fill="currentColor">
      <path d="M3 1.5h6l4 4v9H3z" opacity="0.85" />
    </svg>
  );
}

function Breadcrumbs({
  base,
  path,
  refQuery,
  repoName,
}: {
  base: string;
  path: string;
  refQuery: string;
  repoName: string;
}) {
  const segments = path ? path.split('/') : [];

  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
      <Link to={`${base}${refQuery}`} className="link font-semibold">
        {repoName}
      </Link>
      {segments.map((segment, index) => {
        const sub = segments.slice(0, index + 1).join('/');
        const isLast = index === segments.length - 1;
        return (
          <span key={sub} className="flex items-center gap-1">
            <span className="text-faint">/</span>
            {isLast ? (
              <span className="font-medium">{segment}</span>
            ) : (
              <Link to={`${base}/tree/${sub}${refQuery}`} className="link">
                {segment}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function EmptyRepository({ repo }: { repo: RepositoryDetail }) {
  return (
    <div className="mx-auto max-w-2xl">
      <Panel title="Dieses Repository ist noch leer" bodyClassName="space-y-5 p-6">
        <p className="text-sm text-muted">
          Pushe ein bestehendes Projekt oder lege lokal eines an. Für die Anmeldung brauchst du
          ein{' '}
          <Link to="/settings/tokens" className="link">
            Zugriffstoken
          </Link>{' '}
          als Passwort.
        </p>

        <div>
          <p className="mb-2 text-xs font-medium text-muted">Neues Projekt anlegen</p>
          <pre className="overflow-x-auto border border-line bg-raised p-3 font-mono text-2xs leading-relaxed">
            <code>{`git init
git add .
git commit -m "Erster Commit"
git branch -M ${repo.defaultBranch}
git remote add origin ${repo.cloneUrlHttp}
git push -u origin ${repo.defaultBranch}`}</code>
          </pre>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-muted">Bestehendes Projekt pushen</p>
          <pre className="overflow-x-auto border border-line bg-raised p-3 font-mono text-2xs leading-relaxed">
            <code>{`git remote add origin ${repo.cloneUrlHttp}
git push -u origin ${repo.defaultBranch}`}</code>
          </pre>
        </div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dateiansicht
// ---------------------------------------------------------------------------

function FileView({ repo }: RepoContext) {
  const params = useParams();
  const path = params['*'] ?? '';
  const [ref] = useRef_(repo);

  const [blob, setBlob] = useState<BlobContent | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    setBlob(null);
    setError(null);
    api
      .get<BlobContent>(
        `/api/v1/repos/${repo.ownerName}/${repo.name}/blob/${path}?ref=${encodeURIComponent(ref)}`,
        controller.signal,
      )
      .then(setBlob)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [repo.ownerName, repo.name, path, ref]);

  const base = `/${repo.ownerName}/${repo.name}`;
  const refQuery = ref === repo.defaultBranch ? '' : `?ref=${encodeURIComponent(ref)}`;

  const highlighted = useMemo(() => {
    if (!blob?.content || blob.isBinary) return null;
    try {
      return hljs.highlightAuto(blob.content).value;
    } catch {
      return null;
    }
  }, [blob]);

  if (error) return <ErrorBox error={error} />;
  if (!blob) return <Spin />;

  const isMarkdown = /\.(md|markdown)$/i.test(path);
  const lines = blob.content && !blob.isBinary ? blob.content.split('\n') : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Breadcrumbs base={base} path={path} refQuery={refQuery} repoName={repo.name} />
      </div>

      <Panel
        title={
          <span className="flex items-center gap-3 text-2xs font-normal text-muted">
            <span>{formatNumber(lines.length || 0)} Zeilen</span>
            <span>{formatBytes(blob.size)}</span>
            {blob.language && <span>{blob.language}</span>}
          </span>
        }
        actions={
          <div className="flex items-center gap-3">
            {hasAccess(repo.viewerAccess, 'write') && !blob.tooLarge && (
              <>
                {!blob.isBinary && (
                  <Link
                    to={`${base}/edit/${path}${refQuery}`}
                    className="text-2xs text-muted hover:text-ink"
                  >
                    Bearbeiten
                  </Link>
                )}
                <Link
                  to={`${base}/delete/${path}${refQuery}`}
                  className="text-2xs text-muted hover:text-danger"
                >
                  Löschen
                </Link>
              </>
            )}
            <a
              href={`${BASE_URL}/api/v1/repos/${repo.ownerName}/${repo.name}/raw/${path}?ref=${encodeURIComponent(ref)}`}
              className="text-2xs text-muted hover:text-ink"
            >
              Rohdatei
            </a>
          </div>
        }
        bodyClassName="overflow-x-auto"
      >
        {blob.tooLarge ? (
          <div className="p-8 text-center text-sm text-muted">
            Diese Datei ist zu groß für die Anzeige ({formatBytes(blob.size)}). Lade sie als
            Rohdatei herunter.
          </div>
        ) : blob.isBinary ? (
          <div className="p-8 text-center text-sm text-muted">
            Binärdatei ({formatBytes(blob.size)}) – keine Textansicht möglich.
          </div>
        ) : isMarkdown ? (
          <div className="p-6">
            <Markdown source={blob.content ?? ''} />
          </div>
        ) : (
          <table className="w-full border-collapse font-mono text-[0.8125rem] leading-[1.5rem]">
            <tbody>
              {lines.map((line, index) => (
                <tr key={index} className="hover:bg-raised/60">
                  <td
                    className="w-[1%] select-none whitespace-nowrap border-r border-line px-3 text-right align-top text-faint"
                    id={`L${index + 1}`}
                  >
                    {index + 1}
                  </td>
                  <td className="whitespace-pre px-4 align-top">
                    {highlighted ? (
                      <span
                        className="hljs"
                        dangerouslySetInnerHTML={{
                          __html: highlighted.split('\n')[index] ?? '',
                        }}
                      />
                    ) : (
                      line
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

function CommitList({ repo }: RepoContext) {
  const [ref, setRef] = useRef_(repo);
  const [commits, setCommits] = useState<CommitSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (repo.isEmpty) {
      setCommits([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setCommits(null);
      const params = new URLSearchParams({ ref, page: String(page), perPage: '30' });
      if (search) params.set('search', search);

      api
        .get<{ items: CommitSummary[]; totalCount: number }>(
          `/api/v1/repos/${repo.ownerName}/${repo.name}/commits?${params}`,
          controller.signal,
        )
        .then((data) => {
          setCommits(data.items);
          setTotal(data.totalCount);
        })
        .catch((err) => {
          if (err.name !== 'AbortError') setError(err);
        });
    }, 200);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [repo.ownerName, repo.name, repo.isEmpty, ref, page, search]);

  if (repo.isEmpty) return <EmptyState title="Noch keine Commits" />;

  const base = `/${repo.ownerName}/${repo.name}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <RefPicker repo={repo} value={ref} onChange={setRef} />
        <div className="w-64">
          <Input
            placeholder="Commit-Nachrichten durchsuchen"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="h-7 text-xs"
          />
        </div>
        <span className="ml-auto text-2xs text-faint">{plural(total, 'Commit', 'Commits')}</span>
      </div>

      {error ? (
        <ErrorBox error={error} />
      ) : !commits ? (
        <Spin />
      ) : (
        <>
          <Panel bodyClassName="divide-y divide-line">
            {commits.length === 0 ? (
              <EmptyState title="Keine Commits gefunden" />
            ) : (
              commits.map((commit) => (
                <div key={commit.oid} className="flex items-start gap-3 px-4 py-3">
                  <Avatar name={commit.author.name} size={28} />
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`${base}/commit/${commit.oid}`}
                      className="block truncate text-sm font-medium hover:text-accent"
                    >
                      {commit.subject}
                    </Link>
                    <p className="mt-0.5 text-2xs text-faint">
                      {commit.author.user ? (
                        <Link to={`/${commit.author.user.username}`} className="link">
                          {commit.author.user.username}
                        </Link>
                      ) : (
                        <span className="text-muted">{commit.author.name}</span>
                      )}{' '}
                      committete {relativeTime(commit.author.date)}
                    </p>
                  </div>
                  <Link
                    to={`${base}/commit/${commit.oid}`}
                    className="shrink-0 border border-line-strong px-2 py-1 font-mono text-2xs text-muted hover:bg-raised"
                  >
                    {commit.shortOid}
                  </Link>
                </div>
              ))
            )}
          </Panel>

          <div className="flex items-center justify-between">
            <Button size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Zurück
            </Button>
            <span className="text-2xs text-faint">Seite {page}</span>
            <Button
              size="sm"
              disabled={page * 30 >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              Weiter
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function CommitView({ repo }: RepoContext) {
  const { oid = '' } = useParams();
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<CommitDetail>(
        `/api/v1/repos/${repo.ownerName}/${repo.name}/commits/${oid}`,
        controller.signal,
      )
      .then(setCommit)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [repo.ownerName, repo.name, oid]);

  if (error) return <ErrorBox error={error} />;
  if (!commit) return <Spin />;

  return (
    <div className="space-y-4">
      <Panel bodyClassName="p-4">
        <h2 className="text-base font-semibold">{commit.subject}</h2>
        {commit.body && (
          <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-muted">{commit.body}</pre>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3 text-2xs text-muted">
          <span className="flex items-center gap-1.5">
            <Avatar name={commit.author.name} size={18} />
            {commit.author.user ? (
              <Link to={`/${commit.author.user.username}`} className="link">
                {commit.author.user.username}
              </Link>
            ) : (
              commit.author.name
            )}
          </span>
          <span>{new Date(commit.author.date).toLocaleString('de-DE')}</span>
          <code className="code border border-line-strong px-1.5 py-0.5">{commit.shortOid}</code>
          {commit.parents.length > 1 && <Badge tone="info">Merge</Badge>}
          <span className="ml-auto flex gap-3">
            <span className="text-success">+{formatNumber(commit.stats.additions)}</span>
            <span className="text-danger">−{formatNumber(commit.stats.deletions)}</span>
            <span>{plural(commit.stats.filesChanged, 'Datei', 'Dateien')}</span>
          </span>
        </div>
      </Panel>

      {commit.files.map((file) => (
        <DiffPanel key={file.path} file={file} />
      ))}
    </div>
  );
}

export function DiffPanel({ file }: { file: CommitDetail['files'][number] }) {
  const [collapsed, setCollapsed] = useState(false);

  const statusTone = {
    added: 'success',
    deleted: 'danger',
    modified: 'info',
    renamed: 'warning',
    copied: 'neutral',
    typechange: 'neutral',
  } as const;

  const statusLabel = {
    added: 'neu',
    deleted: 'gelöscht',
    modified: 'geändert',
    renamed: 'umbenannt',
    copied: 'kopiert',
    typechange: 'Typ geändert',
  } as const;

  return (
    <Panel
      title={
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 font-mono text-xs hover:text-accent"
        >
          <span className="text-faint">{collapsed ? '▸' : '▾'}</span>
          {file.previousPath && <span className="text-faint line-through">{file.previousPath} →</span>}
          {file.path}
        </button>
      }
      actions={
        <span className="flex items-center gap-2 text-2xs">
          <Badge tone={statusTone[file.status]}>{statusLabel[file.status]}</Badge>
          <span className="text-success">+{file.additions}</span>
          <span className="text-danger">−{file.deletions}</span>
        </span>
      }
      bodyClassName="overflow-x-auto"
    >
      {collapsed ? null : file.isBinary ? (
        <p className="p-6 text-center text-sm text-muted">Binärdatei – kein Textvergleich.</p>
      ) : file.truncated ? (
        <p className="p-6 text-center text-sm text-muted">
          Der Vergleich ist zu groß für die Anzeige.
        </p>
      ) : (
        <table className="w-full border-collapse font-mono text-[0.8125rem] leading-5">
          <tbody>
            {file.hunks?.map((hunk, hunkIndex) => (
              <>
                <tr key={`h${hunkIndex}`} className="bg-raised text-faint">
                  <td colSpan={3} className="px-4 py-1 text-2xs">
                    @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@{' '}
                    {hunk.header}
                  </td>
                </tr>
                {hunk.lines.map((line, lineIndex) => (
                  <tr
                    key={`h${hunkIndex}l${lineIndex}`}
                    className={cx(
                      line.type === 'addition' && 'diff-line-add',
                      line.type === 'deletion' && 'diff-line-del',
                    )}
                  >
                    <td
                      className={cx(
                        'w-[1%] select-none whitespace-nowrap px-2 text-right align-top text-2xs text-faint',
                        line.type === 'deletion' && 'diff-gutter-del',
                      )}
                    >
                      {line.oldLineNumber ?? ''}
                    </td>
                    <td
                      className={cx(
                        'w-[1%] select-none whitespace-nowrap border-r border-line px-2 text-right align-top text-2xs text-faint',
                        line.type === 'addition' && 'diff-gutter-add',
                      )}
                    >
                      {line.newLineNumber ?? ''}
                    </td>
                    <td className="whitespace-pre px-3 align-top">
                      <span className="select-none text-faint">
                        {line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' '}
                      </span>
                      {line.content}
                    </td>
                  </tr>
                ))}
              </>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Branches und Tags
// ---------------------------------------------------------------------------

function BranchList({ repo, reload }: RepoContext) {
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const canWrite = hasAccess(repo.viewerAccess, 'write');

  useEffect(() => {
    if (repo.isEmpty) {
      setBranches([]);
      return;
    }
    const controller = new AbortController();
    api
      .get<{ items: BranchInfo[] }>(
        `/api/v1/repos/${repo.ownerName}/${repo.name}/branches`,
        controller.signal,
      )
      .then((data) => setBranches(data.items))
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, [repo.ownerName, repo.name, repo.isEmpty, version]);

  async function remove(name: string) {
    if (!confirm(`Branch "${name}" wirklich löschen? Das lässt sich nicht rückgängig machen.`)) {
      return;
    }
    try {
      await api.delete(`/api/v1/repos/${repo.ownerName}/${repo.name}/branches/${name}`);
      setVersion((v) => v + 1);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Löschen fehlgeschlagen.');
    }
  }

  if (error) return <ErrorBox error={error} />;
  if (!branches) return <Spin />;

  return (
    <Panel title={`${branches.length} Branches`} bodyClassName="divide-y divide-line">
      {branches.length === 0 ? (
        <EmptyState title="Keine Branches" />
      ) : (
        branches.map((branch) => (
          <div key={branch.name} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Link
              to={`/${repo.ownerName}/${repo.name}?ref=${encodeURIComponent(branch.name)}`}
              className="font-mono text-sm font-medium hover:text-accent"
            >
              {branch.name}
            </Link>
            {branch.isDefault && <Badge tone="accent">Standard</Badge>}
            {branch.isProtected && <Badge tone="info">geschützt</Badge>}

            {branch.aheadBehind && !branch.isDefault && (
              <span className="flex items-center gap-1 text-2xs text-faint">
                <span className="text-success">↑{branch.aheadBehind.ahead}</span>
                <span className="text-danger">↓{branch.aheadBehind.behind}</span>
              </span>
            )}

            <span className="ml-auto truncate text-2xs text-faint">
              {branch.lastCommit.subject} · {relativeTime(branch.lastCommit.committer.date)}
            </span>

            {canWrite && !branch.isDefault && !branch.isProtected && (
              <Button size="sm" variant="danger" onClick={() => remove(branch.name)}>
                Löschen
              </Button>
            )}
          </div>
        ))
      )}
    </Panel>
  );
}

function TagList({ repo }: RepoContext) {
  const [tags, setTags] = useState<TagInfo[] | null>(null);

  useEffect(() => {
    if (repo.isEmpty) {
      setTags([]);
      return;
    }
    const controller = new AbortController();
    api
      .get<{ items: TagInfo[] }>(
        `/api/v1/repos/${repo.ownerName}/${repo.name}/tags`,
        controller.signal,
      )
      .then((data) => setTags(data.items))
      .catch(() => setTags([]));
    return () => controller.abort();
  }, [repo.ownerName, repo.name, repo.isEmpty]);

  if (!tags) return <Spin />;

  return (
    <Panel title={`${tags.length} Tags`} bodyClassName="divide-y divide-line">
      {tags.length === 0 ? (
        <EmptyState
          title="Keine Tags"
          description="Tags entstehen über git tag und einen anschließenden Push."
        />
      ) : (
        tags.map((tag) => (
          <div key={tag.name} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Link
              to={`/${repo.ownerName}/${repo.name}?ref=${encodeURIComponent(tag.name)}`}
              className="font-mono text-sm font-medium hover:text-accent"
            >
              {tag.name}
            </Link>
            {tag.isAnnotated && <Badge tone="info">annotiert</Badge>}
            {tag.message && <span className="truncate text-xs text-muted">{tag.message}</span>}
            <code className="ml-auto border border-line-strong px-1.5 py-0.5 font-mono text-2xs text-faint">
              {tag.targetOid.slice(0, 7)}
            </code>
          </div>
        ))
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

function RepoSettings({ repo, reload }: RepoContext) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: repo.name,
    description: repo.description ?? '',
    visibility: repo.visibility,
    topics: repo.topics.join(', '),
    defaultBranch: repo.defaultBranch,
  });
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  useEffect(() => {
    if (repo.isEmpty) return;
    api
      .get<{ items: BranchInfo[] }>(`/api/v1/repos/${repo.ownerName}/${repo.name}/branches`)
      .then((d) => setBranches(d.items))
      .catch(() => {});
  }, [repo.ownerName, repo.name, repo.isEmpty]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const updated = await api.patch<RepositoryDetail>(
        `/api/v1/repos/${repo.ownerName}/${repo.name}`,
        {
          name: form.name,
          description: form.description || null,
          visibility: form.visibility,
          defaultBranch: form.defaultBranch,
          topics: form.topics
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        },
      );
      setMessage('Gespeichert.');
      if (updated.name !== repo.name) {
        navigate(`/${updated.ownerName}/${updated.name}/settings`, { replace: true });
      }
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    setBusy(true);
    try {
      await api.patch(`/api/v1/repos/${repo.ownerName}/${repo.name}`, {
        isArchived: !repo.isArchived,
      });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    setBusy(true);
    try {
      await api.delete(`/api/v1/repos/${repo.ownerName}/${repo.name}`);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen.');
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      {message && <Alert tone="success">{message}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      <form onSubmit={save}>
        <Panel title="Allgemein" bodyClassName="space-y-4 p-5">
          <Input
            label="Repository-Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <Textarea
            label="Beschreibung"
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <Input
            label="Themen"
            hint="Kommagetrennt, z. B. minecraft, papermc, plugin"
            value={form.topics}
            onChange={(e) => setForm({ ...form, topics: e.target.value })}
          />
          <Select
            label="Sichtbarkeit"
            value={form.visibility}
            onChange={(e) => setForm({ ...form, visibility: e.target.value as typeof form.visibility })}
          >
            <option value="private">Privat</option>
            <option value="internal">Intern</option>
            <option value="public">Öffentlich</option>
          </Select>
          {!repo.isEmpty && (
            <Select
              label="Default-Branch"
              value={form.defaultBranch}
              onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })}
              hint="Dieser Branch wird beim Klonen ausgecheckt."
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
          <Button type="submit" variant="primary" loading={busy}>
            Speichern
          </Button>
        </Panel>
      </form>

      <Panel title="Gefahrenzone" className="border-danger/40" bodyClassName="divide-y divide-line">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-sm font-medium">
              {repo.isArchived ? 'Archivierung aufheben' : 'Repository archivieren'}
            </p>
            <p className="text-xs text-muted">
              Ein archiviertes Repository ist schreibgeschützt, bleibt aber lesbar.
            </p>
          </div>
          <Button variant="danger" onClick={toggleArchive} disabled={busy}>
            {repo.isArchived ? 'Entarchivieren' : 'Archivieren'}
          </Button>
        </div>

        <div className="space-y-3 p-4">
          <div>
            <p className="text-sm font-medium">Repository löschen</p>
            <p className="text-xs text-muted">
              Gib zur Bestätigung <code className="code text-ink">{repo.name}</code> ein. Der
              Zugriff wird sofort entzogen.
            </p>
          </div>
          <Input
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            placeholder={repo.name}
          />
          <Button variant="danger" disabled={confirmName !== repo.name || busy} onClick={destroy}>
            Endgültig löschen
          </Button>
        </div>
      </Panel>
    </div>
  );
}
