/**
 * Rendering-Tests für die Oberfläche.
 *
 * Diese Tests ersetzen keinen Durchklick im echten Browser, schließen aber die
 * größte Lücke: sie montieren die Seiten tatsächlich, führen die Effekte aus
 * und schlagen fehl, wenn eine Komponente beim Rendern abstürzt, ein Hook
 * falsch verwendet wird oder ein Import ins Leere zeigt.
 *
 * Die API wird dabei durch feste Antworten ersetzt, damit die Tests ohne
 * laufenden Server auskommen und immer dasselbe prüfen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { RepositoryDetail, Viewer } from '@forge/shared';
import { SessionProvider } from '../lib/session.js';
import { Shell } from '../components/Shell.js';
import { LandingPage, LoginPage, RegisterPage } from '../pages/auth.js';
import { DashboardPage, ExplorePage, NewRepositoryPage } from '../pages/dashboard.js';
import { IssueDetailPage, IssueListPage, NewIssuePage } from '../pages/issues.js';
import { PullListPage } from '../pages/pulls.js';
import { ActionsPage } from '../pages/actions.js';
import { ReleasesPage, NotificationsPage, SearchPage } from '../pages/misc.js';
import { Markdown } from '../pages/repository.js';
import {
  GistDetailPage,
  GistListPage,
  NewGistPage,
  PackagesPage,
  ProjectBoardPage,
  ProjectListPage,
  SshKeysSettings,
  WikiPage,
} from '../pages/extras.js';

// ---------------------------------------------------------------------------
// Testdaten
// ---------------------------------------------------------------------------

const VIEWER: Viewer = {
  id: 'u1',
  username: 'testerin',
  displayName: 'Testerin',
  avatarUrl: null,
  email: 'testerin@example.test',
  emailVerified: true,
  isAdmin: false,
  twoFactorEnabled: false,
};

const REPO: RepositoryDetail = {
  id: 'r1',
  ownerType: 'user',
  ownerName: 'testerin',
  name: 'projekt',
  fullName: 'testerin/projekt',
  description: 'Ein Testprojekt',
  visibility: 'public',
  isArchived: false,
  isFork: false,
  isEmpty: false,
  defaultBranch: 'main',
  primaryLanguage: 'TypeScript',
  topics: ['test'],
  starCount: 3,
  forkCount: 1,
  watcherCount: 2,
  openIssueCount: 1,
  sizeBytes: 2048,
  pushedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  hasIssues: true,
  hasPullRequests: true,
  hasWiki: true,
  hasActions: true,
  hasReleases: true,
  viewerAccess: 'admin',
  viewerHasStarred: false,
  viewerIsWatching: true,
  parent: null,
  cloneUrlHttp: 'http://localhost:4000/git/testerin/projekt.git',
};

/**
 * Antworten je Endpunkt. Der Schlüssel ist ein Teilstring des Pfads; die
 * erste Übereinstimmung gewinnt, deshalb stehen spezifische Pfade oben.
 */
const RESPONSES: [string, unknown][] = [
  ['/api/v1/auth/me', { viewer: VIEWER }],
  ['/api/v1/notifications/count', { unreadCount: 2 }],
  [
    '/api/v1/notifications',
    {
      items: [
        {
          id: 'n1',
          subjectType: 'issue',
          subjectId: 'i1',
          reason: 'mention',
          title: 'testerin/projekt#1: Du wurdest erwähnt',
          targetPath: '/testerin/projekt/issues/1',
          repositoryFullName: 'testerin/projekt',
          actor: null,
          readAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
      unreadCount: 1,
      totalCount: 1,
    },
  ],
  [
    '/api/v1/dashboard',
    {
      ownRepositories: [REPO],
      watchedRepositories: [],
      organizations: [],
      counts: { openIssues: 1, openPullRequests: 0, repositories: 1 },
      activity: [
        {
          id: 'a1',
          type: 'push',
          repositoryFullName: 'testerin/projekt',
          refName: 'main',
          commitCount: 2,
          createdAt: new Date().toISOString(),
        },
      ],
    },
  ],
  [
    '/wiki/pages/',
    {
      slug: 'Startseite',
      title: 'Startseite',
      content: '# Startseite\n\nWillkommen im Wiki.',
      sizeBytes: 40,
      updatedAt: new Date().toISOString(),
      lastCommit: null,
      currentOid: 'a'.repeat(40),
      viewerCanEdit: true,
    },
  ],
  [
    '/wiki/pages',
    {
      items: [
        {
          slug: 'Startseite',
          title: 'Startseite',
          path: 'Startseite.md',
          sizeBytes: 40,
          updatedAt: new Date().toISOString(),
          lastCommit: null,
        },
      ],
      currentOid: 'a'.repeat(40),
      viewerCanEdit: true,
    },
  ],
  [
    '/projects/1',
    {
      id: 'b1',
      number: 1,
      name: 'Fahrplan',
      description: 'Was ansteht',
      isClosed: false,
      viewerCanEdit: true,
      columns: [
        {
          id: 'c1',
          name: 'Offen',
          position: 1000,
          isDoneColumn: false,
          cards: [
            { id: 'k1', note: 'Dokumentation schreiben', position: 1000, issue: null },
            {
              id: 'k2',
              note: null,
              position: 2000,
              issue: { id: 'i1', number: 1, title: 'Fehler im Login', state: 'open', kind: 'issue' },
            },
          ],
        },
        { id: 'c2', name: 'Erledigt', position: 2000, isDoneColumn: true, cards: [] },
      ],
    },
  ],
  [
    '/projects',
    {
      items: [
        { id: 'b1', number: 1, name: 'Fahrplan', description: 'Was ansteht', cardCount: 2 },
      ],
      viewerCanEdit: true,
    },
  ],
  [
    '/api/v1/gists/g1',
    {
      id: 'g1',
      description: 'Ein Schnipsel',
      isPublic: true,
      owner: { id: 'u1', username: 'testerin', displayName: null, avatarUrl: null },
      primaryFilename: 'hallo.ts',
      primaryLanguage: 'TypeScript',
      fileCount: 1,
      starCount: 2,
      viewerHasStarred: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cloneUrl: 'http://localhost:4000/git/gists/g1.git',
      viewerCanEdit: true,
      files: [
        { filename: 'hallo.ts', content: 'export const x = 1;', language: 'TypeScript', sizeBytes: 20 },
      ],
    },
  ],
  [
    '/api/v1/gists',
    {
      items: [
        {
          id: 'g1',
          description: 'Ein Schnipsel',
          isPublic: true,
          owner: { id: 'u1', username: 'testerin', displayName: null, avatarUrl: null },
          primaryFilename: 'hallo.ts',
          primaryLanguage: 'TypeScript',
          fileCount: 1,
          starCount: 2,
          viewerHasStarred: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          cloneUrl: 'http://localhost:4000/git/gists/g1.git',
        },
      ],
      totalCount: 1,
    },
  ],
  [
    '/api/v1/user/ssh-keys',
    {
      items: [
        {
          id: 'k1',
          title: 'Laptop',
          fingerprint: 'SHA256:abcdef',
          type: 'ssh-ed25519',
          bits: 256,
          lastUsedAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
      sshEnabled: true,
    },
  ],
  [
    '/packages',
    {
      items: [
        {
          id: 'p1',
          format: 'npm',
          name: '@testerin/demo',
          description: 'Ein Paket',
          visibility: 'public',
          installCommand: 'npm install @testerin/demo --registry http://localhost:4000/npm',
          versions: [
            { version: '1.0.0', createdAt: new Date().toISOString(), downloadCount: 5, sizeBytes: 512 },
          ],
        },
      ],
    },
  ],
  ['/labels', { items: [{ id: 'l1', name: 'bug', color: 'd73a4a', description: null }] }],
  ['/milestones', { items: [] }],
  [
    '/issues/1',
    {
      issue: {
        ...issueSummary(),
        body: 'Eine **Beschreibung** mit Markdown.',
        reactions: [{ content: '+1', count: 2, viewerReacted: false }],
        viewerCanEdit: true,
        viewerCanClose: true,
        repositoryFullName: 'testerin/projekt',
      },
      timeline: [
        {
          type: 'comment',
          at: new Date().toISOString(),
          comment: {
            id: 'c1',
            author: { id: 'u1', username: 'testerin', displayName: null, avatarUrl: null },
            body: 'Ein Kommentar.',
            reactions: [],
            viewerCanEdit: true,
            editedAt: null,
            createdAt: new Date().toISOString(),
          },
        },
        {
          type: 'event',
          at: new Date().toISOString(),
          event: {
            id: 'e1',
            actor: { id: 'u1', username: 'testerin', displayName: null, avatarUrl: null },
            eventType: 'labeled',
            data: {},
            createdAt: new Date().toISOString(),
          },
        },
      ],
      links: [],
    },
  ],
  ['/issues', { items: [issueSummary()], totalCount: 1, openCount: 1, closedCount: 0 }],
  ['/pulls', { items: [], totalCount: 0, openCount: 0, closedCount: 0 }],
  [
    '/workflows',
    {
      items: [
        {
          id: 'w1',
          name: 'Build',
          path: '.forge/workflows/build.yml',
          isEnabled: true,
          parseError: null,
          lastRun: null,
        },
      ],
    },
  ],
  [
    '/actions/runs',
    {
      items: [
        {
          id: 'run1',
          runNumber: 1,
          runAttempt: 1,
          workflowName: 'Build',
          event: 'push',
          status: 'success',
          headBranch: 'main',
          headSha: 'abc1234567890abc1234567890abc1234567890a',
          triggeredBy: null,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          durationMs: 4200,
        },
      ],
      totalCount: 1,
    },
  ],
  [
    '/releases',
    {
      items: [
        {
          id: 'rel1',
          tagName: 'v1.0.0',
          name: 'Erste Version',
          body: 'Startschuss.',
          isDraft: false,
          isPrerelease: false,
          author: null,
          assets: [],
          publishedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ],
    },
  ],
  ['/api/v1/search', { type: 'repositories', totalCount: 1, items: [REPO] }],
  ['/api/v1/repositories', { items: [REPO], page: 1, perPage: 30, totalCount: 1, hasNextPage: false }],
  ['/api/v1/meta', { brand: { name: 'Forge', tagline: '' }, allowRegistration: true }],
];

function issueSummary() {
  return {
    id: 'i1',
    number: 1,
    kind: 'issue' as const,
    title: 'Ein gemeldetes Problem',
    state: 'open' as const,
    closeReason: null,
    author: { id: 'u1', username: 'testerin', displayName: null, avatarUrl: null },
    labels: [{ id: 'l1', name: 'bug', color: 'd73a4a', description: null }],
    assignees: [],
    milestone: null,
    commentCount: 1,
    isLocked: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    pullRequest: null,
  };
}

// ---------------------------------------------------------------------------
// Aufbau
// ---------------------------------------------------------------------------

/** Sammelt Konsolenfehler, damit React-Warnungen den Test rot machen. */
let consoleErrors: string[] = [];

beforeEach(() => {
  consoleErrors = [];

  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const match = RESPONSES.find(([key]) => url.includes(key));

      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => match?.[1] ?? {},
        text: async () => JSON.stringify(match?.[1] ?? {}),
      } as Response;
    }),
  );

  // EventSource gibt es in jsdom nicht; die Glocke darf daran nicht scheitern.
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener() {}
      close() {}
    },
  );

  // matchMedia wird für die Theme-Erkennung gebraucht.
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(ui: React.ReactNode, route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <SessionProvider>{ui}</SessionProvider>
    </MemoryRouter>,
  );
}

/** Prüft, dass beim Rendern keine React-Fehler aufgetreten sind. */
function expectNoReactErrors() {
  const relevant = consoleErrors.filter(
    (message) => !message.includes('not wrapped in act') && !message.includes('React Router Future'),
  );
  expect(relevant, `React-Fehler: ${relevant.join(' | ')}`).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Seiten rendern ohne Absturz', () => {
  it('Landingpage zeigt den Einstieg', async () => {
    mount(<LandingPage />);
    expect(await screen.findByText(/Deine Repositories/i)).toBeTruthy();
    expectNoReactErrors();
  });

  it('Anmeldeseite zeigt die Felder', async () => {
    mount(<LoginPage />);
    expect(await screen.findByLabelText(/Benutzername oder E-Mail/i)).toBeTruthy();
    expect(screen.getByLabelText(/^Passwort/i)).toBeTruthy();
    expectNoReactErrors();
  });

  it('Registrierung zeigt alle Pflichtfelder', async () => {
    mount(<RegisterPage />);
    expect(await screen.findByLabelText(/Benutzername/i)).toBeTruthy();
    expect(screen.getByLabelText(/E-Mail/i)).toBeTruthy();
    expectNoReactErrors();
  });

  it('Dashboard zeigt eigene Repositories und Aktivität', async () => {
    mount(<DashboardPage />);
    expect(await screen.findByText('projekt')).toBeTruthy();
    expect(await screen.findByText(/2 Commits/)).toBeTruthy();
    expectNoReactErrors();
  });

  it('Entdecken-Seite listet Repositories', async () => {
    mount(<ExplorePage />);
    expect(await screen.findByText('testerin/projekt')).toBeTruthy();
    expectNoReactErrors();
  });

  it('Repository-Anlage zeigt die Sichtbarkeitsoptionen', async () => {
    mount(<NewRepositoryPage />);
    expect(await screen.findByText('Privat')).toBeTruthy();
    expect(screen.getByText('Öffentlich')).toBeTruthy();
    expectNoReactErrors();
  });

  it('Issue-Liste zeigt Titel und Label', async () => {
    mount(<IssueListPage repo={REPO} />);
    expect(await screen.findByText('Ein gemeldetes Problem')).toBeTruthy();
    expect(await screen.findAllByText('bug')).toBeTruthy();
    expectNoReactErrors();
  });

  it('Issue-Detail zeigt Text, Kommentar und Verlauf', async () => {
    mount(
      <Routes>
        <Route path="/:number" element={<IssueDetailPage repo={REPO} />} />
      </Routes>,
      '/1',
    );

    expect(await screen.findByText('Ein Kommentar.')).toBeTruthy();
    // Markdown muss gerendert werden, nicht als Rohtext erscheinen.
    expect(await screen.findByText('Beschreibung')).toBeTruthy();
    expect(await screen.findByText(/hat die Labels geändert/)).toBeTruthy();
    expectNoReactErrors();
  });

  it('Neues Issue zeigt Editor mit Vorschau', async () => {
    mount(<NewIssuePage repo={REPO} />);
    expect(await screen.findByText('Vorschau')).toBeTruthy();
    expectNoReactErrors();
  });

  it('Pull-Request-Liste rendert auch ohne Einträge', async () => {
    mount(<PullListPage repo={REPO} />);
    expect(await screen.findByText(/Keine Pull Requests/)).toBeTruthy();
    expectNoReactErrors();
  });

  it('Actions zeigt Workflows und Läufe', async () => {
    mount(<ActionsPage repo={REPO} />);
    // "Build" steht sowohl in der Workflow-Liste als auch beim Lauf.
    expect((await screen.findAllByText('Build')).length).toBeGreaterThan(0);
    expect(await screen.findByText(/Alle Läufe/)).toBeTruthy();
    expectNoReactErrors();
  });

  it('Releases zeigt die Version', async () => {
    mount(<ReleasesPage repo={REPO} />);
    expect(await screen.findByText('Erste Version')).toBeTruthy();
    expectNoReactErrors();
  });

  it('Benachrichtigungen zeigt ungelesene Einträge', async () => {
    mount(<NotificationsPage />);
    expect(await screen.findByText(/Du wurdest erwähnt/)).toBeTruthy();
    expectNoReactErrors();
  });

  it('Suche rendert die Reiter', async () => {
    mount(<SearchPage />, '/search?q=test');
    expect(await screen.findByText('Repositories')).toBeTruthy();
    expect(screen.getByText('Code')).toBeTruthy();
    expectNoReactErrors();
  });

  it('Wiki zeigt Seitenliste und gerenderte Seite', async () => {
    mount(<WikiPage repo={REPO} />, '/testerin/projekt/wiki?page=Startseite');
    expect(await screen.findByText('Willkommen im Wiki.')).toBeTruthy();
    expect(screen.getAllByText('Startseite').length).toBeGreaterThan(0);
    expectNoReactErrors();
  });

  it('Projektliste zeigt vorhandene Boards', async () => {
    mount(<ProjectListPage repo={REPO} />, '/testerin/projekt/projects');
    expect(await screen.findByText('Fahrplan')).toBeTruthy();
    expect(screen.getByText('2 Karten')).toBeTruthy();
    expectNoReactErrors();
  });

  it('Projektboard zeigt Spalten und Karten', async () => {
    mount(
      <Routes>
        <Route path="/:owner/:repo/projects/:number" element={<ProjectBoardPage repo={REPO} />} />
      </Routes>,
      '/testerin/projekt/projects/1',
    );
    expect(await screen.findByText('Dokumentation schreiben')).toBeTruthy();
    expect(screen.getByText('Fehler im Login')).toBeTruthy();
    expect(screen.getByText('Offen')).toBeTruthy();
    expectNoReactErrors();
  });

  it('Gist-Liste zeigt Dateiname und Sprache', async () => {
    mount(<GistListPage />, '/gists');
    expect(await screen.findByText('hallo.ts')).toBeTruthy();
    expect(screen.getByText('TypeScript')).toBeTruthy();
    expectNoReactErrors();
  });

  it('Gist-Detail zeigt den Inhalt und die Klon-Adresse', async () => {
    mount(
      <Routes>
        <Route path="/gists/:id" element={<GistDetailPage />} />
      </Routes>,
      '/gists/g1',
    );
    expect(await screen.findByText('export const x = 1;')).toBeTruthy();
    expect(
      screen.getByDisplayValue('http://localhost:4000/git/gists/g1.git'),
    ).toBeTruthy();
    expectNoReactErrors();
  });

  it('Neuer Gist zeigt Dateifeld und Sichtbarkeitshinweis', async () => {
    mount(<NewGistPage />, '/gists/new');
    expect(await screen.findByPlaceholderText('dateiname.ts')).toBeTruthy();
    expect(screen.getByText('Öffentlich auflisten')).toBeTruthy();
    expectNoReactErrors();
  });

  it('Paketliste zeigt den Installationsbefehl', async () => {
    mount(
      <Routes>
        <Route path="/:owner/-/packages" element={<PackagesPage />} />
      </Routes>,
      '/testerin/-/packages',
    );
    expect(await screen.findByText('@testerin/demo')).toBeTruthy();
    expect(
      screen.getByText(/npm install @testerin\/demo --registry/),
    ).toBeTruthy();
    expectNoReactErrors();
  });

  it('SSH-Schlüssel zeigt Fingerabdruck und Eingabefeld', async () => {
    mount(<SshKeysSettings />, '/settings/ssh-keys');
    expect(await screen.findByText('Laptop')).toBeTruthy();
    expect(screen.getByText('SHA256:abcdef')).toBeTruthy();
    expectNoReactErrors();
  });

  it('Kopfleiste zeigt Suche und Benachrichtigungszähler', async () => {
    mount(
      <Shell>
        <div>Inhalt</div>
      </Shell>,
    );

    await waitFor(() => expect(screen.getByLabelText('Suche')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('2')).toBeTruthy());
    expectNoReactErrors();
  });
});

describe('Markdown-Darstellung', () => {
  it('rendert Formatierung', () => {
    mount(<Markdown source="# Titel\n\nEin **fetter** Text." />);
    expect(screen.getByText('fetter')).toBeTruthy();
  });

  it('entfernt Skripte und gefährliche Attribute', () => {
    const { container } = mount(
      <Markdown source={'<script>window.angriff = 1</script>\n\n<img src=x onerror="window.angriff = 2">'} />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect((window as unknown as { angriff?: number }).angriff).toBeUndefined();
  });

  it('entfernt javascript:-Links', () => {
    const { container } = mount(<Markdown source={'[klick](javascript:alert(1))'} />);
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBeNull();
  });

  it('setzt rel und target bei externen Links', () => {
    const { container } = mount(<Markdown source={'[seite](https://beispiel.test)'} />);
    const link = container.querySelector('a');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(link?.getAttribute('target')).toBe('_blank');
  });
});
