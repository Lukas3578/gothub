/**
 * Landingpage, Anmeldung und Registrierung.
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Viewer } from '@forge/shared';
import { ApiRequestError, api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Alert, Button, Input, Panel } from '../components/ui.js';
import { ForgeMark } from '../components/Shell.js';

// ---------------------------------------------------------------------------
// Landingpage
// ---------------------------------------------------------------------------

export function LandingPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-4">
      <section className="border-b border-line py-20">
        <div className="max-w-3xl">
          <p className="mb-5 inline-flex items-center gap-2 border border-line px-2.5 py-1 text-2xs uppercase tracking-widest text-muted">
            <span className="text-accent">
              <ForgeMark className="h-3.5 w-3.5" />
            </span>
            Selbst gehostet
          </p>
          <h1 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            Deine Repositories.
            <br />
            <span className="text-accent">Dein Server.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted">
            Forge ist eine Entwicklerplattform, die du selbst betreibst: echte Git-Repositories
            über HTTPS, Issues, Pull Requests und eine CI, die auf deiner eigenen Hardware läuft.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/register"
              className="inline-flex h-10 items-center border border-accent bg-accent px-5 text-sm font-medium text-accent-ink hover:bg-accent/90"
            >
              Konto erstellen
            </Link>
            <Link
              to="/explore"
              className="inline-flex h-10 items-center border border-line-strong bg-raised px-5 text-sm font-medium hover:bg-line/60"
            >
              Repositories ansehen
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-px border-b border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            title: 'Echtes Git',
            body: 'Klonen, pushen und fetchen über HTTPS. Kein nachgebautes Protokoll, sondern git selbst auf dem Server.',
          },
          {
            title: 'Klare Rechte',
            body: 'Benutzer, Organisationen, Teams und Kollaborateure – mit einer Zugriffsprüfung, die an einer Stelle liegt.',
          },
          {
            title: 'Eigene CI',
            body: 'Workflows als YAML, ausgeführt von Runnern in isolierten Containern auf deiner Infrastruktur.',
          },
          {
            title: 'Deine Daten',
            body: 'PostgreSQL, Dateisystem, fertig. Keine Abhängigkeit von einem fremden Anbieter.',
          },
        ].map((item) => (
          <div key={item.title} className="bg-canvas p-6">
            <h2 className="text-sm font-semibold">{item.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
          </div>
        ))}
      </section>

      <section className="py-14">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted">
          In zwei Befehlen loslegen
        </h2>
        <pre className="mt-4 max-w-2xl overflow-x-auto border border-line bg-surface p-4 font-mono text-[0.8125rem] leading-relaxed text-muted">
          <code>
            <span className="text-faint">$</span> git remote add origin
            http://localhost:4000/git/<span className="text-accent">dein-name</span>/projekt.git
            {'\n'}
            <span className="text-faint">$</span> git push -u origin main
          </code>
        </pre>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------------

export function LoginPage() {
  const navigate = useNavigate();
  const { setViewer } = useSession();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (challengeToken) {
        const result = await api.post<{ viewer: Viewer }>('/api/v1/auth/login/two-factor', {
          challengeToken,
          code,
        });
        setViewer(result.viewer);
        navigate('/dashboard');
        return;
      }

      const result = await api.post<{
        status: 'ok' | 'two_factor_required';
        viewer?: Viewer;
        challengeToken?: string;
      }>('/api/v1/auth/login', { identifier, password });

      if (result.status === 'two_factor_required') {
        setChallengeToken(result.challengeToken ?? null);
        return;
      }

      setViewer(result.viewer!);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err : null);
      if (!(err instanceof ApiRequestError)) throw err;
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title={challengeToken ? 'Bestätigungscode' : 'Anmelden'}>
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <Alert tone="danger">{error.message}</Alert>}

        {challengeToken ? (
          <>
            <p className="text-sm text-muted">
              Gib den sechsstelligen Code aus deiner Authenticator-App ein. Ein
              Wiederherstellungscode funktioniert ebenfalls.
            </p>
            <Input
              label="Code"
              name="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              className="font-mono tracking-widest"
              autoFocus
              required
            />
          </>
        ) : (
          <>
            <Input
              label="Benutzername oder E-Mail"
              name="identifier"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
            <Input
              label="Passwort"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </>
        )}

        <Button type="submit" variant="primary" loading={busy} className="w-full">
          {challengeToken ? 'Bestätigen' : 'Anmelden'}
        </Button>

        {!challengeToken && (
          <div className="flex justify-between text-xs">
            <Link to="/forgot-password" className="text-muted hover:text-ink">
              Passwort vergessen?
            </Link>
            <Link to="/register" className="text-muted hover:text-ink">
              Konto erstellen
            </Link>
          </div>
        )}
      </form>
    </AuthFrame>
  );
}

// ---------------------------------------------------------------------------
// Registrierung
// ---------------------------------------------------------------------------

export function RegisterPage() {
  const navigate = useNavigate();
  const { setViewer } = useSession();

  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await api.post<{ viewer: Viewer }>('/api/v1/auth/register', form);
      setViewer(result.viewer);
      navigate('/dashboard');
    } catch (err) {
      if (err instanceof ApiRequestError) setError(err);
      else throw err;
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Konto erstellen">
      <form onSubmit={onSubmit} className="space-y-4">
        {error && !Object.keys(error.fieldErrors).length && (
          <Alert tone="danger">{error.message}</Alert>
        )}

        <Input
          label="Benutzername"
          name="username"
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          error={error?.fieldError('username')}
          hint="Buchstaben, Ziffern, Bindestrich und Unterstrich."
          autoComplete="username"
          autoFocus
          required
        />
        <Input
          label="E-Mail"
          name="email"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          error={error?.fieldError('email')}
          autoComplete="email"
          required
        />
        <Input
          label="Passwort"
          name="password"
          type="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          error={error?.fieldError('password')}
          hint="Mindestens 10 Zeichen."
          autoComplete="new-password"
          required
        />

        <Button type="submit" variant="primary" loading={busy} className="w-full">
          Konto erstellen
        </Button>

        <p className="text-center text-xs text-muted">
          Schon registriert?{' '}
          <Link to="/login" className="link">
            Anmelden
          </Link>
        </p>
      </form>
    </AuthFrame>
  );
}

// ---------------------------------------------------------------------------
// Passwort vergessen / zurücksetzen
// ---------------------------------------------------------------------------

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    await api.post('/api/v1/auth/password/forgot', { email }).catch(() => {});
    setSent(true);
    setBusy(false);
  }

  return (
    <AuthFrame title="Passwort zurücksetzen">
      {sent ? (
        <Alert tone="success" title="E-Mail unterwegs">
          Falls ein Konto mit dieser Adresse existiert, haben wir einen Link zum Zurücksetzen
          verschickt. Er ist eine Stunde gültig.
        </Alert>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <p className="text-sm text-muted">
            Gib deine E-Mail-Adresse ein. Wir senden dir einen Link zum Zurücksetzen.
          </p>
          <Input
            label="E-Mail"
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
          <Button type="submit" variant="primary" loading={busy} className="w-full">
            Link anfordern
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/v1/auth/password/reset', { token, password });
      navigate('/login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Neues Passwort setzen">
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {!token && <Alert tone="warning">Im Link fehlt der Token.</Alert>}
        <Input
          label="Neues Passwort"
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="Mindestens 10 Zeichen. Alle anderen Sitzungen werden beendet."
          autoComplete="new-password"
          required
        />
        <Button type="submit" variant="primary" loading={busy} className="w-full" disabled={!token}>
          Passwort setzen
        </Button>
      </form>
    </AuthFrame>
  );
}

// ---------------------------------------------------------------------------

function AuthFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col justify-center px-4 py-16">
      <h1 className="mb-6 text-center text-xl font-semibold">{title}</h1>
      <Panel bodyClassName="p-6">{children}</Panel>
    </div>
  );
}
