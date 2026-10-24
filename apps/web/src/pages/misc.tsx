/**
 * Releases, Organisationen, Suche, Benachrichtigungen und Administration.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  NotificationItem,
  OrganizationMember,
  OrganizationSummary,
  ReleaseSummary,
  RepositoryDetail,
  RepositorySummary,
  TeamSummary,
} from '@forge/shared';
import { hasAccess } from '@forge/shared';
import { BASE_URL, api, apiUpload } from '../lib/api.js';
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
  relativeTime,
} from '../components/ui.js';
import { Avatar } from '../components/Shell.js';
import { Markdown } from './repository.js';
import { RepoRow } from './dashboard.js';

// ===========================================================================
// Releases
// ===========================================================================

export function ReleasesPage({ repo }: { repo: RepositoryDetail }) {
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const [items, setItems] = useState<ReleaseSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const canWrite = hasAccess(repo.viewerAccess, 'write');

  useEffect(() => {
    api
      .get<{ items: ReleaseSummary[] }>(`/api/v1/repos/${repoPath}/releases`)
      .then((d) => setItems(d.items))
      .catch(() => setItems([]));
  }, [repoPath, version]);

  if (!items) return <Spin />;

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Releases</h2>
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => setCreating((value) => !value)}>
            {creating ? 'Abbrechen' : 'Release entwerfen'}
          </Button>
        )}
      </div>

      {creating && (
        <NewRelease
          repo={repo}
          onDone={() => {
            setCreating(false);
            setVersion((value) => value + 1);
          }}
          onError={setError}
        />
      )}

      {items.length === 0 ? (
        <EmptyState
          title="Noch keine Releases"
          description="Ein Release bündelt einen Tag mit Beschreibung und Dateien zum Herunterladen."
        />
      ) : (
        <div className="space-y-4">
          {items.map((release) => (
            <Panel
              key={release.id}
              title={
                <span className="flex items-center gap-2">
                  {release.name ?? release.tagName}
                  {release.isDraft && <Badge>Entwurf</Badge>}
                  {release.isPrerelease && <Badge tone="warning">Vorabversion</Badge>}
                </span>
              }
              actions={
                <span className="text-2xs text-faint">
                  <code className="font-mono">{release.tagName}</code>
                  {release.publishedAt && ` · ${relativeTime(release.publishedAt)}`}
                </span>
              }
              bodyClassName=""
            >
              {release.body && (
                <div className="p-4">
                  <Markdown source={release.body} />
                </div>
              )}

              <div className="divide-y divide-line border-t border-line">
                <a
                  href={`${BASE_URL}/api/v1/repos/${repoPath}/archive/${encodeURIComponent(release.tagName)}?format=tar.gz`}
                  className="flex items-center justify-between px-4 py-2 text-xs hover:bg-raised"
                >
                  <span>Quelltext (tar.gz)</span>
                  <span className="text-faint">herunterladen</span>
                </a>
                <a
                  href={`${BASE_URL}/api/v1/repos/${repoPath}/archive/${encodeURIComponent(release.tagName)}?format=zip`}
                  className="flex items-center justify-between px-4 py-2 text-xs hover:bg-raised"
                >
                  <span>Quelltext (zip)</span>
                  <span className="text-faint">herunterladen</span>
                </a>
                {release.assets.map((asset) => (
                  <div key={asset.id} className="flex items-center gap-3 px-4 py-2 text-xs">
                    <a href={asset.downloadUrl} className="flex-1 truncate hover:text-accent">
                      {asset.name}
                    </a>
                    <span className="text-2xs text-faint">{formatBytes(asset.sizeBytes)}</span>
                    <span className="text-2xs text-faint">
                      {formatNumber(asset.downloadCount)} Downloads
                    </span>
                    {canWrite && (
                      <button
                        type="button"
                        onClick={async () => {
                          await api.delete(
                            `/api/v1/repos/${repoPath}/releases/assets/${asset.id}`,
                          );
                          setVersion((value) => value + 1);
                        }}
                        className="text-2xs text-muted hover:text-danger"
                      >
                        Entfernen
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {canWrite && (
                <div className="flex items-center gap-3 border-t border-line px-4 py-2">
                  <AssetUpload
                    repoPath={repoPath}
                    tag={release.tagName}
                    onDone={() => setVersion((value) => value + 1)}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm(`Release ${release.tagName} löschen?`)) return;
                      await api.delete(
                        `/api/v1/repos/${repoPath}/releases/${encodeURIComponent(release.tagName)}`,
                      );
                      setVersion((value) => value + 1);
                    }}
                    className="ml-auto text-2xs text-muted hover:text-danger"
                  >
                    Release löschen
                  </button>
                </div>
              )}
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

function NewRelease({
  repo,
  onDone,
  onError,
}: {
  repo: RepositoryDetail;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const [form, setForm] = useState({
    tagName: '',
    name: '',
    body: '',
    draft: false,
    prerelease: false,
  });
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/v1/repos/${repoPath}/releases`, {
        tagName: form.tagName,
        name: form.name || null,
        body: form.body || null,
        draft: form.draft,
        prerelease: form.prerelease,
      });
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Anlegen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Panel title="Neues Release" bodyClassName="space-y-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Tag"
            placeholder="v1.0.0"
            hint="Existiert das Tag nicht, wird es auf dem Default-Branch angelegt."
            value={form.tagName}
            onChange={(event) => setForm({ ...form, tagName: event.target.value })}
            required
          />
          <Input
            label="Titel"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </div>
        <Textarea
          label="Beschreibung"
          rows={5}
          value={form.body}
          onChange={(event) => setForm({ ...form, body: event.target.value })}
          placeholder="Was ist neu? Markdown wird unterstützt."
        />
        <div className="flex gap-4">
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={form.draft}
              onChange={(event) => setForm({ ...form, draft: event.target.checked })}
              className="accent-[rgb(var(--accent))]"
            />
            Als Entwurf
          </label>
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={form.prerelease}
              onChange={(event) => setForm({ ...form, prerelease: event.target.checked })}
              className="accent-[rgb(var(--accent))]"
            />
            Vorabversion
          </label>
        </div>
        <Button type="submit" variant="primary" loading={busy}>
          Release anlegen
        </Button>
      </Panel>
    </form>
  );
}

function AssetUpload({
  repoPath,
  tag,
  onDone,
}: {
  repoPath: string;
  tag: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    try {
      // Der Rohinhalt wird direkt gesendet; der Dateiname steht im Header,
      // damit der Server ihn nicht aus dem Body raten muss.
      // apiUpload beschafft den CSRF-Token und erneuert ihn bei Bedarf.
      // Vorher stand hier ein Lesen von document.cookie, das bei getrennten
      // Hosts für Frontend und API nie einen Wert liefern kann.
      await apiUpload(
        `/api/v1/repos/${repoPath}/releases/${encodeURIComponent(tag)}/assets`,
        file,
        'application/octet-stream',
        { 'x-forge-filename': file.name },
      );
      onDone();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Upload fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="cursor-pointer text-2xs text-accent hover:underline">
      {busy ? 'Wird hochgeladen…' : '+ Datei anhängen'}
      <input
        type="file"
        className="hidden"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = '';
        }}
      />
    </label>
  );
}

// ===========================================================================
// Organisationen
// ===========================================================================

export function NewOrganizationPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', displayName: '', description: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ name: string }>('/api/v1/organizations', {
        name: form.name,
        displayName: form.displayName || null,
        description: form.description || null,
      });
      navigate(`/organizations/${created.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anlegen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-xl font-semibold">Neue Organisation</h1>
      <p className="mt-1 text-sm text-muted">
        Organisationen bündeln Repositories und Zugriffsrechte für ein Team.
      </p>

      <form onSubmit={submit} className="mt-6 space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Panel bodyClassName="space-y-4 p-5">
          <Input
            label="Name"
            hint="Erscheint in URLs. Teilt sich den Namensraum mit Benutzernamen."
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            required
            autoFocus
          />
          <Input
            label="Anzeigename"
            value={form.displayName}
            onChange={(event) => setForm({ ...form, displayName: event.target.value })}
          />
          <Textarea
            label="Beschreibung"
            rows={2}
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
          <Button type="submit" variant="primary" loading={busy}>
            Organisation anlegen
          </Button>
        </Panel>
      </form>
    </div>
  );
}

export function OrganizationPage() {
  const { org = '' } = useParams();
  const [data, setData] = useState<OrganizationSummary | null>(null);
  const [repos, setRepos] = useState<RepositorySummary[]>([]);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<'repos' | 'members' | 'teams'>('repos');

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<OrganizationSummary>(`/api/v1/organizations/${org}`, controller.signal)
      .then(setData)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });

    api
      .get<{ items: RepositorySummary[] }>(`/api/v1/organizations/${org}/repositories`, controller.signal)
      .then((d) => setRepos(d.items))
      .catch(() => {});

    api
      .get<{ items: OrganizationMember[] }>(`/api/v1/organizations/${org}/members`, controller.signal)
      .then((d) => setMembers(d.items))
      .catch(() => {});

    api
      .get<{ items: TeamSummary[] }>(`/api/v1/organizations/${org}/teams`, controller.signal)
      .then((d) => setTeams(d.items))
      .catch(() => setTeams([]));

    return () => controller.abort();
  }, [org, version]);

  if (error) return <div className="mx-auto max-w-[1000px] px-4 py-8"><ErrorBox error={error} /></div>;
  if (!data) return <Spin />;

  const canAdmin = data.viewerRole === 'owner' || data.viewerRole === 'admin';

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-6">
      <header className="flex flex-wrap items-start gap-4 border-b border-line pb-5">
        <Avatar name={data.name} size={64} url={data.avatarUrl} />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{data.displayName ?? data.name}</h1>
          <p className="text-sm text-muted">{data.name}</p>
          {data.description && <p className="mt-2 text-sm">{data.description}</p>}
          <p className="mt-2 text-2xs text-faint">
            {formatNumber(data.memberCount)} Mitglieder · {formatNumber(data.repositoryCount)}{' '}
            Repositories
            {data.viewerRole && ` · deine Rolle: ${data.viewerRole}`}
          </p>
        </div>
        {canAdmin && (
          <Link
            to={`/new?owner=${data.name}`}
            className="border border-accent bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:bg-accent/90"
          >
            Neues Repository
          </Link>
        )}
      </header>

      <nav className="-mb-px mt-4 flex gap-1 border-b border-line">
        {(
          [
            ['repos', `Repositories (${repos.length})`],
            ['members', `Mitglieder (${members.length})`],
            ['teams', `Teams (${teams.length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cx(
              'border-b-2 px-3 py-2 text-xs font-medium',
              tab === key
                ? 'border-accent text-ink'
                : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="mt-5">
        {tab === 'repos' && (
          <Panel bodyClassName="divide-y divide-line">
            {repos.length === 0 ? (
              <EmptyState title="Keine sichtbaren Repositories" />
            ) : (
              repos.map((repo) => <RepoRow key={repo.id} repo={repo} />)
            )}
          </Panel>
        )}

        {tab === 'members' && (
          <MemberList
            org={data.name}
            members={members}
            canAdmin={canAdmin}
            onReload={() => setVersion((value) => value + 1)}
          />
        )}

        {tab === 'teams' && (
          <TeamList
            org={data.name}
            teams={teams}
            canAdmin={canAdmin}
            onReload={() => setVersion((value) => value + 1)}
          />
        )}
      </div>
    </div>
  );
}

function MemberList({
  org,
  members,
  canAdmin,
  onReload,
}: {
  org: string;
  members: OrganizationMember[];
  canAdmin: boolean;
  onReload: () => void;
}) {
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [message, setMessage] = useState<string | null>(null);

  async function invite(event: FormEvent) {
    event.preventDefault();
    try {
      await api.post(`/api/v1/organizations/${org}/invitations`, { username, role });
      setMessage(`${username} wurde eingeladen.`);
      setUsername('');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Einladung fehlgeschlagen.');
    }
  }

  return (
    <div className="space-y-4">
      {message && <Alert tone="info">{message}</Alert>}

      {canAdmin && (
        <form onSubmit={invite}>
          <Panel title="Person einladen" bodyClassName="flex flex-wrap items-end gap-3 p-4">
            <div className="min-w-[180px] flex-1">
              <Input
                label="Benutzername"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </div>
            <div className="w-36">
              <Select
                label="Rolle"
                value={role}
                onChange={(event) => setRole(event.target.value as typeof role)}
              >
                <option value="member">Mitglied</option>
                <option value="admin">Administrator</option>
              </Select>
            </div>
            <Button type="submit" variant="primary">
              Einladen
            </Button>
          </Panel>
        </form>
      )}

      <Panel bodyClassName="divide-y divide-line">
        {members.map((member) => (
          <div key={member.user.id} className="flex items-center gap-3 px-4 py-2.5">
            <Avatar name={member.user.username} size={24} url={member.user.avatarUrl} />
            <Link to={`/${member.user.username}`} className="flex-1 text-sm hover:text-accent">
              {member.user.username}
            </Link>
            <Badge tone={member.role === 'owner' ? 'accent' : 'neutral'}>{member.role}</Badge>
            {canAdmin && member.role !== 'owner' && (
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  await api.delete(`/api/v1/organizations/${org}/members/${member.user.username}`);
                  onReload();
                }}
              >
                Entfernen
              </Button>
            )}
          </div>
        ))}
      </Panel>
    </div>
  );
}

function TeamList({
  org,
  teams,
  canAdmin,
  onReload,
}: {
  org: string;
  teams: TeamSummary[];
  canAdmin: boolean;
  onReload: () => void;
}) {
  const [name, setName] = useState('');
  const [permission, setPermission] = useState('read');
  const [expanded, setExpanded] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    await api.post(`/api/v1/organizations/${org}/teams`, {
      name,
      defaultPermission: permission,
    });
    setName('');
    onReload();
  }

  return (
    <div className="space-y-4">
      {canAdmin && (
        <form onSubmit={create}>
          <Panel title="Team anlegen" bodyClassName="flex flex-wrap items-end gap-3 p-4">
            <div className="min-w-[180px] flex-1">
              <Input
                label="Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            <div className="w-40">
              <Select
                label="Standardrecht"
                value={permission}
                onChange={(event) => setPermission(event.target.value)}
              >
                <option value="read">Lesen</option>
                <option value="triage">Triage</option>
                <option value="write">Schreiben</option>
                <option value="maintain">Verwalten</option>
                <option value="admin">Administration</option>
              </Select>
            </div>
            <Button type="submit" variant="primary">
              Anlegen
            </Button>
          </Panel>
        </form>
      )}

      <Panel bodyClassName="divide-y divide-line">
        {teams.length === 0 ? (
          <EmptyState title="Keine Teams" />
        ) : (
          teams.map((team) => (
            <div key={team.id} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === team.slug ? null : team.slug)}
                  className="text-sm font-medium hover:text-accent"
                >
                  {team.name}
                </button>
                <Badge>{team.defaultPermission}</Badge>
                <span className="text-2xs text-faint">
                  {team.memberCount} Mitglieder · {team.repositoryCount} Repositories
                </span>
              </div>
              {expanded === team.slug && (
                <TeamDetail org={org} slug={team.slug} canAdmin={canAdmin} onReload={onReload} />
              )}
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

function TeamDetail({
  org,
  slug,
  canAdmin,
  onReload,
}: {
  org: string;
  slug: string;
  canAdmin: boolean;
  onReload: () => void;
}) {
  const [data, setData] = useState<{ items: any[]; isAllMembers: boolean } | null>(null);
  const [repo, setRepo] = useState('');
  const [permission, setPermission] = useState('read');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<typeof data>(`/api/v1/organizations/${org}/teams/${slug}/members`)
      .then(setData)
      .catch(() => setData({ items: [], isAllMembers: false }));
  }, [org, slug]);

  async function grant(event: FormEvent) {
    event.preventDefault();
    try {
      await api.put(`/api/v1/organizations/${org}/teams/${slug}/repositories`, {
        repository: repo,
        permission,
      });
      setMessage(`Zugriff auf ${repo} erteilt.`);
      setRepo('');
      onReload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Fehlgeschlagen.');
    }
  }

  if (!data) return <Spin />;

  return (
    <div className="mt-3 space-y-3 border-l-2 border-line pl-4">
      {message && <Alert tone="info">{message}</Alert>}

      <div>
        <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-faint">Mitglieder</p>
        {data.isAllMembers && (
          <p className="mb-1 text-2xs text-faint">
            Dieses Team enthält automatisch alle Mitglieder der Organisation.
          </p>
        )}
        <ul className="space-y-1">
          {data.items.map((entry: any) => (
            <li key={entry.user.id} className="flex items-center gap-2 text-xs">
              <Avatar name={entry.user.username} size={16} />
              {entry.user.username}
            </li>
          ))}
        </ul>
      </div>

      {canAdmin && (
        <form onSubmit={grant} className="flex flex-wrap items-end gap-2">
          <div className="w-40">
            <Input
              label="Repository"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              className="h-7 text-xs"
              required
            />
          </div>
          <div className="w-32">
            <Select
              label="Recht"
              value={permission}
              onChange={(event) => setPermission(event.target.value)}
              className="h-7 text-xs"
            >
              <option value="read">Lesen</option>
              <option value="write">Schreiben</option>
              <option value="maintain">Verwalten</option>
              <option value="admin">Administration</option>
            </Select>
          </div>
          <Button type="submit" size="sm">
            Zugriff erteilen
          </Button>
        </form>
      )}
    </div>
  );
}

// ===========================================================================
// Suche
// ===========================================================================

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);

  const q = params.get('q') ?? '';
  const type = params.get('type') ?? 'repositories';

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  useEffect(() => {
    if (!q) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .get<any>(`/api/v1/search?q=${encodeURIComponent(q)}&type=${type}`, controller.signal)
        .then(setData)
        .catch((err) => {
          if (err.name !== 'AbortError') setError(err);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, type]);

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6">
      <h1 className="text-xl font-semibold">Suche</h1>

      <div className="mt-4">
        <Input
          value={q}
          onChange={(event) => update('q', event.target.value)}
          placeholder="Suchbegriff eingeben…"
          autoFocus
        />
      </div>

      <nav className="-mb-px mt-4 flex gap-1 border-b border-line">
        {(
          [
            ['repositories', 'Repositories'],
            ['code', 'Code'],
            ['issues', 'Issues'],
            ['commits', 'Commits'],
            ['users', 'Benutzer'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => update('type', key)}
            className={cx(
              'border-b-2 px-3 py-2 text-xs font-medium',
              type === key ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="mt-5">
        {error ? (
          <ErrorBox error={error} />
        ) : !q ? (
          <EmptyState title="Gib einen Suchbegriff ein" />
        ) : !data ? (
          <Spin />
        ) : (
          <SearchResults data={data} />
        )}
      </div>
    </div>
  );
}

function SearchResults({ data }: { data: any }) {
  if (data.items.length === 0) {
    return <EmptyState title="Nichts gefunden" description="Versuche einen anderen Begriff." />;
  }

  if (data.type === 'repositories') {
    return (
      <Panel title={`${formatNumber(data.totalCount)} Treffer`} bodyClassName="divide-y divide-line">
        {data.items.map((repo: RepositorySummary) => (
          <RepoRow key={repo.id} repo={repo} showOwner />
        ))}
      </Panel>
    );
  }

  if (data.type === 'code') {
    return (
      <div className="space-y-3">
        {data.truncated && (
          <Alert tone="info">
            Die Suche wurde begrenzt ({data.searchedRepositories} Repositories durchsucht). Grenze
            sie mit einem genaueren Begriff ein.
          </Alert>
        )}
        {data.items.map((match: any, index: number) => (
          <Panel
            key={`${match.repositoryFullName}-${match.path}-${match.line}-${index}`}
            title={
              <Link
                to={`/${match.repositoryFullName}/blob/${match.path}`}
                className="font-mono text-xs hover:text-accent"
              >
                {match.repositoryFullName} · {match.path}
              </Link>
            }
            actions={<span className="text-2xs text-faint">{match.language}</span>}
            bodyClassName="overflow-x-auto"
          >
            <pre className="px-4 py-2 font-mono text-[0.75rem]">
              <span className="mr-3 select-none text-faint">{match.line}</span>
              {match.content}
            </pre>
          </Panel>
        ))}
      </div>
    );
  }

  if (data.type === 'issues') {
    return (
      <Panel title={`${formatNumber(data.totalCount)} Treffer`} bodyClassName="divide-y divide-line">
        {data.items.map((issue: any) => (
          <Link
            key={issue.id}
            to={`/${issue.repositoryFullName}/${issue.kind === 'pull_request' ? 'pulls' : 'issues'}/${issue.number}`}
            className="block px-4 py-3 hover:bg-raised/50"
          >
            <p className="text-sm font-medium">{issue.title}</p>
            <p className="mt-0.5 text-2xs text-faint">
              {issue.repositoryFullName}#{issue.number} · {issue.state}
            </p>
          </Link>
        ))}
      </Panel>
    );
  }

  if (data.type === 'commits') {
    return (
      <Panel title={`${formatNumber(data.totalCount)} Treffer`} bodyClassName="divide-y divide-line">
        {data.items.map((commit: any) => (
          <Link
            key={`${commit.repositoryFullName}-${commit.oid}`}
            to={`/${commit.repositoryFullName}/commit/${commit.oid}`}
            className="block px-4 py-3 hover:bg-raised/50"
          >
            <p className="text-sm">{commit.subject}</p>
            <p className="mt-0.5 text-2xs text-faint">
              {commit.repositoryFullName} · <code className="font-mono">{commit.shortOid}</code> ·{' '}
              {commit.authorName} · {relativeTime(commit.committedAt)}
            </p>
          </Link>
        ))}
      </Panel>
    );
  }

  return (
    <Panel bodyClassName="divide-y divide-line">
      {data.items.map((entry: any) => (
        <Link
          key={entry.id}
          to={entry.kind === 'organization' ? `/organizations/${entry.name}` : `/${entry.name}`}
          className="flex items-center gap-3 px-4 py-3 hover:bg-raised/50"
        >
          <Avatar name={entry.name} size={28} />
          <div>
            <p className="text-sm font-medium">{entry.displayName ?? entry.name}</p>
            <p className="text-2xs text-faint">
              {entry.name} · {entry.kind === 'organization' ? 'Organisation' : 'Benutzer'}
            </p>
          </div>
        </Link>
      ))}
    </Panel>
  );
}

// ===========================================================================
// Benachrichtigungen
// ===========================================================================

export function NotificationsPage() {
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api
      .get<{ items: NotificationItem[] }>(`/api/v1/notifications?unreadOnly=${unreadOnly}&perPage=50`)
      .then((d) => setItems(d.items))
      .catch(() => setItems([]));
  }, [unreadOnly, version]);

  const reasonLabel: Record<string, string> = {
    assign: 'Zugewiesen',
    author: 'Dein Beitrag',
    comment: 'Beteiligt',
    mention: 'Erwähnt',
    review_requested: 'Review angefragt',
    state_change: 'Zustand geändert',
    subscribed: 'Beobachtet',
    workflow_failure: 'CI fehlgeschlagen',
  };

  return (
    <div className="mx-auto max-w-[900px] px-4 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Benachrichtigungen</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(event) => setUnreadOnly(event.target.checked)}
              className="accent-[rgb(var(--accent))]"
            />
            Nur ungelesene
          </label>
          <Button
            size="sm"
            onClick={async () => {
              await api.post('/api/v1/notifications/read-all');
              setVersion((value) => value + 1);
            }}
          >
            Alle als gelesen markieren
          </Button>
        </div>
      </div>

      <Panel className="mt-4" bodyClassName="divide-y divide-line">
        {!items ? (
          <Spin />
        ) : items.length === 0 ? (
          <EmptyState
            title="Nichts Neues"
            description={unreadOnly ? 'Alles gelesen.' : 'Noch keine Benachrichtigungen.'}
          />
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className={cx(
                'flex items-start gap-3 px-4 py-3',
                !item.readAt && 'border-l-2 border-accent bg-raised/30',
              )}
            >
              <div className="min-w-0 flex-1">
                <Link to={item.targetPath} className="text-sm font-medium hover:text-accent">
                  {item.title}
                </Link>
                <p className="mt-0.5 text-2xs text-faint">
                  <Badge>{reasonLabel[item.reason] ?? item.reason}</Badge>{' '}
                  {item.repositoryFullName} · {relativeTime(item.createdAt)}
                </p>
              </div>
              {!item.readAt && (
                <button
                  type="button"
                  onClick={async () => {
                    await api.post('/api/v1/notifications/read', { ids: [item.id] });
                    setVersion((value) => value + 1);
                  }}
                  className="shrink-0 text-2xs text-muted hover:text-ink"
                >
                  Gelesen
                </button>
              )}
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

// ===========================================================================
// Administration
// ===========================================================================

export function AdminPage() {
  return (
    <div className="mx-auto max-w-[1100px] px-4 py-6">
      <h1 className="text-xl font-semibold">Administration</h1>

      <nav className="-mb-px mt-4 flex gap-1 border-b border-line">
        <AdminTab to="/admin" end>
          Übersicht
        </AdminTab>
        <AdminTab to="/admin/users">Benutzer</AdminTab>
        <AdminTab to="/admin/repositories">Repositories</AdminTab>
        <AdminTab to="/admin/runners">Runner</AdminTab>
        <AdminTab to="/admin/audit">Audit-Log</AdminTab>
      </nav>

      <div className="mt-5">
        <Routes>
          <Route index element={<AdminOverview />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="repositories" element={<AdminRepositories />} />
          <Route path="runners" element={<AdminRunners />} />
          <Route path="audit" element={<AdminAudit />} />
        </Routes>
      </div>
    </div>
  );
}

function AdminTab({ to, end, children }: { to: string; end?: boolean; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'border-b-2 px-3 py-2 text-xs font-medium',
          isActive ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink',
        )
      }
    >
      {children}
    </NavLink>
  );
}

function AdminOverview() {
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    api.get<any>('/api/v1/admin/stats').then(setStats).catch(() => {});
  }, []);

  if (!stats) return <Spin />;

  const cards = [
    { label: 'Benutzer', value: stats.users.total, detail: `${stats.users.active} aktiv, ${stats.users.suspended} gesperrt` },
    { label: 'Neu (30 Tage)', value: stats.users.newLast30Days, detail: 'Registrierungen' },
    { label: 'Repositories', value: stats.repositories.total, detail: `${stats.repositories.private} privat` },
    { label: 'Speicher', value: formatBytes(stats.repositories.storageBytes), detail: 'Git-Daten' },
    { label: 'Organisationen', value: stats.organizations.total, detail: '' },
    { label: 'Issues', value: stats.issues.total, detail: `${stats.issues.open} offen` },
    { label: 'CI-Läufe', value: stats.workflows.runs, detail: `${stats.workflows.failed} fehlgeschlagen` },
    { label: 'Runner', value: stats.runners.total, detail: '' },
    { label: 'Sitzungen', value: stats.sessions.active, detail: 'aktiv' },
  ];

  return (
    <div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => (
        <div key={card.label} className="bg-surface p-4">
          <p className="text-2xs uppercase tracking-wider text-faint">{card.label}</p>
          <p className="mt-1 text-2xl font-semibold">
            {typeof card.value === 'number' ? formatNumber(card.value) : card.value}
          </p>
          {card.detail && <p className="mt-0.5 text-2xs text-muted">{card.detail}</p>}
        </div>
      ))}
    </div>
  );
}

function AdminUsers() {
  const [items, setItems] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [version, setVersion] = useState(0);
  const { viewer } = useSession();

  useEffect(() => {
    const timer = setTimeout(() => {
      api
        .get<{ items: any[] }>(`/api/v1/admin/users?q=${encodeURIComponent(q)}&perPage=50`)
        .then((d) => setItems(d.items))
        .catch(() => setItems([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [q, version]);

  async function suspend(id: string) {
    const reason = prompt('Grund für die Sperre:');
    if (reason === null) return;
    await api.post(`/api/v1/admin/users/${id}/suspend`, { reason });
    setVersion((value) => value + 1);
  }

  return (
    <div className="space-y-4">
      <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Benutzer suchen" />

      <Panel bodyClassName="divide-y divide-line">
        {!items ? (
          <Spin />
        ) : (
          items.map((user) => (
            <div key={user.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <Avatar name={user.username} size={24} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {user.username}
                  {user.isAdmin && <Badge tone="accent">Admin</Badge>}
                  {user.suspendedAt && <Badge tone="danger">gesperrt</Badge>}
                  {!user.emailVerified && <Badge tone="warning">unbestätigt</Badge>}
                </p>
                <p className="text-2xs text-faint">
                  {user.email} · dabei seit {relativeTime(user.createdAt)}
                  {user.lastLoginAt && ` · zuletzt aktiv ${relativeTime(user.lastLoginAt)}`}
                </p>
              </div>

              {user.id !== viewer?.id && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={async () => {
                      await api.post(`/api/v1/admin/users/${user.id}/admin`, {
                        isAdmin: !user.isAdmin,
                      });
                      setVersion((value) => value + 1);
                    }}
                  >
                    {user.isAdmin ? 'Adminrechte entziehen' : 'Zum Admin machen'}
                  </Button>
                  {user.suspendedAt ? (
                    <Button
                      size="sm"
                      onClick={async () => {
                        await api.post(`/api/v1/admin/users/${user.id}/unsuspend`);
                        setVersion((value) => value + 1);
                      }}
                    >
                      Entsperren
                    </Button>
                  ) : (
                    <Button size="sm" variant="danger" onClick={() => suspend(user.id)}>
                      Sperren
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

function AdminRepositories() {
  const [items, setItems] = useState<any[] | null>(null);

  useEffect(() => {
    api
      .get<{ items: any[] }>('/api/v1/admin/repositories?perPage=50')
      .then((d) => setItems(d.items))
      .catch(() => setItems([]));
  }, []);

  if (!items) return <Spin />;

  return (
    <Panel bodyClassName="divide-y divide-line">
      {items.map((repo) => (
        <div key={repo.id} className="flex items-center gap-3 px-4 py-2.5">
          <Link to={`/${repo.fullName}`} className="flex-1 text-sm hover:text-accent">
            {repo.fullName}
          </Link>
          <Badge>{repo.visibility}</Badge>
          {repo.deletedAt && <Badge tone="danger">gelöscht</Badge>}
          <span className="text-2xs text-faint">{formatBytes(repo.sizeBytes)}</span>
        </div>
      ))}
    </Panel>
  );
}

function AdminRunners() {
  const [items, setItems] = useState<any[] | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api
      .get<{ items: any[] }>('/api/v1/admin/runners')
      .then((d) => setItems(d.items))
      .catch(() => setItems([]));
  }, [version]);

  if (!items) return <Spin />;

  return (
    <Panel bodyClassName="divide-y divide-line">
      {items.length === 0 ? (
        <EmptyState title="Keine Runner registriert" />
      ) : (
        items.map((runner) => (
          <div key={runner.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className={runner.status === 'offline' ? 'text-faint' : 'text-success'}>●</span>
            <div className="flex-1">
              <p className="text-sm font-medium">{runner.name}</p>
              <p className="text-2xs text-faint">
                {runner.scope} · {runner.labels.join(', ')}
                {runner.lastSeenAt && ` · ${relativeTime(runner.lastSeenAt)}`}
              </p>
            </div>
            <Badge>{runner.status}</Badge>
            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                await api.post(`/api/v1/admin/runners/${runner.id}/disable`);
                setVersion((value) => value + 1);
              }}
            >
              Deaktivieren
            </Button>
          </div>
        ))
      )}
    </Panel>
  );
}

function AdminAudit() {
  const [items, setItems] = useState<any[] | null>(null);
  const [action, setAction] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      api
        .get<{ items: any[] }>(`/api/v1/admin/audit-log?action=${encodeURIComponent(action)}&perPage=50`)
        .then((d) => setItems(d.items))
        .catch(() => setItems([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [action]);

  return (
    <div className="space-y-4">
      <Input
        value={action}
        onChange={(event) => setAction(event.target.value)}
        placeholder="Nach Aktion filtern, etwa repository.created"
      />

      <Panel bodyClassName="divide-y divide-line">
        {!items ? (
          <Spin />
        ) : items.length === 0 ? (
          <EmptyState title="Keine Einträge" />
        ) : (
          items.map((entry) => (
            <div key={entry.id} className="flex items-start gap-3 px-4 py-2 text-xs">
              <code className="shrink-0 font-mono text-accent">{entry.action}</code>
              <span className="min-w-0 flex-1 text-muted">
                {entry.actor ? (
                  <Link to={`/${entry.actor.username}`} className="hover:text-ink">
                    {entry.actor.username}
                  </Link>
                ) : (
                  'System'
                )}
                {entry.targetType && ` · ${entry.targetType}`}
                {Object.keys(entry.metadata ?? {}).length > 0 && (
                  <code className="ml-2 font-mono text-2xs text-faint">
                    {JSON.stringify(entry.metadata).slice(0, 120)}
                  </code>
                )}
              </span>
              <span className="shrink-0 text-2xs text-faint">
                {relativeTime(entry.createdAt)}
              </span>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}
