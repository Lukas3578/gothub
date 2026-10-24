/**
 * Routing der Anwendung.
 *
 * Die Reihenfolge ist wichtig: /:owner und /:owner/:repo stehen ganz unten,
 * damit feste Pfade wie /settings nicht als Benutzername interpretiert werden.
 * Zusätzlich verhindert die Liste reservierter Namen im Backend, dass jemand
 * einen Account anlegt, der eine Anwendungsroute verdeckt.
 */

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell.js';
import { SessionProvider, useSession } from './lib/session.js';
import { Spin } from './components/ui.js';
import {
  ForgotPasswordPage,
  LandingPage,
  LoginPage,
  RegisterPage,
  ResetPasswordPage,
} from './pages/auth.js';
import {
  DashboardPage,
  ExplorePage,
  NewRepositoryPage,
  ProfilePage,
} from './pages/dashboard.js';
import { RepositoryPage } from './pages/repository.js';
import {
  GistDetailPage,
  GistListPage,
  NewGistPage,
  PackagesPage,
} from './pages/extras.js';
import { SettingsPage } from './pages/settings.js';
import {
  AdminPage,
  NewOrganizationPage,
  NotificationsPage,
  OrganizationPage,
  SearchPage,
} from './pages/misc.js';

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Shell>
          <Routes>
            <Route path="/" element={<HomeRoute />} />
            <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
            <Route path="/register" element={<GuestOnly><RegisterPage /></GuestOnly>} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />

            <Route path="/dashboard" element={<RequireAuth><DashboardPage /></RequireAuth>} />
            <Route path="/new" element={<RequireAuth><NewRepositoryPage /></RequireAuth>} />
            <Route path="/explore" element={<ExplorePage />} />
            <Route path="/settings/*" element={<RequireAuth><SettingsPage /></RequireAuth>} />
            <Route path="/search" element={<SearchPage />} />
            <Route
              path="/notifications"
              element={<RequireAuth><NotificationsPage /></RequireAuth>}
            />
            <Route
              path="/organizations/new"
              element={<RequireAuth><NewOrganizationPage /></RequireAuth>}
            />
            <Route path="/organizations/:org" element={<OrganizationPage />} />
            <Route path="/admin/*" element={<RequireAdmin><AdminPage /></RequireAdmin>} />

            <Route path="/gists" element={<GistListPage />} />
            <Route path="/gists/new" element={<RequireAuth><NewGistPage /></RequireAuth>} />
            <Route path="/gists/:id" element={<GistDetailPage />} />

            <Route path="/:owner/:repo/*" element={<RepositoryPage />} />
            <Route path="/:owner/-/gists" element={<GistListPage />} />
            <Route path="/:owner/-/packages" element={<PackagesPage />} />
            <Route path="/:owner" element={<ProfilePage />} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      </SessionProvider>
    </BrowserRouter>
  );
}

/** Angemeldete Benutzer sehen statt der Landingpage ihr Dashboard. */
function HomeRoute() {
  const { viewer, loading } = useSession();
  if (loading) return <Spin />;
  return viewer ? <Navigate to="/dashboard" replace /> : <LandingPage />;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { viewer, loading } = useSession();
  if (loading) return <Spin />;
  if (!viewer) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Nur für Plattform-Administratoren. */
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { viewer, loading } = useSession();
  if (loading) return <Spin />;
  if (!viewer) return <Navigate to="/login" replace />;
  if (!viewer.isAdmin) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function GuestOnly({ children }: { children: React.ReactNode }) {
  const { viewer, loading } = useSession();
  if (loading) return <Spin />;
  if (viewer) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
