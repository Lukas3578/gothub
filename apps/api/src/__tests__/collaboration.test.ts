/**
 * Integrationstests für Issues, Pull Requests, Organisationen, Releases,
 * Suche, Benachrichtigungen und Workflows.
 *
 * Wie die Basistests laufen sie gegen eine echte Datenbank und echte
 * Git-Repositories. Was hier grün ist, funktioniert wirklich.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray, like } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { db } from '../db/index.js';
import { namespaces, organizations, repositories, users } from '../db/schema.js';
import { config } from '../config.js';

const RUN_ID = Math.random().toString(36).slice(2, 8);
const ANNA = `c${RUN_ID}anna`;
const BEN = `c${RUN_ID}ben`;
const ORG = `c${RUN_ID}org`;

let app: FastifyInstance;

class Client {
  private cookies = new Map<string, string>();

  get csrf(): string | undefined {
    return this.cookies.get(config.security.csrfCookieName);
  }

  async request(method: string, path: string, body?: unknown, rawHeaders?: Record<string, string>) {
    const headers: Record<string, string> = { ...rawHeaders };
    if (body !== undefined && !rawHeaders?.['content-type']) {
      headers['content-type'] = 'application/json';
    }
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (!['GET', 'HEAD'].includes(method) && this.csrf) {
      headers[config.security.csrfHeaderName] = this.csrf;
    }

    const response = await app.inject({
      method: method as any,
      url: path,
      headers,
      payload:
        body === undefined
          ? undefined
          : typeof body === 'string' || Buffer.isBuffer(body)
            ? (body as any)
            : JSON.stringify(body),
    });

    const setCookie = response.headers['set-cookie'];
    for (const raw of setCookie ? ([] as string[]).concat(setCookie as any) : []) {
      const [pair] = raw.split(';');
      const index = pair!.indexOf('=');
      this.cookies.set(pair!.slice(0, index), decodeURIComponent(pair!.slice(index + 1)));
    }

    let parsed: any = null;
    try {
      parsed = response.body ? JSON.parse(response.body) : null;
    } catch {
      parsed = response.body;
    }
    return { status: response.statusCode, body: parsed };
  }

  get = (path: string) => this.request('GET', path);
  post = (path: string, body?: unknown, headers?: Record<string, string>) =>
    this.request('POST', path, body, headers);
  patch = (path: string, body?: unknown) => this.request('PATCH', path, body);
  put = (path: string, body?: unknown) => this.request('PUT', path, body);
  delete = (path: string, body?: unknown) => this.request('DELETE', path, body);

  async bootstrap(): Promise<void> {
    await this.get('/api/v1/meta');
  }
}

let anna: Client;
let ben: Client;
let anon: Client;

const REPO = 'projekt';

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  anna = new Client();
  ben = new Client();
  anon = new Client();
  await Promise.all([anna.bootstrap(), ben.bootstrap(), anon.bootstrap()]);

  await anna.post('/api/v1/auth/register', {
    username: ANNA,
    email: `${ANNA}@example.test`,
    password: 'ein-langes-testpasswort',
  });
  await ben.post('/api/v1/auth/register', {
    username: BEN,
    email: `${BEN}@example.test`,
    password: 'ein-langes-testpasswort',
  });

  await anna.post('/api/v1/repositories', {
    name: REPO,
    visibility: 'public',
    initializeWithReadme: true,
  });
}, 120_000);

afterAll(async () => {
  const testNamespaces = await db
    .select({ id: namespaces.id })
    .from(namespaces)
    .where(like(namespaces.nameLower, `c${RUN_ID}%`));

  const ids = testNamespaces.map((n) => n.id);
  if (ids.length > 0) {
    await db.delete(repositories).where(inArray(repositories.ownerNamespaceId, ids));
    await db.delete(organizations).where(inArray(organizations.namespaceId, ids));
    await db.delete(users).where(inArray(users.namespaceId, ids));
    await db.delete(namespaces).where(inArray(namespaces.id, ids));
  }

  await app.close();
}, 60_000);

const path = () => `/api/v1/repos/${ANNA}/${REPO}`;

// ---------------------------------------------------------------------------

describe('Issues', () => {
  it('legt ein Issue an und vergibt eine fortlaufende Nummer', async () => {
    const first = await anna.post(`${path()}/issues`, {
      title: 'Erstes Problem',
      body: 'Eine Beschreibung.',
    });
    expect(first.status).toBe(201);
    expect(first.body.number).toBe(1);

    const second = await anna.post(`${path()}/issues`, { title: 'Zweites Problem' });
    expect(second.body.number).toBe(2);
  });

  it('erlaubt Fremden das Anlegen, aber nicht das Setzen von Labels', async () => {
    const created = await ben.post(`${path()}/issues`, {
      title: 'Von Ben gemeldet',
      labels: ['bug'],
    });
    expect(created.status).toBe(201);
    // Ben hat nur Lesezugriff, das Label darf nicht übernommen werden.
    expect(created.body.labels).toHaveLength(0);
  });

  it('lässt Fremde fremde Issues nicht umbenennen', async () => {
    const result = await ben.patch(`${path()}/issues/1`, { title: 'Übernommen' });
    expect(result.status).toBe(403);
  });

  it('schließt und öffnet ein Issue und führt dabei den Zähler mit', async () => {
    const before = await anna.get(`${path()}`);
    const openBefore = before.body.openIssueCount;

    await anna.patch(`${path()}/issues/1`, { state: 'closed', closeReason: 'completed' });

    const afterClose = await anna.get(`${path()}`);
    expect(afterClose.body.openIssueCount).toBe(openBefore - 1);

    // Zweimal schließen darf den Zähler nicht weiter senken.
    await anna.patch(`${path()}/issues/1`, { state: 'closed' });
    const afterDouble = await anna.get(`${path()}`);
    expect(afterDouble.body.openIssueCount).toBe(openBefore - 1);

    await anna.patch(`${path()}/issues/1`, { state: 'open' });
    const afterReopen = await anna.get(`${path()}`);
    expect(afterReopen.body.openIssueCount).toBe(openBefore);
  });

  it('speichert Kommentare und zählt sie mit', async () => {
    const created = await anna.post(`${path()}/issues/1/comments`, { body: 'Ein Kommentar.' });
    expect(created.status).toBe(201);

    const detail = await anna.get(`${path()}/issues/1`);
    expect(detail.body.issue.commentCount).toBe(1);
    expect(detail.body.timeline.some((entry: any) => entry.type === 'comment')).toBe(true);
  });

  it('schaltet Reaktionen um, statt sie zu verdoppeln', async () => {
    const detail = await anna.get(`${path()}/issues/1`);
    const issueId = detail.body.issue.id;

    const on = await anna.post(`${path()}/reactions/issue/${issueId}`, { content: '+1' });
    expect(on.body.reactions[0].count).toBe(1);

    const off = await anna.post(`${path()}/reactions/issue/${issueId}`, { content: '+1' });
    expect(off.body.reactions).toHaveLength(0);
  });

  it('sperrt eine Unterhaltung für Fremde', async () => {
    await anna.patch(`${path()}/issues/1`, { locked: true });

    const blocked = await ben.post(`${path()}/issues/1/comments`, { body: 'Trotzdem' });
    expect(blocked.status).toBe(403);

    // Der Eigentümer darf weiterhin schreiben.
    const allowed = await anna.post(`${path()}/issues/1/comments`, { body: 'Abschluss' });
    expect(allowed.status).toBe(201);

    await anna.patch(`${path()}/issues/1`, { locked: false });
  });

  it('filtert nach Zustand und Label', async () => {
    await anna.patch(`${path()}/issues/2`, { labels: ['bug'] });

    const byLabel = await anna.get(`${path()}/issues?labels=bug&state=all`);
    expect(byLabel.body.items).toHaveLength(1);
    expect(byLabel.body.items[0].number).toBe(2);
  });

  it('verwaltet Labels und verhindert doppelte Namen', async () => {
    const created = await anna.post(`${path()}/labels`, { name: 'dringend', color: 'ff0000' });
    expect(created.status).toBe(201);

    const duplicate = await anna.post(`${path()}/labels`, { name: 'dringend', color: '00ff00' });
    expect(duplicate.status).toBe(409);

    const invalid = await anna.post(`${path()}/labels`, { name: 'x', color: 'kein-hex' });
    expect(invalid.status).toBe(422);
  });

  it('legt Milestones an und zählt den Fortschritt', async () => {
    const created = await anna.post(`${path()}/milestones`, { title: 'Version 1.0' });
    expect(created.status).toBe(201);
    expect(created.body.number).toBe(1);

    await anna.patch(`${path()}/issues/2`, { milestone: 1 });

    const list = await anna.get(`${path()}/milestones`);
    expect(list.body.items[0].openCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------

describe('Benachrichtigungen', () => {
  it('benachrichtigt bei einer Erwähnung', async () => {
    await anna.post(`${path()}/issues`, {
      title: 'Frage an Ben',
      body: `Kannst du dir das ansehen, @${BEN}?`,
    });

    const notifications = await ben.get('/api/v1/notifications');
    expect(notifications.body.unreadCount).toBeGreaterThan(0);
    expect(notifications.body.items.some((item: any) => item.reason === 'mention')).toBe(true);
  });

  it('benachrichtigt niemanden über eigene Handlungen', async () => {
    const before = await anna.get('/api/v1/notifications/count');
    await anna.post(`${path()}/issues`, { title: 'Nur für mich', body: `Hallo @${ANNA}` });
    const after = await anna.get('/api/v1/notifications/count');

    expect(after.body.unreadCount).toBe(before.body.unreadCount);
  });

  it('markiert Benachrichtigungen als gelesen', async () => {
    await ben.post('/api/v1/notifications/read-all');
    const result = await ben.get('/api/v1/notifications/count');
    expect(result.body.unreadCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('Pull Requests', () => {
  beforeAll(async () => {
    // Einen Branch mit einer Änderung anlegen, damit es etwas zu mergen gibt.
    const detail = await anna.get(`${path()}`);
    await anna.post(`${path()}/branches`, { name: 'feature', from: detail.body.defaultBranch });
    await anna.put(`${path()}/contents/feature.txt`, {
      branch: 'feature',
      message: 'Datei für den Pull Request',
      contentBase64: Buffer.from('inhalt\n', 'utf8').toString('base64'),
    });
  }, 60_000);

  it('legt einen Pull Request an und berechnet die Änderungen', async () => {
    const created = await anna.post(`${path()}/pulls`, {
      title: 'Feature übernehmen',
      body: 'Closes #2',
      base: 'main',
      head: 'feature',
    });

    expect(created.status).toBe(201);
    expect(created.body.mergeableState).toBe('clean');
    expect(created.body.changedFiles).toBe(1);
    expect(created.body.commitCount).toBe(1);
  });

  it('verhindert einen zweiten Pull Request für dieselben Branches', async () => {
    const duplicate = await anna.post(`${path()}/pulls`, {
      title: 'Nochmal',
      base: 'main',
      head: 'feature',
    });
    expect(duplicate.status).toBe(409);
  });

  it('lässt Fremde ohne Schreibrecht keinen Branch vorschlagen', async () => {
    const result = await ben.post(`${path()}/pulls`, {
      title: 'Von Ben',
      base: 'main',
      head: 'feature',
    });
    expect(result.status).toBe(403);
  });

  it('verweigert die Zustimmung zum eigenen Pull Request', async () => {
    const list = await anna.get(`${path()}/pulls`);
    const number = list.body.items[0].number;

    const result = await anna.post(`${path()}/pulls/${number}/reviews`, { state: 'approved' });
    expect(result.status).toBe(422);
  });

  it('liefert den Diff mit echten Zeilen', async () => {
    const list = await anna.get(`${path()}/pulls`);
    const number = list.body.items[0].number;

    const files = await anna.get(`${path()}/pulls/${number}/files`);
    expect(files.body.files).toHaveLength(1);
    expect(files.body.files[0].path).toBe('feature.txt');
    expect(files.body.files[0].hunks[0].lines.length).toBeGreaterThan(0);
  });

  it('setzt Branch-Schutz durch und mergt erst nach Zustimmung', async () => {
    await anna.put(`${path()}/branch-protections`, {
      pattern: 'main',
      requirePullRequest: true,
      requiredApprovals: 1,
    });

    const list = await anna.get(`${path()}/pulls`);
    const number = list.body.items[0].number;

    const tooEarly = await anna.post(`${path()}/pulls/${number}/merge`, { strategy: 'merge' });
    expect(tooEarly.status).toBe(422);

    // Ben bekommt Schreibrecht und stimmt zu.
    await anna.put(`${path()}/collaborators/${BEN}`, { permission: 'write' });
    const review = await ben.post(`${path()}/pulls/${number}/reviews`, { state: 'approved' });
    expect(review.status).toBe(201);

    const merged = await anna.post(`${path()}/pulls/${number}/merge`, {
      strategy: 'squash',
      deleteBranch: true,
    });
    expect(merged.status).toBe(200);
    expect(merged.body.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);

    const detail = await anna.get(`${path()}/pulls/${number}`);
    expect(detail.body.pullRequest.merged).toBe(true);
    expect(detail.body.pullRequest.state).toBe('closed');
  }, 60_000);

  it('schließt das referenzierte Issue beim Mergen', async () => {
    const issue = await anna.get(`${path()}/issues/2`);
    expect(issue.body.issue.state).toBe('closed');
  });

  it('blockiert bei angeforderten Änderungen', async () => {
    const detail = await anna.get(`${path()}`);
    await anna.post(`${path()}/branches`, { name: 'feature2', from: detail.body.defaultBranch });
    await anna.put(`${path()}/contents/zweite.txt`, {
      branch: 'feature2',
      message: 'Zweite Datei',
      contentBase64: Buffer.from('zwei\n', 'utf8').toString('base64'),
    });

    const created = await anna.post(`${path()}/pulls`, {
      title: 'Zweites Feature',
      base: 'main',
      head: 'feature2',
    });

    await ben.post(`${path()}/pulls/${created.body.number}/reviews`, {
      state: 'changes_requested',
      body: 'Bitte nachbessern.',
    });

    const blocked = await anna.post(`${path()}/pulls/${created.body.number}/merge`, {
      strategy: 'merge',
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toContain('Änderungswünsche');
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe('Organisationen und Teams', () => {
  it('legt eine Organisation mit dem Ersteller als Eigentümer an', async () => {
    const created = await anna.post('/api/v1/organizations', { name: ORG });
    expect(created.status).toBe(201);

    const detail = await anna.get(`/api/v1/organizations/${ORG}`);
    expect(detail.body.viewerRole).toBe('owner');
  });

  it('verhindert einen Organisationsnamen, der schon vergeben ist', async () => {
    const duplicate = await anna.post('/api/v1/organizations', { name: ORG });
    expect(duplicate.status).toBe(409);

    // Auch ein bestehender Benutzername ist blockiert.
    const asUser = await anna.post('/api/v1/organizations', { name: BEN });
    expect(asUser.status).toBe(409);
  });

  it('gewährt Zugriff erst über eine Team-Zuweisung', async () => {
    await anna.post('/api/v1/repositories', {
      ownerName: ORG,
      name: 'intern',
      visibility: 'private',
      initializeWithReadme: true,
    });

    // Ben ist noch kein Mitglied.
    expect((await ben.get(`/api/v1/repos/${ORG}/intern`)).status).toBe(404);

    await anna.post(`/api/v1/organizations/${ORG}/invitations`, { username: BEN });
    const invitations = await ben.get('/api/v1/user/invitations');
    await ben.post(`/api/v1/user/invitations/${invitations.body.items[0].id}/accept`);

    // Mitgliedschaft allein genügt für ein privates Repository nicht.
    expect((await ben.get(`/api/v1/repos/${ORG}/intern`)).status).toBe(404);

    await anna.put(`/api/v1/organizations/${ORG}/teams/alle/repositories`, {
      repository: 'intern',
      permission: 'read',
    });

    const afterGrant = await ben.get(`/api/v1/repos/${ORG}/intern`);
    expect(afterGrant.status).toBe(200);
    expect(afterGrant.body.viewerAccess).toBe('read');
  }, 60_000);

  it('verhindert das Entfernen des letzten Eigentümers', async () => {
    const result = await anna.delete(`/api/v1/organizations/${ORG}/members/${ANNA}`);
    expect(result.status).toBe(422);
  });

  it('entzieht beim Entfernen auch den Team-Zugriff', async () => {
    await anna.delete(`/api/v1/organizations/${ORG}/members/${BEN}`);
    expect((await ben.get(`/api/v1/repos/${ORG}/intern`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('Releases', () => {
  it('legt ein Release an und erzeugt dabei das Tag', async () => {
    const created = await anna.post(`${path()}/releases`, {
      tagName: 'v1.0.0',
      name: 'Erste Version',
      body: 'Startschuss.',
    });

    expect(created.status).toBe(201);

    const tags = await anna.get(`${path()}/tags`);
    expect(tags.body.items.some((tag: any) => tag.name === 'v1.0.0')).toBe(true);
  });

  it('verhindert ein zweites Release für dasselbe Tag', async () => {
    const duplicate = await anna.post(`${path()}/releases`, { tagName: 'v1.0.0' });
    expect(duplicate.status).toBe(409);
  });

  it('lädt eine Datei hoch und gibt sie unverändert zurück', async () => {
    const content = Buffer.from('Dies ist eine Testdatei mit Inhalt.\n'.repeat(100), 'utf8');

    const uploaded = await anna.post(`${path()}/releases/v1.0.0/assets`, content, {
      'content-type': 'application/octet-stream',
      'x-forge-filename': 'test.bin',
    });

    expect(uploaded.status).toBe(201);
    expect(uploaded.body.sizeBytes).toBe(content.length);

    const list = await anna.get(`${path()}/releases`);
    const asset = list.body.items[0].assets[0];

    const download = await app.inject({
      method: 'GET',
      url: `${path()}/releases/assets/${asset.id}`,
    });

    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.length).toBe(content.length);
    expect(download.headers['content-disposition']).toContain('test.bin');
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe('Suche', () => {
  it('findet öffentliche Repositories', async () => {
    const result = await anon.get(`/api/v1/search?type=repositories&q=${REPO}`);
    expect(result.body.items.some((item: any) => item.name === REPO)).toBe(true);
  });

  it('zeigt private Repositories nicht in der Codesuche für Fremde', async () => {
    await anna.put(`/api/v1/repos/${ORG}/intern/contents/geheim.txt`, {
      branch: 'main',
      message: 'Geheimnis',
      contentBase64: Buffer.from(`GEHEIM${RUN_ID}`, 'utf8').toString('base64'),
    });

    const asOwner = await anna.get(`/api/v1/search?type=code&q=GEHEIM${RUN_ID}`);
    expect(asOwner.body.totalCount).toBeGreaterThan(0);

    const asAnon = await anon.get(`/api/v1/search?type=code&q=GEHEIM${RUN_ID}`);
    expect(asAnon.body.totalCount).toBe(0);

    const asBen = await ben.get(`/api/v1/search?type=code&q=GEHEIM${RUN_ID}`);
    expect(asBen.body.totalCount).toBe(0);
  }, 60_000);

  it('findet Issues über ihren Titel', async () => {
    const result = await anna.get('/api/v1/search?type=issues&q=Erstes');
    expect(result.body.items.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('Workflows', () => {
  // Die Pull-Request-Tests haben main unter Schutz gestellt. Für die
  // Workflow-Tests wird die Regel entfernt, damit Dateien direkt geschrieben
  // werden können – der Schutz selbst ist dort bereits geprüft.
  beforeAll(async () => {
    const protections = await anna.get(`${path()}/branch-protections`);
    for (const protection of protections.body.items ?? []) {
      await anna.delete(`${path()}/branch-protections/${protection.id}`);
    }
  }, 30_000);

  it('erkennt einen Workflow und legt die Jobs mit Abhängigkeiten an', async () => {
    const workflow = `name: Test

on:
  workflow_dispatch:

jobs:
  erst:
    runs-on: ubuntu-latest
    steps:
      - name: Schritt eins
        run: echo eins
  dann:
    runs-on: ubuntu-latest
    needs: erst
    steps:
      - name: Schritt zwei
        run: echo zwei
`;

    await anna.put(`${path()}/contents/.forge/workflows/test.yml`, {
      branch: 'main',
      message: 'Workflow hinzufügen',
      contentBase64: Buffer.from(workflow, 'utf8').toString('base64'),
    });

    const dispatch = await anna.post(`${path()}/actions/dispatch`, {
      workflowPath: '.forge/workflows/test.yml',
      ref: 'main',
    });

    expect(dispatch.status).toBe(200);
    expect(dispatch.body.runIds).toHaveLength(1);

    const detail = await anna.get(`${path()}/actions/runs/${dispatch.body.runIds[0]}`);
    expect(detail.body.run.jobs).toHaveLength(2);

    const first = detail.body.run.jobs.find((job: any) => job.jobKey === 'erst');
    const second = detail.body.run.jobs.find((job: any) => job.jobKey === 'dann');

    // Der abhängige Job wartet, der unabhängige steht in der Warteschlange.
    expect(first.status).toBe('queued');
    expect(second.status).toBe('waiting');
    expect(second.dependsOn).toEqual(['erst']);
  }, 60_000);

  it('meldet eine fehlerhafte Workflow-Datei, statt sie zu übergehen', async () => {
    await anna.put(`${path()}/contents/.forge/workflows/kaputt.yml`, {
      branch: 'main',
      message: 'Fehlerhafte Datei',
      contentBase64: Buffer.from('das ist: kein: gueltiges: yaml:\n  - [', 'utf8').toString('base64'),
    });

    await anna.post(`${path()}/actions/dispatch`, {
      workflowPath: '.forge/workflows/kaputt.yml',
      ref: 'main',
    });

    const workflows = await anna.get(`${path()}/workflows`);
    const broken = workflows.body.items.find((w: any) => w.path.includes('kaputt'));
    expect(broken?.parseError).toBeTruthy();
  }, 60_000);

  it('bricht einen Lauf ab', async () => {
    const runs = await anna.get(`${path()}/actions/runs`);
    const runId = runs.body.items[0].id;

    const cancelled = await anna.post(`${path()}/actions/runs/${runId}/cancel`);
    expect(cancelled.status).toBe(200);

    const detail = await anna.get(`${path()}/actions/runs/${runId}`);
    expect(detail.body.run.status).toBe('cancelled');
  });

  it('gibt Secrets nie im Klartext zurück', async () => {
    await anna.put(`${path()}/secrets/MEIN_GEHEIMNIS`, { value: 'streng-geheim-123' });

    const list = await anna.get(`${path()}/secrets`);
    const serialized = JSON.stringify(list.body);

    expect(serialized).toContain('MEIN_GEHEIMNIS');
    expect(serialized).not.toContain('streng-geheim-123');
  });

  it('lässt Fremde keine Secrets lesen oder setzen', async () => {
    expect((await ben.get(`${path()}/secrets`)).status).toBe(403);
    expect((await ben.put(`${path()}/secrets/FREMD`, { value: 'x' })).status).toBe(403);
  });

  it('registriert einen Runner und gibt das Token genau einmal aus', async () => {
    const created = await anna.post(`${path()}/runners`, { name: 'test-runner' });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^fgr_/);

    const list = await anna.get(`${path()}/runners`);
    expect(JSON.stringify(list.body)).not.toContain(created.body.token);
  });

  it('weist einen Job nur an einen Runner mit passenden Labels zu', async () => {
    const created = await anna.post(`${path()}/runners`, {
      name: 'falsche-labels',
      labels: ['windows'],
    });

    const claim = await app.inject({
      method: 'POST',
      url: '/api/v1/runner/jobs/claim',
      headers: { authorization: `Bearer ${created.body.token}`, 'content-type': 'application/json' },
      payload: '{}',
    });

    // Es gibt nur Jobs mit "ubuntu-latest"; dieser Runner bekommt keinen.
    expect(JSON.parse(claim.body).job).toBeNull();
  }, 60_000);

  it('lehnt ein ungültiges Runner-Token ab', async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/runner/jobs/claim',
      headers: { authorization: 'Bearer fgr_erfunden', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(result.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------

describe('Webhooks', () => {
  it('weist eine URL mit unzulässigem Protokoll ab', async () => {
    const result = await anna.post(`${path()}/webhooks`, {
      url: 'ftp://beispiel.de/hook',
      events: ['push'],
    });
    expect(result.status).toBe(422);
  });

  it('gibt das Geheimnis nur beim Anlegen zurück', async () => {
    const created = await anna.post(`${path()}/webhooks`, {
      url: 'https://beispiel.test/hook',
      events: ['push'],
    });
    expect(created.body.secret).toBeTruthy();

    const list = await anna.get(`${path()}/webhooks`);
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);
    expect(list.body.items[0].hasSecret).toBe(true);
  });

  it('lässt Fremde keine Webhooks sehen', async () => {
    expect((await ben.get(`${path()}/webhooks`)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe('Administration', () => {
  it('ist für normale Benutzer gesperrt', async () => {
    expect((await ben.get('/api/v1/admin/stats')).status).toBe(403);
    expect((await anon.get('/api/v1/admin/stats')).status).toBe(401);
  });

  it('liefert Statistiken für Administratoren', async () => {
    // Der erste Account der Instanz ist Administrator; in dieser Testumgebung
    // ist das nicht zwingend Anna, deshalb wird der Zugriff nur geprüft,
    // wenn sie tatsächlich Adminrechte hat.
    const me = await anna.get('/api/v1/auth/me');
    if (!me.body.viewer.isAdmin) return;

    const stats = await anna.get('/api/v1/admin/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.users.total).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('Workflow-Parser', () => {
  it('erkennt zirkuläre Abhängigkeiten', async () => {
    const { parseWorkflow, WorkflowParseError } = await import('../services/workflow-parser.js');

    const source = `name: Zyklus
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    needs: b
    steps:
      - run: echo a
  b:
    runs-on: ubuntu-latest
    needs: a
    steps:
      - run: echo b
`;

    expect(() => parseWorkflow(source, 'test.yml')).toThrow(WorkflowParseError);
  });

  it('erkennt einen Verweis auf einen unbekannten Job', async () => {
    const { parseWorkflow } = await import('../services/workflow-parser.js');

    const source = `name: Fehlend
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    needs: gibtesnicht
    steps:
      - run: echo a
`;

    expect(() => parseWorkflow(source, 'test.yml')).toThrow(/gibtesnicht/);
  });

  it('wertet Branch-Filter korrekt aus', async () => {
    const { parseWorkflow, pushTriggerMatches } = await import('../services/workflow-parser.js');

    const source = `name: Gefiltert
on:
  push:
    branches:
      - main
      - 'release/**'
    paths-ignore:
      - 'docs/**'
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
`;

    const parsed = parseWorkflow(source, 'test.yml');

    expect(
      pushTriggerMatches(parsed.triggers.push, { branch: 'main', tag: null, changedPaths: ['src/a.ts'] }),
    ).toBe(true);

    expect(
      pushTriggerMatches(parsed.triggers.push, {
        branch: 'release/1.0',
        tag: null,
        changedPaths: null,
      }),
    ).toBe(true);

    expect(
      pushTriggerMatches(parsed.triggers.push, { branch: 'feature/x', tag: null, changedPaths: null }),
    ).toBe(false);

    // Nur Dokumentation geändert: der Workflow soll nicht laufen.
    expect(
      pushTriggerMatches(parsed.triggers.push, {
        branch: 'main',
        tag: null,
        changedPaths: ['docs/readme.md'],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('SSRF-Schutz für Webhooks', () => {
  it('erkennt interne Adressbereiche', async () => {
    const { isBlockedAddress } = await import('../services/webhooks.js');

    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isBlockedAddress(address), `${address} sollte blockiert sein`).toBe(true);
    }

    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
      expect(isBlockedAddress(address), `${address} sollte erlaubt sein`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe('Cron-Auswertung', () => {
  it('wertet Standardausdrücke korrekt aus', async () => {
    const { cronMatches } = await import('../scheduler.js');

    // 2026-10-23 ist ein Freitag; 14:30 UTC.
    const date = new Date(Date.UTC(2026, 9, 23, 14, 30));

    expect(cronMatches('30 14 * * *', date)).toBe(true);
    expect(cronMatches('* * * * *', date)).toBe(true);
    expect(cronMatches('30 14 23 10 *', date)).toBe(true);
    expect(cronMatches('30 14 * * 5', date)).toBe(true);
    expect(cronMatches('0 14 * * *', date)).toBe(false);
    expect(cronMatches('30 15 * * *', date)).toBe(false);
    expect(cronMatches('*/15 * * * *', date)).toBe(true);
    expect(cronMatches('*/7 * * * *', date)).toBe(false);
    expect(cronMatches('kein cron', date)).toBe(false);
  });
});
