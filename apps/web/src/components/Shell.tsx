/**
 * Anwendungsrahmen: Kopfleiste, Navigation, Benutzermenü.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { Button, cx } from './ui.js';
import { useSession, useTheme } from '../lib/session.js';
import { BASE_URL, api } from '../lib/api.js';

export function ForgeMark({ className = 'h-5 w-5' }: { className?: string }) {
  // Eigenes Zeichen: ein Amboss, reduziert auf wenige gerade Flächen.
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M3 7h7l2 3h7v3h-4l-2 3H9l1 3h4v2H6v-2h2l-1-3H4a1 1 0 0 1-1-1V7z" fill="currentColor" />
    </svg>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { viewer, logout } = useSession();
  const [theme, setTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Menü schließen, wenn daneben geklickt oder Escape gedrückt wird.
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="page flex h-12 items-center gap-4">
          <Link
            to={viewer ? '/dashboard' : '/'}
            className="flex shrink-0 items-center gap-2 font-semibold tracking-tight text-ink"
          >
            <span className="text-accent">
              <ForgeMark />
            </span>
            Forge
          </Link>

          {viewer && (
            <nav className="hidden items-center gap-1 md:flex">
              <HeaderLink to="/dashboard">Übersicht</HeaderLink>
              <HeaderLink to="/explore">Entdecken</HeaderLink>
            </nav>
          )}

          <div className="flex-1" />

          <SearchBox />

          {viewer && <NotificationBell />}

          <button
            type="button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="flex h-7 w-7 items-center justify-center border border-line-strong text-muted hover:bg-raised hover:text-ink"
            title={theme === 'dark' ? 'Helles Theme' : 'Dunkles Theme'}
            aria-label="Theme wechseln"
          >
            {theme === 'dark' ? (
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
                <circle cx="8" cy="8" r="3.2" />
                <path d="M8 0v2.2M8 13.8V16M0 8h2.2M13.8 8H16M2.3 2.3l1.6 1.6M12.1 12.1l1.6 1.6M13.7 2.3l-1.6 1.6M3.9 12.1l-1.6 1.6" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
                <path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" />
              </svg>
            )}
          </button>

          {viewer ? (
            <>
              <Link
                to="/new"
                className="flex h-7 items-center gap-1.5 border border-line-strong bg-raised px-2.5 text-2xs font-medium text-ink hover:bg-line/60"
              >
                <span className="text-base leading-none">+</span>
                Neu
              </Link>

              <div className="relative" ref={menuRef}>
                <button
                  type="button"
                  onClick={() => setMenuOpen((open) => !open)}
                  className="flex h-7 items-center gap-2 border border-line-strong px-2 text-2xs font-medium hover:bg-raised"
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                >
                  <Avatar name={viewer.username} size={16} />
                  <span className="hidden sm:inline">{viewer.username}</span>
                </button>

                {menuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 top-9 z-40 w-52 border border-line bg-surface py-1 shadow-lg"
                  >
                    <MenuLink to={`/${viewer.username}`} onClick={() => setMenuOpen(false)}>
                      Dein Profil
                    </MenuLink>
                    <MenuLink to="/settings/profile" onClick={() => setMenuOpen(false)}>
                      Einstellungen
                    </MenuLink>
                    <MenuLink to="/settings/tokens" onClick={() => setMenuOpen(false)}>
                      Zugriffstokens
                    </MenuLink>
                    {viewer.isAdmin && (
                      <MenuLink to="/admin" onClick={() => setMenuOpen(false)}>
                        Administration
                      </MenuLink>
                    )}
                    <div className="my-1 border-t border-line" />
                    <button
                      type="button"
                      role="menuitem"
                      onClick={async () => {
                        setMenuOpen(false);
                        await logout();
                        navigate('/');
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-muted hover:bg-raised hover:text-ink"
                    >
                      Abmelden
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Link to="/login" className="text-xs text-muted hover:text-ink">
                Anmelden
              </Link>
              <Button size="sm" variant="primary" onClick={() => navigate('/register')}>
                Registrieren
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-line bg-surface">
        <div className="page flex flex-wrap items-center gap-x-5 gap-y-2 py-4 text-2xs text-faint">
          <span className="font-medium text-muted">Forge 0.1.0</span>
          <Link to="/explore" className="hover:text-ink">
            Repositories
          </Link>
          <span>Selbst gehostete Entwicklerplattform</span>
        </div>
      </footer>
    </div>
  );
}

function HeaderLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx(
          'px-2 py-1 text-xs font-medium transition-colors',
          isActive ? 'text-ink' : 'text-muted hover:text-ink',
        )
      }
    >
      {children}
    </NavLink>
  );
}

function MenuLink({
  to,
  onClick,
  children,
}: {
  to: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      role="menuitem"
      onClick={onClick}
      className="block px-3 py-1.5 text-xs text-muted hover:bg-raised hover:text-ink"
    >
      {children}
    </Link>
  );
}

/**
 * Platzhalter-Avatar: Initiale auf einer aus dem Namen abgeleiteten Farbe.
 * Stabil ohne gespeicherte Bilddatei.
 */
export function Avatar({
  name,
  size = 20,
  url,
}: {
  name: string;
  size?: number;
  url?: string | null;
}) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        className="shrink-0 border border-line object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;

  /*
   * Zwölf feste Stufen statt 360 freier Farbtöne, und deutlich blasser.
   *
   * Vorher: `hsl(hash % 360, 42%, 38%)`. Bei 42 % Sättigung und freiem
   * Farbton stand neben dem warmen Akzent der Oberfläche regelmäßig ein
   * kräftiges Indigo oder Magenta – zwei Farbwelten auf derselben Seite.
   *
   * Ein Avatar muss Namen unterscheidbar machen, nicht um Aufmerksamkeit
   * werben. Bei 24 % Sättigung bleiben die Marken unterscheidbar, ordnen
   * sich aber dem Akzent unter. Die feste Stufung verhindert außerdem, dass
   * zwei Namen in fast derselben Farbe landen.
   */
  const hue = (hash % 12) * 30;

  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 select-none items-center justify-center font-semibold uppercase text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.5,
        background: `hsl(${hue} 24% 34%)`,
      }}
    >
      {name.charAt(0)}
    </span>
  );
}

/** Suchfeld in der Kopfleiste. */
function SearchBox() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    navigate(`/search?q=${encodeURIComponent(query)}`);
    setQuery('');
  }

  return (
    <form onSubmit={submit} className="hidden sm:block">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Suchen…"
        aria-label="Suche"
        className="h-7 w-44 border border-line-strong bg-canvas px-2 text-2xs text-ink placeholder:text-faint focus:w-64 focus:border-accent focus:outline-none"
      />
    </form>
  );
}

/**
 * Benachrichtigungsglocke mit Live-Zähler.
 *
 * Der Zähler kommt über einen Server-Sent-Events-Strom. Bricht die Verbindung
 * ab, stellt der Browser sie selbst wieder her; zusätzlich wird beim Laden
 * einmal abgefragt, damit die Zahl auch ohne Strom stimmt.
 */
function NotificationBell() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let source: EventSource | null = null;

    api
      .get<{ unreadCount: number }>('/api/v1/notifications/count')
      .then((data) => setCount(data.unreadCount))
      .catch(() => {});

    try {
      source = new EventSource(`${BASE_URL}/api/v1/notifications/stream`, {
        withCredentials: true,
      });

      const onMessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data) as { unreadCount?: number };
          if (typeof data.unreadCount === 'number') setCount(data.unreadCount);
        } catch {
          // Unverständliche Nachricht wird übergangen.
        }
      };

      source.addEventListener('ready', onMessage);
      source.addEventListener('update', onMessage);
    } catch {
      // Ohne Strom bleibt der beim Laden geholte Wert stehen.
    }

    return () => source?.close();
  }, []);

  return (
    <Link
      to="/notifications"
      className="relative flex h-7 w-7 items-center justify-center border border-line-strong text-muted hover:bg-raised hover:text-ink"
      aria-label={`Benachrichtigungen${count > 0 ? ` (${count} ungelesen)` : ''}`}
      title="Benachrichtigungen"
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
        <path d="M8 1.5a4 4 0 0 0-4 4v2.3L2.6 10.4a.6.6 0 0 0 .5.9h9.8a.6.6 0 0 0 .5-.9L12 7.8V5.5a4 4 0 0 0-4-4zM6.3 12.3a1.8 1.8 0 0 0 3.4 0z" />
      </svg>
      {count > 0 && (
        <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center border border-canvas bg-accent px-1 text-[0.6rem] font-semibold text-accent-ink">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}
