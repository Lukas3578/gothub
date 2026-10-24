/**
 * Repository-Einstellungen jenseits der Grunddaten: Kollaborateure,
 * Branch-Schutz, Webhooks, Secrets, Variablen und Runner.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import type { CollaboratorEntry, RepositoryDetail, RunnerSummary } from '@forge/shared';
import { TEAM_PERMISSIONS } from '@forge/shared';
import { api } from '../lib/api.js';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Input,
  Panel,
  Select,
  Spin,
  cx,
  relativeTime,
} from '../components/ui.js';
import { Avatar } from '../components/Shell.js';

export function RepoSettingsLayout({
  repo,
  general,
}: {
  repo: RepositoryDetail;
  general: React.ReactNode;
}) {
  const base = `/${repo.ownerName}/${repo.name}/settings`;

  return (
    <div className="grid gap-6 md:grid-cols-[200px_1fr]">
      <nav className="flex flex-row gap-1 overflow-x-auto md:flex-col">
        <SettingsLink to={base} end>
          Allgemein
        </SettingsLink>
        <SettingsLink to={`${base}/collaborators`}>Zugriff</SettingsLink>
        <SettingsLink to={`${base}/branches`}>Branch-Schutz</SettingsLink>
        <SettingsLink to={`${base}/webhooks`}>Webhooks</SettingsLink>
        <SettingsLink to={`${base}/secrets`}>Secrets</SettingsLink>
        <SettingsLink to={`${base}/mirrors`}>Spiegelung</SettingsLink>
        <SettingsLink to={`${base}/runners`}>Runner</SettingsLink>
      </nav>

      <div>
        <Routes>
          <Route index element={general} />
          <Route path="collaborators" element={<CollaboratorSettings repo={repo} />} />
          <Route path="branches" element={<BranchProtectionSettings repo={repo} />} />
          <Route path="webhooks" element={<WebhookSettings repo={repo} />} />
          <Route path="secrets" element={<SecretSettings repo={repo} />} />
          <Route path="mirrors" element={<MirrorSettings repo={repo} />} />
          <Route path="runners" element={<RunnerSettings repo={repo} />} />
        </Routes>
      </div>
    </div>
  );
}

function SettingsLink({
  to,
  end,
  children,
}: {
  to: string;
  end?: boolean;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'whitespace-nowrap border-l-2 px-3 py-1.5 text-xs font-medium transition-colors',
          isActive
            ? 'border-accent bg-raised text-ink'
            : 'border-transparent text-muted hover:bg-raised hover:text-ink',
        )
      }
    >
      {children}
    </NavLink>
  );
}

// ---------------------------------------------------------------------------
// Kollaborateure
// ---------------------------------------------------------------------------

function CollaboratorSettings({ repo }: { repo: RepositoryDetail }) {
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const [items, setItems] = useState<CollaboratorEntry[] | null>(null);
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState<(typeof TEAM_PERMISSIONS)[number]>('write');
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api
      .get<{ items: CollaboratorEntry[] }>(`/api/v1/repos/${repoPath}/collaborators`)
      .then((d) => setItems(d.items))
      .catch(() => setItems([]));
  }, [repoPath, version]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api.put(`/api/v1/repos/${repoPath}/collaborators/${username}`, { permission });
      setUsername('');
      setVersion((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Hinzufügen fehlgeschlagen.');
    }
  }

  async function remove(name: string) {
    await api.delete(`/api/v1/repos/${repoPath}/collaborators/${name}`);
    setVersion((value) => value + 1);
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <form onSubmit={add}>
        <Panel title="Person hinzufügen" bodyClassName="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-[180px] flex-1">
            <Input
              label="Benutzername"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>
          <div className="w-40">
            <Select
              label="Berechtigung"
              value={permission}
              onChange={(event) => setPermission(event.target.value as typeof permission)}
            >
              <option value="read">Lesen</option>
              <option value="triage">Triage</option>
              <option value="write">Schreiben</option>
              <option value="maintain">Verwalten</option>
              <option value="admin">Administration</option>
            </Select>
          </div>
          <Button type="submit" variant="primary">
            Hinzufügen
          </Button>
        </Panel>
      </form>

      <Panel title="Zugriff" bodyClassName="divide-y divide-line">
        {!items ? (
          <Spin />
        ) : items.length === 0 ? (
          <EmptyState
            title="Keine weiteren Berechtigten"
            description="Nur der Besitzer hat derzeit Zugriff."
          />
        ) : (
          items.map((entry) => (
            <div
              key={`${entry.user.id}-${entry.source}`}
              className="flex items-center gap-3 px-4 py-2.5"
            >
              <Avatar name={entry.user.username} size={22} url={entry.user.avatarUrl} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{entry.user.username}</p>
                <p className="text-2xs text-faint">
                  {entry.source === 'direct' ? 'direkt zugewiesen' : `über Team "${entry.source}"`}
                </p>
              </div>
              <Badge>{entry.permission}</Badge>
              {entry.source === 'direct' && (
                <Button size="sm" variant="danger" onClick={() => remove(entry.user.username)}>
                  Entfernen
                </Button>
              )}
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Branch-Schutz
// ---------------------------------------------------------------------------

interface Protection {
  id: string;
  pattern: string;
  requirePullRequest: boolean;
  requiredApprovals: number;
  requireLinearHistory: boolean;
  blockForcePush: boolean;
  blockDeletion: boolean;
}

function BranchProtectionSettings({ repo }: { repo: RepositoryDetail }) {
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const [items, setItems] = useState<Protection[] | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    pattern: repo.defaultBranch,
    requirePullRequest: true,
    requiredApprovals: 1,
    requireLinearHistory: false,
    blockForcePush: true,
    blockDeletion: true,
  });

  useEffect(() => {
    api
      .get<{ items: Protection[] }>(`/api/v1/repos/${repoPath}/branch-protections`)
      .then((d) => setItems(d.items))
      .catch(() => setItems([]));
  }, [repoPath, version]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api.put(`/api/v1/repos/${repoPath}/branch-protections`, form);
      setVersion((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
    }
  }

  async function remove(id: string) {
    await api.delete(`/api/v1/repos/${repoPath}/branch-protections/${id}`);
    setVersion((value) => value + 1);
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <Alert tone="info">
        Schutzregeln gelten auch beim Push über die Kommandozeile – nicht nur in der Oberfläche.
      </Alert>

      <form onSubmit={save}>
        <Panel title="Regel anlegen oder ändern" bodyClassName="space-y-4 p-4">
          <Input
            label="Branch-Muster"
            hint="Genauer Name oder Glob, etwa main oder release/*"
            value={form.pattern}
            onChange={(event) => setForm({ ...form, pattern: event.target.value })}
            required
          />

          <div className="space-y-2">
            <Checkbox
              checked={form.requirePullRequest}
              onChange={(value) => setForm({ ...form, requirePullRequest: value })}
              label="Pull Request erforderlich"
              hint="Direkte Pushes auf diesen Branch werden abgelehnt."
            />
            {form.requirePullRequest && (
              <div className="ml-6 w-40">
                <Input
                  label="Nötige Zustimmungen"
                  type="number"
                  min={0}
                  max={10}
                  value={String(form.requiredApprovals)}
                  onChange={(event) =>
                    setForm({ ...form, requiredApprovals: Number(event.target.value) })
                  }
                />
              </div>
            )}
            <Checkbox
              checked={form.blockForcePush}
              onChange={(value) => setForm({ ...form, blockForcePush: value })}
              label="Force-Push verhindern"
              hint="Verhindert, dass Historie überschrieben wird."
            />
            <Checkbox
              checked={form.blockDeletion}
              onChange={(value) => setForm({ ...form, blockDeletion: value })}
              label="Löschen verhindern"
            />
            <Checkbox
              checked={form.requireLinearHistory}
              onChange={(value) => setForm({ ...form, requireLinearHistory: value })}
              label="Lineare Historie erzwingen"
              hint="Erlaubt nur Squash und Rebase, keinen Merge-Commit."
            />
          </div>

          <Button type="submit" variant="primary">
            Regel speichern
          </Button>
        </Panel>
      </form>

      <Panel title="Aktive Regeln" bodyClassName="divide-y divide-line">
        {!items ? (
          <Spin />
        ) : items.length === 0 ? (
          <EmptyState title="Keine Schutzregeln" description="Alle Branches sind frei beschreibbar." />
        ) : (
          items.map((item) => (
            <div key={item.id} className="flex items-center gap-3 px-4 py-3">
              <code className="font-mono text-sm font-medium">{item.pattern}</code>
              <span className="flex flex-wrap gap-1">
                {item.requirePullRequest && (
                  <Badge tone="info">PR nötig ({item.requiredApprovals})</Badge>
                )}
                {item.blockForcePush && <Badge>kein Force-Push</Badge>}
                {item.blockDeletion && <Badge>nicht löschbar</Badge>}
                {item.requireLinearHistory && <Badge>linear</Badge>}
              </span>
              <Button size="sm" variant="danger" className="ml-auto" onClick={() => remove(item.id)}>
                Entfernen
              </Button>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 accent-[rgb(var(--accent))]"
      />
      <span>
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-2xs text-faint">{hint}</span>}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

const WEBHOOK_EVENTS = [
  'push',
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'release',
  'workflow_run',
] as const;

function WebhookSettings({ repo }: { repo: RepositoryDetail }) {
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const [items, setItems] = useState<any[] | null>(null);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['push']);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ items: any[] }>(`/api/v1/repos/${repoPath}/webhooks`)
      .then((d) => setItems(d.items))
      .catch(() => setItems([]));
  }, [repoPath, version]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const result = await api.post<{ secret: string }>(`/api/v1/repos/${repoPath}/webhooks`, {
        url,
        events,
      });
      setCreated(result.secret);
      setUrl('');
      setVersion((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anlegen fehlgeschlagen.');
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {created && (
        <Alert tone="success" title="Webhook angelegt – Geheimnis jetzt sichern">
          <p className="mb-2">
            Mit diesem Wert prüfst du die Signatur im Header{' '}
            <code className="code">x-forge-signature-256</code>. Er wird nur einmal angezeigt.
          </p>
          <code className="block select-all break-all border border-line bg-canvas p-2 font-mono text-xs">
            {created}
          </code>
        </Alert>
      )}

      <form onSubmit={add}>
        <Panel title="Webhook anlegen" bodyClassName="space-y-4 p-4">
          <Input
            label="Ziel-URL"
            type="url"
            placeholder="https://beispiel.de/hook"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            required
          />
          <fieldset>
            <legend className="mb-1.5 text-xs font-medium text-muted">Ereignisse</legend>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {WEBHOOK_EVENTS.map((name) => (
                <label key={name} className="flex items-center gap-1.5 text-2xs">
                  <input
                    type="checkbox"
                    checked={events.includes(name)}
                    onChange={(event) =>
                      setEvents(
                        event.target.checked
                          ? [...events, name]
                          : events.filter((entry) => entry !== name),
                      )
                    }
                    className="accent-[rgb(var(--accent))]"
                  />
                  <code className="font-mono">{name}</code>
                </label>
              ))}
            </div>
          </fieldset>
          <Button type="submit" variant="primary" disabled={events.length === 0}>
            Webhook anlegen
          </Button>
        </Panel>
      </form>

      <Panel title="Eingerichtete Webhooks" bodyClassName="divide-y divide-line">
        {!items ? (
          <Spin />
        ) : items.length === 0 ? (
          <EmptyState title="Keine Webhooks" />
        ) : (
          items.map((hook) => (
            <div key={hook.id} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <span className={hook.isActive ? 'text-success' : 'text-danger'}>
                  {hook.isActive ? '●' : '○'}
                </span>
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{hook.url}</code>
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === hook.id ? null : hook.id)}
                  className="text-2xs text-muted hover:text-ink"
                >
                  Zustellungen
                </button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    await api.delete(`/api/v1/repos/${repoPath}/webhooks/${hook.id}`);
                    setVersion((value) => value + 1);
                  }}
                >
                  Löschen
                </Button>
              </div>
              <p className="mt-1 text-2xs text-faint">
                {hook.events.join(', ')}
                {hook.consecutiveFailures > 0 && (
                  <span className="ml-2 text-danger">
                    {hook.consecutiveFailures} Fehlschläge in Folge
                  </span>
                )}
              </p>
              {expanded === hook.id && <DeliveryList repoPath={repoPath} hookId={hook.id} />}
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

function DeliveryList({ repoPath, hookId }: { repoPath: string; hookId: string }) {
  const [items, setItems] = useState<any[] | null>(null);

  useEffect(() => {
    api
      .get<{ items: any[] }>(`/api/v1/repos/${repoPath}/webhooks/${hookId}/deliveries`)
      .then((d) => setItems(d.items))
      .catch(() => setItems([]));
  }, [repoPath, hookId]);

  if (!items) return <Spin label="Zustellungen werden geladen…" />;
  if (items.length === 0) {
    return <p className="mt-2 text-2xs text-faint">Noch keine Zustellungen.</p>;
  }

  return (
    <ul className="mt-2 space-y-1 border-t border-line pt-2">
      {items.map((delivery) => (
        <li key={delivery.id} className="flex items-center gap-2 text-2xs">
          <span
            className={
              delivery.responseStatus && delivery.responseStatus < 300
                ? 'text-success'
                : 'text-danger'
            }
          >
            {delivery.responseStatus ?? 'Fehler'}
          </span>
          <code className="font-mono">{delivery.event}</code>
          <span className="text-faint">{delivery.durationMs}ms</span>
          {delivery.error && <span className="truncate text-danger">{delivery.error}</span>}
          <span className="ml-auto text-faint">{relativeTime(delivery.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Secrets und Variablen
// ---------------------------------------------------------------------------

function SecretSettings({ repo }: { repo: RepositoryDetail }) {
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const [secrets, setSecrets] = useState<any[] | null>(null);
  const [variables, setVariables] = useState<any[] | null>(null);
  const [version, setVersion] = useState(0);
  const [secretForm, setSecretForm] = useState({ name: '', value: '' });
  const [variableForm, setVariableForm] = useState({ name: '', value: '' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<{ items: any[] }>(`/api/v1/repos/${repoPath}/secrets`),
      api.get<{ items: any[] }>(`/api/v1/repos/${repoPath}/variables`),
    ])
      .then(([s, v]) => {
        setSecrets(s.items);
        setVariables(v.items);
      })
      .catch(() => {
        setSecrets([]);
        setVariables([]);
      });
  }, [repoPath, version]);

  async function saveSecret(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api.put(`/api/v1/repos/${repoPath}/secrets/${secretForm.name}`, {
        value: secretForm.value,
      });
      setSecretForm({ name: '', value: '' });
      setVersion((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
    }
  }

  async function saveVariable(event: FormEvent) {
    event.preventDefault();
    try {
      await api.put(`/api/v1/repos/${repoPath}/variables/${variableForm.name}`, {
        value: variableForm.value,
      });
      setVariableForm({ name: '', value: '' });
      setVersion((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <Alert tone="info">
        Secrets werden verschlüsselt gespeichert und nur an den Runner übergeben, der den
        zugehörigen Job ausführt. Sie erscheinen nie in der Oberfläche oder im Log.
      </Alert>

      <form onSubmit={saveSecret}>
        <Panel title="Secret setzen" bodyClassName="flex flex-wrap items-end gap-3 p-4">
          <div className="w-48">
            <Input
              label="Name"
              placeholder="DEPLOY_KEY"
              value={secretForm.name}
              onChange={(event) =>
                setSecretForm({ ...secretForm, name: event.target.value.toUpperCase() })
              }
              required
            />
          </div>
          <div className="min-w-[200px] flex-1">
            <Input
              label="Wert"
              type="password"
              value={secretForm.value}
              onChange={(event) => setSecretForm({ ...secretForm, value: event.target.value })}
              required
            />
          </div>
          <Button type="submit" variant="primary">
            Speichern
          </Button>
        </Panel>
      </form>

      <Panel title="Secrets" bodyClassName="divide-y divide-line">
        {!secrets ? (
          <Spin />
        ) : secrets.length === 0 ? (
          <EmptyState title="Keine Secrets" />
        ) : (
          secrets.map((secret) => (
            <div key={secret.id} className="flex items-center gap-3 px-4 py-2.5">
              <code className="font-mono text-sm">{secret.name}</code>
              <span className="text-2xs text-faint">
                aktualisiert {relativeTime(secret.updatedAt)}
              </span>
              <Button
                size="sm"
                variant="danger"
                className="ml-auto"
                onClick={async () => {
                  await api.delete(`/api/v1/repos/${repoPath}/secrets/${secret.name}`);
                  setVersion((value) => value + 1);
                }}
              >
                Löschen
              </Button>
            </div>
          ))
        )}
      </Panel>

      <form onSubmit={saveVariable}>
        <Panel title="Variable setzen" bodyClassName="flex flex-wrap items-end gap-3 p-4">
          <div className="w-48">
            <Input
              label="Name"
              value={variableForm.name}
              onChange={(event) =>
                setVariableForm({ ...variableForm, name: event.target.value.toUpperCase() })
              }
              required
            />
          </div>
          <div className="min-w-[200px] flex-1">
            <Input
              label="Wert"
              value={variableForm.value}
              onChange={(event) => setVariableForm({ ...variableForm, value: event.target.value })}
            />
          </div>
          <Button type="submit">Speichern</Button>
        </Panel>
      </form>

      <Panel title="Variablen" bodyClassName="divide-y divide-line">
        {!variables ? (
          <Spin />
        ) : variables.length === 0 ? (
          <EmptyState title="Keine Variablen" />
        ) : (
          variables.map((variable) => (
            <div key={variable.id} className="flex items-center gap-3 px-4 py-2.5">
              <code className="font-mono text-sm">{variable.name}</code>
              <code className="truncate text-xs text-muted">{variable.value}</code>
              <Button
                size="sm"
                variant="danger"
                className="ml-auto"
                onClick={async () => {
                  await api.delete(`/api/v1/repos/${repoPath}/variables/${variable.name}`);
                  setVersion((value) => value + 1);
                }}
              >
                Löschen
              </Button>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spiegelung auf andere Git-Hoster
// ---------------------------------------------------------------------------

interface MirrorEntry {
  id: string;
  direction: 'push' | 'pull';
  remoteUrl: string;
  remoteUsername: string | null;
  hasToken: boolean;
  isEnabled: boolean;
  isExactCopy: boolean;
  status: 'idle' | 'running' | 'success' | 'failure';
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
}

const MIRROR_STATUS: Record<MirrorEntry['status'], { label: string; tone: string }> = {
  idle: { label: 'wartet', tone: 'text-faint' },
  running: { label: 'läuft', tone: 'text-accent' },
  success: { label: 'erfolgreich', tone: 'text-success' },
  failure: { label: 'fehlgeschlagen', tone: 'text-danger' },
};

function MirrorSettings({ repo }: { repo: RepositoryDetail }) {
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const [items, setItems] = useState<MirrorEntry[] | null>(null);
  const [version, setVersion] = useState(0);

  const [direction, setDirection] = useState<'push' | 'pull'>('push');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteUsername, setRemoteUsername] = useState('');
  const [token, setToken] = useState('');
  const [isExactCopy, setIsExactCopy] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ items: MirrorEntry[] }>(`/api/v1/repos/${repoPath}/mirrors`)
      .then((d) => setItems(d.items))
      .catch(() => setItems([]));
  }, [repoPath, version]);

  /** Gemeinsame Nutzlast von „Prüfen" und „Speichern". */
  function payload() {
    return {
      direction,
      remoteUrl: remoteUrl.trim(),
      remoteUsername: remoteUsername.trim() || null,
      token: token.trim() || null,
    };
  }

  async function test() {
    setError(null);
    setNotice(null);
    setBusy('test');
    try {
      const result = await api.post<{ ok: boolean; refCount?: number; error?: string }>(
        `/api/v1/repos/${repoPath}/mirrors/test`,
        payload(),
      );
      if (result.ok) {
        setNotice(
          `Verbindung steht. Die Gegenseite meldet ${result.refCount ?? 0} Referenzen (Branches und Tags).`,
        );
      } else {
        setError(result.error ?? 'Die Gegenseite war nicht erreichbar.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Prüfung fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setBusy('save');
    try {
      await api.put(`/api/v1/repos/${repoPath}/mirrors`, { ...payload(), isExactCopy });
      setRemoteUrl('');
      setRemoteUsername('');
      setToken('');
      setIsExactCopy(false);
      setNotice(
        direction === 'push'
          ? 'Spiegelung eingerichtet. Ab dem nächsten Push wird automatisch weitergeschoben.'
          : 'Spiegelung eingerichtet. Die Gegenseite wird alle paar Minuten abgeholt.',
      );
      setVersion((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  async function sync(id: string) {
    setError(null);
    setNotice(null);
    setBusy(id);
    try {
      const result = await api.post<{ ok: boolean; error?: string }>(
        `/api/v1/repos/${repoPath}/mirrors/${id}/sync`,
        {},
      );
      if (!result.ok) setError(result.error ?? 'Übertragung fehlgeschlagen.');
      else setNotice('Übertragung abgeschlossen.');
      setVersion((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Übertragung fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  }

  async function toggle(entry: MirrorEntry, enabled: boolean) {
    setError(null);
    try {
      // Ohne `token` bleibt das hinterlegte Token unverändert – nur der
      // Schalter wird geschrieben.
      await api.put(`/api/v1/repos/${repoPath}/mirrors`, {
        direction: entry.direction,
        remoteUrl: entry.remoteUrl,
        remoteUsername: entry.remoteUsername,
        isEnabled: enabled,
        isExactCopy: entry.isExactCopy,
      });
      setVersion((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Änderung fehlgeschlagen.');
    }
  }

  const existing = new Set((items ?? []).map((entry) => entry.direction));

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Panel title="Was eine Spiegelung tut" bodyClassName="space-y-2 p-4 text-xs text-muted">
        <p>
          <strong className="text-ink">Hinaus (push):</strong> Nach jedem Push an dieses Repository
          schiebt Forge alle Branches und Tags an die angegebene Adresse weiter. Nützlich, um eine
          Kopie auf GitHub, GitLab oder Codeberg aktuell zu halten – etwa damit Werkzeuge, die nur
          dort hinkommen, mit dem Quelltext arbeiten können.
        </p>
        <p>
          <strong className="text-ink">Herein (pull):</strong> Forge holt alle fünf Minuten von der
          angegebenen Adresse. Dieses Repository ist dann eine Kopie und sollte nicht direkt
          beschrieben werden.
        </p>
        <p>
          Je Richtung ist eine Spiegelung möglich, und beide Richtungen schließen sich gegenseitig
          aus. Ein Token wird verschlüsselt gespeichert, nie wieder angezeigt und steht in keinem
          Protokoll und keiner Kommandozeile.
        </p>
      </Panel>

      <form onSubmit={save}>
        <Panel title="Spiegelung einrichten" bodyClassName="space-y-4 p-4">
          <Select
            label="Richtung"
            value={direction}
            onChange={(event) => setDirection(event.target.value as 'push' | 'pull')}
          >
            <option value="push">Hinaus – Forge schiebt nach jedem Push weiter</option>
            <option value="pull">Herein – Forge holt regelmäßig von dort</option>
          </Select>

          <Input
            label="Adresse der Gegenseite"
            type="url"
            placeholder="https://github.com/benutzer/repository.git"
            value={remoteUrl}
            onChange={(event) => setRemoteUrl(event.target.value)}
            hint="Nur https. Zugangsdaten gehören nicht in die Adresse, sondern in die beiden Felder darunter."
            required
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Benutzername"
              placeholder="bei GitHub: dein Kontoname"
              value={remoteUsername}
              onChange={(event) => setRemoteUsername(event.target.value)}
              autoComplete="off"
            />
            <Input
              label="Token"
              type="password"
              placeholder="Personal Access Token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              hint="Beim Bearbeiten leer lassen, um das vorhandene Token zu behalten."
              autoComplete="new-password"
            />
          </div>

          <Checkbox
            checked={isExactCopy}
            onChange={setIsExactCopy}
            label="Exakte Kopie erzwingen"
            hint={
              direction === 'push'
                ? 'Überschreibt auf der Gegenseite abweichende Branches und löscht dort Branches, die es hier nicht gibt (--mirror). Ohne diesen Haken werden nur Branches und Tags aktualisiert.'
                : 'Verwirft hier lokale Abweichungen und übernimmt den Stand der Gegenseite vollständig.'
            }
          />

          {existing.has(direction) && (
            <Alert tone="warning">
              Für diese Richtung ist schon eine Spiegelung eingerichtet. Speichern überschreibt sie.
            </Alert>
          )}

          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={!remoteUrl.trim() || busy !== null}>
              {busy === 'save' ? 'Wird gespeichert…' : 'Speichern'}
            </Button>
            <Button
              type="button"
              onClick={test}
              disabled={!remoteUrl.trim() || busy !== null}
              title="Prüft Adresse und Token, ohne etwas zu übertragen."
            >
              {busy === 'test' ? 'Wird geprüft…' : 'Verbindung prüfen'}
            </Button>
          </div>
        </Panel>
      </form>

      <Panel title="Eingerichtete Spiegelungen" bodyClassName="divide-y divide-line">
        {!items ? (
          <Spin />
        ) : items.length === 0 ? (
          <EmptyState title="Keine Spiegelung eingerichtet" />
        ) : (
          items.map((entry) => (
            <div key={entry.id} className="space-y-1.5 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={entry.direction === 'push' ? 'accent' : 'neutral'}>
                  {entry.direction === 'push' ? 'hinaus' : 'herein'}
                </Badge>
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{entry.remoteUrl}</code>
                <Button size="sm" onClick={() => sync(entry.id)} disabled={busy !== null}>
                  {busy === entry.id ? 'läuft…' : 'Jetzt übertragen'}
                </Button>
                <Button
                  size="sm"
                  onClick={() => toggle(entry, !entry.isEnabled)}
                  disabled={busy !== null}
                >
                  {entry.isEnabled ? 'Pausieren' : 'Fortsetzen'}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    await api.delete(`/api/v1/repos/${repoPath}/mirrors/${entry.id}`);
                    setVersion((value) => value + 1);
                  }}
                >
                  Löschen
                </Button>
              </div>

              <p className="text-2xs text-faint">
                <span className={MIRROR_STATUS[entry.status].tone}>
                  {MIRROR_STATUS[entry.status].label}
                </span>
                {entry.lastSyncAt && <> · zuletzt {relativeTime(entry.lastSyncAt)}</>}
                {!entry.isEnabled && <> · pausiert</>}
                {entry.isExactCopy && <> · exakte Kopie</>}
                {entry.remoteUsername && <> · als {entry.remoteUsername}</>}
                <> · {entry.hasToken ? 'Token hinterlegt' : 'ohne Token'}</>
              </p>

              {entry.lastError && (
                <p className="break-all text-2xs text-danger">{entry.lastError}</p>
              )}
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function RunnerSettings({ repo }: { repo: RepositoryDetail }) {
  const repoPath = `${repo.ownerName}/${repo.name}`;
  const [items, setItems] = useState<RunnerSummary[] | null>(null);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api
      .get<{ items: RunnerSummary[] }>(`/api/v1/repos/${repoPath}/runners`)
      .then((d) => setItems(d.items))
      .catch(() => setItems([]));
  }, [repoPath, version]);

  async function register(event: FormEvent) {
    event.preventDefault();
    const result = await api.post<{ token: string }>(`/api/v1/repos/${repoPath}/runners`, {
      name,
      labels: ['self-hosted', 'ubuntu-latest'],
    });
    setCreated(result.token);
    setName('');
    setVersion((value) => value + 1);
  }

  return (
    <div className="space-y-4">
      {created && (
        <Alert tone="success" title="Runner registriert">
          <p className="mb-2">Starte den Runner auf deinem Server mit diesem Token:</p>
          <pre className="overflow-x-auto border border-line bg-canvas p-2 font-mono text-2xs">
            <code>{`FORGE_API_URL=${window.location.protocol}//${window.location.hostname}:4000 \\
FORGE_RUNNER_TOKEN=${created} \\
FORGE_RUNNER_LABELS=self-hosted,ubuntu-latest \\
npm run dev --workspace @forge/runner`}</code>
          </pre>
          <p className="mt-2 text-2xs">
            Das Token wird nur einmal angezeigt. Der Runner braucht Zugriff auf einen
            Docker-Daemon.
          </p>
        </Alert>
      )}

      <form onSubmit={register}>
        <Panel title="Runner registrieren" bodyClassName="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-[200px] flex-1">
            <Input
              label="Name"
              placeholder="build-server-1"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <Button type="submit" variant="primary">
            Registrieren
          </Button>
        </Panel>
      </form>

      <Panel title="Runner" bodyClassName="divide-y divide-line">
        {!items ? (
          <Spin />
        ) : items.length === 0 ? (
          <EmptyState
            title="Kein Runner registriert"
            description="Ohne Runner bleiben Workflow-Jobs in der Warteschlange."
          />
        ) : (
          items.map((runner) => (
            <div key={runner.id} className="flex items-center gap-3 px-4 py-3">
              <span
                className={
                  runner.status === 'idle'
                    ? 'text-success'
                    : runner.status === 'busy'
                      ? 'text-warning'
                      : 'text-faint'
                }
              >
                ●
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{runner.name}</p>
                <p className="text-2xs text-faint">
                  {runner.labels.join(', ')}
                  {runner.osName && ` · ${runner.osName}/${runner.architecture}`}
                  {runner.lastSeenAt && ` · zuletzt gesehen ${relativeTime(runner.lastSeenAt)}`}
                </p>
              </div>
              <Badge
                tone={
                  runner.status === 'idle'
                    ? 'success'
                    : runner.status === 'busy'
                      ? 'warning'
                      : 'neutral'
                }
              >
                {runner.status === 'idle'
                  ? 'bereit'
                  : runner.status === 'busy'
                    ? 'beschäftigt'
                    : runner.status === 'disabled'
                      ? 'deaktiviert'
                      : 'offline'}
              </Badge>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  await api.delete(`/api/v1/repos/${repoPath}/runners/${runner.id}`);
                  setVersion((value) => value + 1);
                }}
              >
                Entfernen
              </Button>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}
