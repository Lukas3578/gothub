/**
 * Sitzungskontext und Theme-Verwaltung.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Viewer } from '@forge/shared';
import { api } from './api.js';

interface SessionValue {
  viewer: Viewer | null;
  loading: boolean;
  /** Lädt den angemeldeten Benutzer neu, etwa nach einer Profiländerung. */
  refresh: () => Promise<void>;
  setViewer: (viewer: Viewer | null) => void;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await api.get<{ viewer: Viewer | null }>('/api/v1/auth/me');
      setViewer(result.viewer);
    } catch {
      // Ein fehlgeschlagener Aufruf bedeutet hier: nicht angemeldet.
      setViewer(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await api.post('/api/v1/auth/logout').catch(() => {});
    setViewer(null);
  }, []);

  const value = useMemo(
    () => ({ viewer, loading, refresh, setViewer, logout }),
    [viewer, loading, refresh, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession muss innerhalb von SessionProvider verwendet werden.');
  return context;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export type Theme = 'dark' | 'light';

const THEME_KEY = 'forge.theme';

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    // Ohne gespeicherte Wahl der Systemeinstellung folgen.
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  return [theme, setThemeState];
}
