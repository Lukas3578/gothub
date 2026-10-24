/**
 * Dashboard, Repository-Anlage, Entdecken-Seite und Profil.
 * Alle Daten stammen aus der API.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Paginated, RepositorySummary, UserProfile } from '@forge/shared';
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
  Textarea,
  cx,
  formatBytes,
  formatNumber,
  languageColor,
  relativeTime,
} from '../components/ui.js';
import { Avatar } from '../components/Shell.js';

interface DashboardData {
  ownRepositories: RepositorySummary[];
  watchedRepositories: RepositorySummary[];
  organizations: { id: string; name: string; displayName: string | null; role: string }[];
  counts: { openIssues: number; openPullRequests: number; repositories: number };
  activity: {
    id: string;
    type: 'push';
    repositoryFullName: string;
    refName: string;
    commitCount: number;
    createdAt: string;
  }[];
}

export function DashboardPage() {
  const { viewer } = useSession();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<DashboardData>('/api/v1/dashboard', controller.signal)
      .then(setData)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });
    return () => controller.abort();
  }, []);

  if (error) {
    return (
      <div className="page py-8">
        <ErrorBox error={error} />
      </div>
    );
  }
  if (!data) return <Spin />;

  return (
    <div className="page py-6">
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          {!viewer?.emailVerified && (
            <Alert tone="warning" title="E-Mail noch nicht bestätigt">
              Prüfe dein Postfach. Ohne Bestätigung sind manche Funktionen eingeschränkt.
            </Alert>
          )}

          <Panel
            title="Deine Repositories"
            actions={
              <Link to="/new" className="text-2xs text-accent hover:underline">
                Neues Repository
              </Link>
            }
            bodyClassName="divide-y divide-line"
          >
            {data.ownRepositories.length === 0 ? (
              <EmptyState
                title="Noch keine Repositories"
                description="Lege eines an oder pushe ein bestehendes Projekt auf diese Instanz."
                action={
                  <Link
                    to="/new"
                    className="border border-accent bg-accent px-4 py-2 text-xs font-medium text-accent-ink hover:bg-accent/90"
                  >
                    Repository anlegen
                  </Link>
                }
              />
            ) : (
              data.ownRepositories.map((repo) => <RepoRow key={repo.id} repo={repo} />)
            )}
          </Panel>

          {data.watchedRepositories.length > 0 && (
            <Panel title="Beobachtet" bodyClassName="divide-y divide-line">
              {data.watchedRepositories.map((repo) => (
                <RepoRow key={repo.id} repo={repo} />
              ))}
            </Panel>
          )}

          <Panel title="Letzte Aktivität" bodyClassName="divide-y divide-line">
            {data.activity.length === 0 ? (
              <EmptyState
                title="Noch keine Aktivität"
                description="Sobald in sichtbaren Repositories gepusht wird, erscheint das hier."
              />
            ) : (
              data.activity.map((event) => (
                <div key={event.id} className="flex items-baseline gap-2 px-4 py-2.5 text-sm">
                  <span className="text-faint">↑</span>
                  <Link to={`/${event.repositoryFullName}`} className="link font-medium">
                    {event.repositoryFullName}
                  </Link>
                  <span className="text-muted">
                    {event.commitCount === 1
                      ? '1 Commit'
                      : `${formatNumber(event.commitCount)} Commits`}{' '}
                    nach
                  </span>
                  <code className="code text-muted">{event.refName}</code>
                  <span className="ml-auto shrink-0 text-2xs text-faint">
                    {relativeTime(event.createdAt)}
                  </span>
                </div>
              ))
            )}
          </Panel>
        </div>

        <aside className="space-y-5">
          <Panel bodyClassName="divide-y divide-line">
            <StatRow label="Repositories" value={data.counts.repositories} />
            <StatRow label="Offene Issues" value={data.counts.openIssues} />
            <StatRow label="Offene Pull Requests" value={data.counts.openPullRequests} />
          </Panel>

          <Panel title="Organisationen" bodyClassName="divide-y divide-line">
            {data.organizations.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted">
                Du bist in keiner Organisation.
              </p>
            ) : (
              data.organizations.map((org) => (
                <Link
                  key={org.id}
                  to={`/${org.name}`}
                  className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-raised"
                >
                  <Avatar name={org.name} size={20} />
                  <span className="text-sm font-medium">{org.displayName ?? org.name}</span>
                  <Badge>{org.role}</Badge>
                </Link>
              ))
            )}
          </Panel>

          <Panel title="Git-Schnellstart" bodyClassName="p-4">
            <p className="mb-2 text-xs text-muted">
              Für Push und Clone brauchst du ein Zugriffstoken statt deines Passworts.
            </p>
            <Link to="/settings/tokens" className="text-xs text-accent hover:underline">
              Token erstellen →
            </Link>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-sm font-semibold">{formatNumber(value)}</span>
    </div>
  );
}

export function RepoRow({ repo, showOwner = false }: { repo: RepositorySummary; showOwner?: boolean }) {
  return (
    <div className="px-4 py-3 hover:bg-raised/50">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/${repo.fullName}`} className="link text-sm font-semibold">
            {showOwner ? repo.fullName : repo.name}
          </Link>
          {repo.visibility !== 'public' && (
            <span className="ml-2">
              <Badge>{repo.visibility === 'private' ? 'privat' : 'intern'}</Badge>
            </span>
          )}
          {repo.isFork && (
            <span className="ml-1.5">
              <Badge>Fork</Badge>
            </span>
          )}
          {repo.isArchived && (
            <span className="ml-1.5">
              <Badge tone="warning">archiviert</Badge>
            </span>
          )}
          {repo.description && (
            <p className="mt-1 line-clamp-2 text-xs text-muted">{repo.description}</p>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-faint">
        {repo.primaryLanguage && (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5"
              style={{ background: languageColor(repo.primaryLanguage) }}
            />
            {repo.primaryLanguage}
          </span>
        )}
        {repo.starCount > 0 && <span>★ {formatNumber(repo.starCount)}</span>}
        {repo.forkCount > 0 && <span>⑂ {formatNumber(repo.forkCount)}</span>}
        {repo.sizeBytes > 0 && <span>{formatBytes(repo.sizeBytes)}</span>}
        <span>Aktualisiert {relativeTime(repo.pushedAt ?? repo.updatedAt)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repository anlegen
// ---------------------------------------------------------------------------

export function NewRepositoryPage() {
  const navigate = useNavigate();
  const { viewer } = useSession();

  const [form, setForm] = useState({
    name: '',
    description: '',
    visibility: 'private' as 'private' | 'public' | 'internal',
    initializeWithReadme: true,
    gitignoreTemplate: '',
    licenseTemplate: '',
  });
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const created = await api.post<RepositorySummary>('/api/v1/repositories', {
        name: form.name,
        description: form.description || null,
        visibility: form.visibility,
        initializeWithReadme: form.initializeWithReadme,
        gitignoreTemplate: form.gitignoreTemplate || null,
        licenseTemplate: form.licenseTemplate || null,
      });
      navigate(`/${created.fullName}`);
    } catch (err) {
      if (err instanceof ApiRequestError) setError(err);
      else throw err;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-xl font-semibold">Neues Repository</h1>
      <p className="mt-1 text-sm text-muted">
        Ein Repository enthält den Quelltext, die Historie und alles, was dazugehört.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-5">
        {error && !Object.keys(error.fieldErrors).length && (
          <Alert tone="danger">{error.message}</Alert>
        )}

        <Panel bodyClassName="space-y-5 p-5">
          <Input
            label="Name"
            name="name"
            prefix={`${viewer?.username ?? ''} /`}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            error={error?.fieldError('name')}
            placeholder="mein-projekt"
            autoFocus
            required
          />

          <Textarea
            label="Beschreibung (optional)"
            name="description"
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />

          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-muted">Sichtbarkeit</legend>
            {(
              [
                ['private', 'Privat', 'Nur du und ausdrücklich berechtigte Personen.'],
                ['internal', 'Intern', 'Alle angemeldeten Benutzer dieser Instanz.'],
                ['public', 'Öffentlich', 'Für jeden sichtbar, auch ohne Konto.'],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className={cx(
                  'flex cursor-pointer items-start gap-3 border p-3 transition-colors',
                  form.visibility === value
                    ? 'border-accent bg-accent/5'
                    : 'border-line hover:bg-raised',
                )}
              >
                <input
                  type="radio"
                  name="visibility"
                  value={value}
                  checked={form.visibility === value}
                  onChange={() => setForm({ ...form, visibility: value })}
                  className="mt-0.5 accent-[rgb(var(--accent))]"
                />
                <span>
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-xs text-muted">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </Panel>

        <Panel title="Startinhalt" bodyClassName="space-y-4 p-5">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={form.initializeWithReadme}
              onChange={(e) => setForm({ ...form, initializeWithReadme: e.target.checked })}
              className="mt-0.5 accent-[rgb(var(--accent))]"
            />
            <span>
              <span className="block text-sm font-medium">README anlegen</span>
              <span className="block text-xs text-muted">
                Erzeugt einen ersten Commit. Ohne Haken bleibt das Repository leer und du kannst
                ein bestehendes Projekt hineinpushen.
              </span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label=".gitignore"
              value={form.gitignoreTemplate}
              onChange={(e) => setForm({ ...form, gitignoreTemplate: e.target.value })}
            >
              <option value="">Keine</option>
              {['Node', 'Python', 'Java', 'Rust', 'Go'].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>

            <Select
              label="Lizenz"
              value={form.licenseTemplate}
              onChange={(e) => setForm({ ...form, licenseTemplate: e.target.value })}
            >
              <option value="">Keine</option>
              <option value="MIT">MIT</option>
              <option value="Apache-2.0">Apache 2.0</option>
            </Select>
          </div>
        </Panel>

        <div className="flex gap-3">
          <Button type="submit" variant="primary" loading={busy}>
            Repository anlegen
          </Button>
          <Button type="button" onClick={() => navigate(-1)}>
            Abbrechen
          </Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entdecken
// ---------------------------------------------------------------------------

export function ExplorePage() {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('updated');
  const [data, setData] = useState<Paginated<RepositorySummary> | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    // Kurze Verzögerung, damit nicht bei jedem Tastendruck gesucht wird.
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ sort, perPage: '30' });
      if (query) params.set('q', query);
      api
        .get<Paginated<RepositorySummary>>(`/api/v1/repositories?${params}`, controller.signal)
        .then(setData)
        .catch((err) => {
          if (err.name !== 'AbortError') setError(err);
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, sort]);

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6">
      <h1 className="text-xl font-semibold">Repositories entdecken</h1>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <Input
            label="Suche"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name oder Beschreibung"
          />
        </div>
        <div className="w-40">
          <Select label="Sortierung" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="updated">Zuletzt aktualisiert</option>
            <option value="created">Neueste</option>
            <option value="stars">Meiste Sterne</option>
            <option value="name">Name</option>
          </Select>
        </div>
      </div>

      {error ? (
        <div className="mt-5">
          <ErrorBox error={error} />
        </div>
      ) : !data ? (
        <Spin />
      ) : (
        <Panel
          className="mt-5"
          title={`${formatNumber(data.totalCount)} Repositories`}
          bodyClassName="divide-y divide-line"
        >
          {data.items.length === 0 ? (
            <EmptyState title="Nichts gefunden" description="Versuche einen anderen Suchbegriff." />
          ) : (
            data.items.map((repo) => <RepoRow key={repo.id} repo={repo} showOwner />)
          )}
        </Panel>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Benutzerprofil
// ---------------------------------------------------------------------------

export function ProfilePage() {
  const { owner = '' } = useParams();
  const { viewer } = useSession();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [repos, setRepos] = useState<RepositorySummary[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    setProfile(null);
    setError(null);

    Promise.all([
      api.get<UserProfile>(`/api/v1/users/${encodeURIComponent(owner)}`, controller.signal),
      api.get<Paginated<RepositorySummary>>(
        `/api/v1/users/${encodeURIComponent(owner)}/repositories?perPage=50`,
        controller.signal,
      ),
    ])
      .then(([p, r]) => {
        setProfile(p);
        setRepos(r.items);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err);
      });

    return () => controller.abort();
  }, [owner]);

  if (error) {
    return (
      <div className="mx-auto max-w-[1000px] px-4 py-8">
        <ErrorBox error={error} />
      </div>
    );
  }
  if (!profile) return <Spin />;

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-6">
      <div className="grid gap-6 md:grid-cols-[260px_1fr]">
        <aside>
          <Avatar name={profile.username} size={180} url={profile.avatarUrl} />
          <h1 className="mt-3 text-lg font-semibold">{profile.displayName ?? profile.username}</h1>
          <p className="text-sm text-muted">{profile.username}</p>

          {profile.bio && <p className="mt-3 text-sm leading-relaxed">{profile.bio}</p>}

          {viewer?.username === profile.username && (
            <Link
              to="/settings/profile"
              className="mt-4 block border border-line-strong bg-raised py-1.5 text-center text-xs font-medium hover:bg-line/60"
            >
              Profil bearbeiten
            </Link>
          )}

          <dl className="mt-5 space-y-2 border-t border-line pt-4 text-xs">
            {profile.company && <ProfileFact label="Firma" value={profile.company} />}
            {profile.location && <ProfileFact label="Ort" value={profile.location} />}
            {profile.email && <ProfileFact label="E-Mail" value={profile.email} />}
            {profile.websiteUrl && (
              <div>
                <dt className="text-faint">Website</dt>
                <dd>
                  <a
                    href={profile.websiteUrl}
                    className="link"
                    rel="noreferrer noopener nofollow"
                    target="_blank"
                  >
                    {profile.websiteUrl.replace(/^https?:\/\//, '')}
                  </a>
                </dd>
              </div>
            )}
            <ProfileFact label="Dabei seit" value={new Date(profile.createdAt).toLocaleDateString('de-DE')} />
          </dl>

          {profile.socialLinks.length > 0 && (
            <ul className="mt-4 space-y-1 border-t border-line pt-4 text-xs">
              {profile.socialLinks.map((link) => (
                <li key={link.url}>
                  <a href={link.url} className="link" rel="noreferrer noopener nofollow" target="_blank">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <Panel
          title={`Repositories (${formatNumber(profile.repositoryCount)})`}
          bodyClassName="divide-y divide-line"
        >
          {repos.length === 0 ? (
            <EmptyState title="Keine sichtbaren Repositories" />
          ) : (
            repos.map((repo) => <RepoRow key={repo.id} repo={repo} />)
          )}
        </Panel>
      </div>
    </div>
  );
}

function ProfileFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}
