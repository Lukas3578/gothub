/**
 * Kontoeinstellungen: Profil, Passwort, Sitzungen, Zugriffstokens, 2FA.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import type { SessionInfo } from '@forge/shared';
import { ApiRequestError, api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Input,
  Panel,
  Spin,
  Textarea,
  cx,
  relativeTime,
} from '../components/ui.js';
import { AvatarSettings, SshKeysSettings } from './extras.js';

export function SettingsPage() {
  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6">
      <h1 className="text-xl font-semibold">Einstellungen</h1>

      <div className="mt-5 grid gap-6 md:grid-cols-[200px_1fr]">
        <nav className="flex flex-row gap-1 overflow-x-auto md:flex-col">
          <SettingsLink to="/settings/profile">Profil</SettingsLink>
          <SettingsLink to="/settings/account">Konto</SettingsLink>
          <SettingsLink to="/settings/sessions">Sitzungen</SettingsLink>
          <SettingsLink to="/settings/tokens">Zugriffstokens</SettingsLink>
          <SettingsLink to="/settings/ssh-keys">SSH-Schlüssel</SettingsLink>
          <SettingsLink to="/settings/security">Sicherheit</SettingsLink>
        </nav>

        <div>
          <Routes>
            <Route path="profile" element={<ProfileSettings />} />
            <Route path="account" element={<AccountSettings />} />
            <Route path="sessions" element={<SessionSettings />} />
            <Route path="tokens" element={<TokenSettings />} />
            <Route path="ssh-keys" element={<SshKeysSettings />} />
            <Route path="security" element={<SecuritySettings />} />
            <Route path="*" element={<ProfileSettings />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

function SettingsLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
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

function ProfileSettings() {
  const { viewer, refresh } = useSession();
  const [form, setForm] = useState({
    displayName: '',
    bio: '',
    company: '',
    location: '',
    websiteUrl: '',
    emailPublic: false,
  });
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!viewer) return;
    api
      .get<Record<string, unknown>>(`/api/v1/users/${viewer.username}`)
      .then((profile) => {
        setForm({
          displayName: (profile.displayName as string) ?? '',
          bio: (profile.bio as string) ?? '',
          company: (profile.company as string) ?? '',
          location: (profile.location as string) ?? '',
          websiteUrl: (profile.websiteUrl as string) ?? '',
          emailPublic: Boolean(profile.email),
        });
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [viewer?.username]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.patch('/api/v1/user/profile', {
        displayName: form.displayName || null,
        bio: form.bio || null,
        company: form.company || null,
        location: form.location || null,
        websiteUrl: form.websiteUrl || null,
        emailPublic: form.emailPublic,
      });
      await refresh();
      setMessage('Profil gespeichert.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <Spin />;

  return (
    <form onSubmit={save} className="space-y-4">
      {message && <Alert tone="success">{message}</Alert>}
      <AvatarSettings />
      <Panel title="Öffentliches Profil" bodyClassName="space-y-4 p-5">
        <Input
          label="Anzeigename"
          value={form.displayName}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
        />
        <Textarea
          label="Über dich"
          rows={3}
          value={form.bio}
          onChange={(e) => setForm({ ...form, bio: e.target.value })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Firma"
            value={form.company}
            onChange={(e) => setForm({ ...form, company: e.target.value })}
          />
          <Input
            label="Ort"
            value={form.location}
            onChange={(e) => setForm({ ...form, location: e.target.value })}
          />
        </div>
        <Input
          label="Website"
          type="url"
          placeholder="https://"
          value={form.websiteUrl}
          onChange={(e) => setForm({ ...form, websiteUrl: e.target.value })}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.emailPublic}
            onChange={(e) => setForm({ ...form, emailPublic: e.target.checked })}
            className="accent-[rgb(var(--accent))]"
          />
          E-Mail-Adresse auf dem Profil anzeigen
        </label>
        <Button type="submit" variant="primary" loading={busy}>
          Speichern
        </Button>
      </Panel>
    </form>
  );
}

// ---------------------------------------------------------------------------

function AccountSettings() {
  const { viewer, refresh } = useSession();
  const [username, setUsername] = useState(viewer?.username ?? '');
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });
  const [pwError, setPwError] = useState<ApiRequestError | null>(null);
  const [pwMessage, setPwMessage] = useState<string | null>(null);

  async function changeUsername(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.post('/api/v1/user/username', { username });
      await refresh();
      setMessage({ tone: 'success', text: 'Benutzername geändert.' });
    } catch (err) {
      setMessage({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'Änderung fehlgeschlagen.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setPwError(null);
    setPwMessage(null);
    try {
      await api.post('/api/v1/auth/password/change', passwords);
      setPasswords({ currentPassword: '', newPassword: '' });
      setPwMessage('Passwort geändert. Alle anderen Sitzungen wurden beendet.');
    } catch (err) {
      if (err instanceof ApiRequestError) setPwError(err);
      else throw err;
    }
  }

  return (
    <div className="space-y-4">
      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      <form onSubmit={changeUsername}>
        <Panel title="Benutzername" bodyClassName="space-y-4 p-5">
          <Alert tone="warning">
            Nach einer Änderung zeigen bestehende Links und Git-Remotes auf den alten Namen ins
            Leere. Passe deine Remotes anschließend an.
          </Alert>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} required />
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={username === viewer?.username}
          >
            Benutzernamen ändern
          </Button>
        </Panel>
      </form>

      <form onSubmit={changePassword}>
        <Panel title="Passwort ändern" bodyClassName="space-y-4 p-5">
          {pwMessage && <Alert tone="success">{pwMessage}</Alert>}
          {pwError && !Object.keys(pwError.fieldErrors).length && (
            <Alert tone="danger">{pwError.message}</Alert>
          )}
          <Input
            label="Aktuelles Passwort"
            type="password"
            autoComplete="current-password"
            value={passwords.currentPassword}
            onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })}
            error={pwError?.fieldError('currentPassword')}
            required
          />
          <Input
            label="Neues Passwort"
            type="password"
            autoComplete="new-password"
            value={passwords.newPassword}
            onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })}
            error={pwError?.fieldError('newPassword')}
            hint="Mindestens 10 Zeichen."
            required
          />
          <Button type="submit" variant="primary">
            Passwort ändern
          </Button>
        </Panel>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SessionSettings() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api
      .get<{ items: SessionInfo[] }>('/api/v1/auth/sessions')
      .then((d) => setSessions(d.items))
      .catch(() => setSessions([]));
  }, [version]);

  async function revoke(id: string) {
    await api.delete(`/api/v1/auth/sessions/${id}`);
    setVersion((v) => v + 1);
  }

  async function revokeOthers() {
    await api.post('/api/v1/auth/sessions/revoke-others');
    setVersion((v) => v + 1);
  }

  if (!sessions) return <Spin />;

  return (
    <Panel
      title="Aktive Sitzungen"
      actions={
        sessions.length > 1 && (
          <Button size="sm" variant="danger" onClick={revokeOthers}>
            Alle anderen beenden
          </Button>
        )
      }
      bodyClassName="divide-y divide-line"
    >
      {sessions.map((session) => (
        <div key={session.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-medium">
              {describeUserAgent(session.userAgent)}
              {session.isCurrent && <Badge tone="accent">aktuelle Sitzung</Badge>}
            </p>
            <p className="mt-0.5 text-2xs text-faint">
              {session.ipAddress ?? 'unbekannte IP'} · zuletzt aktiv{' '}
              {relativeTime(session.lastSeenAt)} · angemeldet {relativeTime(session.createdAt)}
            </p>
          </div>
          {!session.isCurrent && (
            <Button size="sm" variant="danger" onClick={() => revoke(session.id)}>
              Beenden
            </Button>
          )}
        </div>
      ))}
    </Panel>
  );
}

/** Macht einen User-Agent-String lesbar, ohne eine Bibliothek dafür zu laden. */
function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unbekanntes Gerät';
  const browser =
    /Firefox\/[\d.]+/.test(userAgent)
      ? 'Firefox'
      : /Edg\//.test(userAgent)
        ? 'Edge'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : /curl|git/i.test(userAgent)
              ? 'Kommandozeile'
              : 'Browser';

  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Mac OS X/.test(userAgent)
      ? 'macOS'
      : /Android/.test(userAgent)
        ? 'Android'
        : /iPhone|iPad/.test(userAgent)
          ? 'iOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : '';

  return os ? `${browser} auf ${os}` : browser;
}

// ---------------------------------------------------------------------------

interface TokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

function TokenSettings() {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ items: TokenRow[] }>('/api/v1/user/tokens')
      .then((d) => setTokens(d.items))
      .catch(() => setTokens([]));
  }, [version]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.post<{ token: string }>('/api/v1/user/tokens', { name });
      setCreated(result.token);
      setName('');
      setVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await api.delete(`/api/v1/user/tokens/${id}`);
    setVersion((v) => v + 1);
  }

  return (
    <div className="space-y-4">
      {created && (
        <Alert tone="success" title="Token erstellt – jetzt kopieren">
          <p className="mb-2">
            Dieser Wert wird nur einmal angezeigt. Verwende ihn als Passwort, wenn Git nach
            Zugangsdaten fragt.
          </p>
          <code className="block select-all break-all border border-line bg-canvas p-2 font-mono text-xs">
            {created}
          </code>
        </Alert>
      )}

      <form onSubmit={create}>
        <Panel title="Neues Zugriffstoken" bodyClassName="space-y-4 p-5">
          <p className="text-sm text-muted">
            Git über HTTPS verlangt ein Token statt deines Passworts. Benutzername beliebig,
            Passwort = Token.
          </p>
          <Input
            label="Bezeichnung"
            placeholder="Laptop, CI-Server, …"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Button type="submit" variant="primary" loading={busy}>
            Token erstellen
          </Button>
        </Panel>
      </form>

      <Panel title="Vorhandene Tokens" bodyClassName="divide-y divide-line">
        {!tokens ? (
          <Spin />
        ) : tokens.length === 0 ? (
          <EmptyState title="Noch keine Tokens" />
        ) : (
          tokens.map((token) => (
            <div key={token.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{token.name}</p>
                <p className="mt-0.5 text-2xs text-faint">
                  <code className="font-mono">{token.tokenPrefix}…</code> · erstellt{' '}
                  {relativeTime(token.createdAt)} · zuletzt benutzt{' '}
                  {token.lastUsedAt ? relativeTime(token.lastUsedAt) : 'nie'}
                </p>
              </div>
              <Button size="sm" variant="danger" onClick={() => revoke(token.id)}>
                Widerrufen
              </Button>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SecuritySettings() {
  const { viewer, refresh } = useSession();
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ secret: string; qrDataUrl: string }>(
        '/api/v1/user/two-factor/setup',
      );
      setSetup(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ recoveryCodes: string[] }>(
        '/api/v1/user/two-factor/confirm',
        { code },
      );
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
      setCode('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ungültiger Code.');
    } finally {
      setBusy(false);
    }
  }

  async function disable(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/v1/user/two-factor/disable', { password });
      setPassword('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      {recoveryCodes && (
        <Alert tone="warning" title="Wiederherstellungscodes – jetzt sichern">
          <p className="mb-2">
            Jeder Code funktioniert einmal, falls du keinen Zugriff auf deine App hast. Sie werden
            nicht erneut angezeigt.
          </p>
          <div className="grid grid-cols-2 gap-1 border border-line bg-canvas p-2 font-mono text-xs">
            {recoveryCodes.map((rc) => (
              <code key={rc} className="select-all">
                {rc}
              </code>
            ))}
          </div>
        </Alert>
      )}

      <Panel title="Zwei-Faktor-Authentifizierung" bodyClassName="space-y-4 p-5">
        {viewer?.twoFactorEnabled ? (
          <>
            <Alert tone="success">Zwei-Faktor-Authentifizierung ist aktiv.</Alert>
            <form onSubmit={disable} className="space-y-3">
              <Input
                label="Passwort zur Bestätigung"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Button type="submit" variant="danger" loading={busy}>
                Deaktivieren
              </Button>
            </form>
          </>
        ) : setup ? (
          <form onSubmit={confirm} className="space-y-4">
            <p className="text-sm text-muted">
              Scanne den Code mit deiner Authenticator-App und gib anschließend die sechsstellige
              Zahl ein.
            </p>
            <img
              src={setup.qrDataUrl}
              alt="QR-Code für die Authenticator-App"
              className="border border-line bg-white p-2"
              width={200}
              height={200}
            />
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">Code manuell eingeben</summary>
              <code className="mt-1 block select-all break-all font-mono">{setup.secret}</code>
            </details>
            <Input
              label="Code aus der App"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="font-mono tracking-widest"
              required
            />
            <Button type="submit" variant="primary" loading={busy}>
              Aktivieren
            </Button>
          </form>
        ) : (
          <>
            <p className="text-sm text-muted">
              Mit einem zweiten Faktor ist dein Konto auch dann geschützt, wenn dein Passwort
              bekannt wird.
            </p>
            <Button variant="primary" onClick={begin} loading={busy}>
              Einrichten
            </Button>
          </>
        )}
      </Panel>
    </div>
  );
}
