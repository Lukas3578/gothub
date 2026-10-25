/**
 * Integrationstests gegen eine echte Datenbank und echte Git-Repositories.
 *
 * Es wird nichts simuliert: die Tests starten die vollständige Anwendung,
 * legen Repositories auf der Festplatte an und rufen git auf.
 *
 * Voraussetzung: keine. Vor dem Lauf legt vitest.globalSetup.ts eine frische
 * libSQL-Datei an und migriert sie – es braucht keinen Datenbankserver. Die Tests räumen
 * die von ihnen angelegten Daten am Ende wieder auf.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq, inArray, like } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { db } from '../db/index.js';
import { namespaces, repositories, users } from '../db/schema.js';
import { config } from '../config.js';

const run = promisify(execFile);

/** Eindeutiges Namenspräfix, damit parallele Läufe sich nicht stören. */
const RUN_ID = Math.random().toString(36).slice(2, 8);
const ALICE = `t${RUN_ID}alice`;
const BOB = `t${RUN_ID}bob`;

let app: FastifyInstance;
let serverUrl: string;

/** Sammelt Cookies über mehrere Anfragen hinweg, wie ein Browser. */
class Client {
  private cookies = new Map<string, string>();

  get csrf(): string | undefined {
    return this.cookies.get(config.security.csrfCookieName);
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
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
      payload: body === undefined ? undefined : JSON.stringify(body),
    });

    for (const raw of response.headers['set-cookie']
      ? ([] as string[]).concat(response.headers['set-cookie'] as any)
      : []) {
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
  post = (path: string, body?: unknown) => this.request('POST', path, body);
  patch = (path: string, body?: unknown) => this.request('PATCH', path, body);
  put = (path: string, body?: unknown) => this.request('PUT', path, body);
  delete = (path: string, body?: unknown) => this.request('DELETE', path, body);

  /** Holt das CSRF-Cookie, bevor die erste verändernde Anfrage gestellt wird. */
  async bootstrap(): Promise<void> {
    await this.get('/api/v1/meta');
  }
}

let alice: Client;
let bob: Client;
let anonymous: Client;

beforeAll(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  serverUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';

  alice = new Client();
  bob = new Client();
  anonymous = new Client();
  await Promise.all([alice.bootstrap(), bob.bootstrap(), anonymous.bootstrap()]);
}, 60_000);

afterAll(async () => {
  // Aufräumen: Benutzer und ihre Namespaces entfernen. Repositories hängen
  // per ON DELETE CASCADE daran bzw. werden hier explizit gelöscht.
  const testNamespaces = await db
    .select({ id: namespaces.id })
    .from(namespaces)
    .where(like(namespaces.nameLower, `t${RUN_ID}%`));

  const ids = testNamespaces.map((n) => n.id);
  if (ids.length > 0) {
    await db.delete(repositories).where(inArray(repositories.ownerNamespaceId, ids));
    await db.delete(users).where(inArray(users.namespaceId, ids));
    await db.delete(namespaces).where(inArray(namespaces.id, ids));
  }

  await app.close();
}, 30_000);

// ---------------------------------------------------------------------------

describe('Registrierung und Anmeldung', () => {
  it('legt einen Account an und meldet ihn direkt an', async () => {
    const result = await alice.post('/api/v1/auth/register', {
      username: ALICE,
      email: `${ALICE}@example.test`,
      password: 'ein-langes-testpasswort',
    });

    expect(result.status).toBe(201);
    expect(result.body.viewer.username).toBe(ALICE);

    const me = await alice.get('/api/v1/auth/me');
    expect(me.body.viewer.username).toBe(ALICE);
  });

  it('weist einen zu kurzen Benutzernamen und ein zu kurzes Passwort ab', async () => {
    const client = new Client();
    await client.bootstrap();
    const result = await client.post('/api/v1/auth/register', {
      username: 'x!!invalid',
      email: 'x@example.test',
      password: 'kurz',
    });
    expect(result.status).toBe(422);
    expect(result.body.error.fieldErrors).toHaveProperty('username');
    expect(result.body.error.fieldErrors).toHaveProperty('password');
  });

  it('lehnt einen bereits vergebenen Benutzernamen ab', async () => {
    const client = new Client();
    await client.bootstrap();
    const result = await client.post('/api/v1/auth/register', {
      username: ALICE,
      email: 'andere@example.test',
      password: 'ein-langes-testpasswort',
    });
    expect(result.status).toBe(409);
  });

  it('gibt bei falschem Passwort dieselbe Meldung wie bei unbekanntem Benutzer', async () => {
    const client = new Client();
    await client.bootstrap();

    const wrongPassword = await client.post('/api/v1/auth/login', {
      identifier: ALICE,
      password: 'falsches-passwort',
    });
    const unknownUser = await client.post('/api/v1/auth/login', {
      identifier: `gibtesnicht${RUN_ID}`,
      password: 'falsches-passwort',
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    // Entscheidend: der Text verrät nicht, welcher der beiden Fälle vorliegt.
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
  });

  it('blockiert verändernde Anfragen ohne CSRF-Header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/repositories',
      headers: { 'content-type': 'application/json', cookie: 'fg_csrf=irgendwas' },
      payload: JSON.stringify({ name: 'test' }),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('Repositories', () => {
  it('legt ein Repository mit echter Git-Historie an', async () => {
    const result = await alice.post('/api/v1/repositories', {
      name: 'testprojekt',
      description: 'Ein Testprojekt',
      visibility: 'public',
      initializeWithReadme: true,
      licenseTemplate: 'MIT',
    });

    expect(result.status).toBe(201);
    expect(result.body.fullName).toBe(`${ALICE}/testprojekt`);
    expect(result.body.isEmpty).toBe(false);

    // Die Commits müssen tatsächlich im Repository stehen.
    const commits = await alice.get(`/api/v1/repos/${ALICE}/testprojekt/commits`);
    expect(commits.body.items.length).toBeGreaterThanOrEqual(2);
    expect(commits.body.items[0].oid).toMatch(/^[0-9a-f]{40}$/);
  });

  it('liefert den Dateibaum mit echten Blobs', async () => {
    const tree = await alice.get(`/api/v1/repos/${ALICE}/testprojekt/tree`);
    const names = tree.body.entries.map((e: any) => e.name);
    expect(names).toContain('README.md');
    expect(names).toContain('LICENSE');

    const blob = await alice.get(`/api/v1/repos/${ALICE}/testprojekt/blob/README.md`);
    expect(blob.body.content).toContain('testprojekt');
    expect(blob.body.isBinary).toBe(false);
  });

  it('weist einen Pfad mit .. ab', async () => {
    const result = await alice.get(
      `/api/v1/repos/${ALICE}/testprojekt/blob/..%2F..%2Fetc%2Fpasswd`,
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
  });

  it('lehnt doppelte Repository-Namen ab', async () => {
    const result = await alice.post('/api/v1/repositories', {
      name: 'testprojekt',
      visibility: 'public',
    });
    expect(result.status).toBe(409);
  });

  it('setzt und entfernt einen Stern und zählt korrekt', async () => {
    const on = await alice.put(`/api/v1/repos/${ALICE}/testprojekt/star`);
    expect(on.body.starCount).toBe(1);

    // Zweimal setzen darf den Zähler nicht verdoppeln.
    const again = await alice.put(`/api/v1/repos/${ALICE}/testprojekt/star`);
    expect(again.body.starCount).toBe(1);

    const off = await alice.delete(`/api/v1/repos/${ALICE}/testprojekt/star`);
    expect(off.body.starCount).toBe(0);
  });
});

describe('Berechtigungen', () => {
  beforeAll(async () => {
    await bob.post('/api/v1/auth/register', {
      username: BOB,
      email: `${BOB}@example.test`,
      password: 'ein-langes-testpasswort',
    });

    await alice.post('/api/v1/repositories', {
      name: 'privat',
      visibility: 'private',
      initializeWithReadme: true,
    });
  });

  it('verbirgt private Repositories vor anderen Benutzern', async () => {
    const direct = await bob.get(`/api/v1/repos/${ALICE}/privat`);
    // 404 statt 403: ein 403 würde die Existenz bestätigen.
    expect(direct.status).toBe(404);

    const list = await bob.get('/api/v1/repositories?perPage=100');
    const names = list.body.items.map((r: any) => r.fullName);
    expect(names).not.toContain(`${ALICE}/privat`);
  });

  it('verbirgt private Repositories vor anonymen Besuchern', async () => {
    const list = await anonymous.get('/api/v1/repositories?perPage=100');
    const names = list.body.items.map((r: any) => r.fullName);
    expect(names).not.toContain(`${ALICE}/privat`);
    expect(names).toContain(`${ALICE}/testprojekt`);
  });

  it('verbirgt private Repositories auch auf der Profilseite', async () => {
    const list = await bob.get(`/api/v1/users/${ALICE}/repositories?perPage=100`);
    const names = list.body.items.map((r: any) => r.fullName);
    expect(names).not.toContain(`${ALICE}/privat`);
  });

  it('lässt Fremde ein öffentliches Repository nicht verändern', async () => {
    const update = await bob.patch(`/api/v1/repos/${ALICE}/testprojekt`, {
      description: 'übernommen',
    });
    expect(update.status).toBe(403);

    const remove = await bob.delete(`/api/v1/repos/${ALICE}/testprojekt`);
    expect(remove.status).toBe(403);
  });

  it('lässt Fremde keinen Branch in einem fremden Repository anlegen', async () => {
    const result = await bob.post(`/api/v1/repos/${ALICE}/testprojekt/branches`, {
      name: 'fremd',
      from: 'main',
    });
    expect(result.status).toBe(403);
  });

  it('verhindert das Anlegen eines Repositories im fremden Namensraum', async () => {
    const result = await bob.post('/api/v1/repositories', {
      ownerName: ALICE,
      name: 'untergeschoben',
      visibility: 'public',
    });
    expect(result.status).toBe(403);
  });
});

describe('Branches und Commits', () => {
  it('legt einen Branch an und löscht ihn wieder', async () => {
    const created = await alice.post(`/api/v1/repos/${ALICE}/testprojekt/branches`, {
      name: 'feature/test',
      from: 'main',
    });
    expect(created.status).toBe(201);

    const list = await alice.get(`/api/v1/repos/${ALICE}/testprojekt/branches`);
    expect(list.body.items.map((b: any) => b.name)).toContain('feature/test');

    const removed = await alice.delete(
      `/api/v1/repos/${ALICE}/testprojekt/branches/feature/test`,
    );
    expect(removed.status).toBe(200);

    const after = await alice.get(`/api/v1/repos/${ALICE}/testprojekt/branches`);
    expect(after.body.items.map((b: any) => b.name)).not.toContain('feature/test');
  });

  it('lässt den Default-Branch nicht löschen', async () => {
    const result = await alice.delete(`/api/v1/repos/${ALICE}/testprojekt/branches/main`);
    expect(result.status).toBe(422);
  });

  it('liefert einen Commit mit Diff', async () => {
    const commits = await alice.get(`/api/v1/repos/${ALICE}/testprojekt/commits`);
    const oid = commits.body.items[0].oid;

    const detail = await alice.get(`/api/v1/repos/${ALICE}/testprojekt/commits/${oid}`);
    expect(detail.status).toBe(200);
    expect(detail.body.files.length).toBeGreaterThan(0);
    expect(detail.body.stats.additions).toBeGreaterThan(0);
    // Der Diff muss echte Zeilen enthalten, keine Platzhalter.
    expect(detail.body.files[0].hunks[0].lines.length).toBeGreaterThan(0);
  });
});

describe('Datei über die API bearbeiten', () => {
  it('schreibt eine Datei und erzeugt einen echten Commit', async () => {
    const result = await alice.put(`/api/v1/repos/${ALICE}/testprojekt/contents/src/test.txt`, {
      branch: 'main',
      message: 'Testdatei anlegen',
      contentBase64: Buffer.from('Hallo Welt\n', 'utf8').toString('base64'),
    });

    expect(result.status).toBe(200);
    expect(result.body.commitOid).toMatch(/^[0-9a-f]{40}$/);

    const blob = await alice.get(`/api/v1/repos/${ALICE}/testprojekt/blob/src/test.txt`);
    expect(blob.body.content).toBe('Hallo Welt\n');
  });

  it('verweigert die Änderung bei veraltetem Stand', async () => {
    const result = await alice.put(`/api/v1/repos/${ALICE}/testprojekt/contents/src/test.txt`, {
      branch: 'main',
      message: 'Konflikt',
      contentBase64: Buffer.from('anders', 'utf8').toString('base64'),
      // Ein Stand, der nicht der aktuelle ist.
      expectedOid: '0000000000000000000000000000000000000000',
    });
    expect(result.status).toBe(422);
  });

  it('löscht eine Datei', async () => {
    const result = await alice.put(`/api/v1/repos/${ALICE}/testprojekt/contents/src/test.txt`, {
      branch: 'main',
      message: 'Testdatei entfernen',
      contentBase64: null,
    });
    expect(result.status).toBe(200);

    const blob = await alice.get(`/api/v1/repos/${ALICE}/testprojekt/blob/src/test.txt`);
    expect(blob.status).toBe(404);
  });
});

describe('Git über HTTP', () => {
  let workdir: string;
  let token: string;

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'forge-test-'));
    const result = await alice.post('/api/v1/user/tokens', { name: 'test' });
    token = result.body.token;
  }, 30_000);

  afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  function remote(owner: string, repo: string, user: string, pass: string): string {
    const base = serverUrl.replace('http://', `http://${user}:${pass}@`);
    return `${base}/git/${owner}/${repo}.git`;
  }

  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

  it('erlaubt das Klonen mit gültigem Token', async () => {
    const target = join(workdir, 'klon');
    await run('git', ['clone', remote(ALICE, 'testprojekt', ALICE, token), target], {
      env: gitEnv,
    });

    const { stdout } = await run('git', ['-C', target, 'log', '--oneline'], { env: gitEnv });
    expect(stdout.trim().split('\n').length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('erlaubt den Push mit Schreibrechten', async () => {
    const target = join(workdir, 'klon');
    await run('git', ['-C', target, 'config', 'user.email', `${ALICE}@example.test`]);
    await run('git', ['-C', target, 'config', 'user.name', ALICE]);
    await run('bash', ['-c', `echo "neu" > ${join(target, 'neu.txt')}`]);
    await run('git', ['-C', target, 'add', '-A']);
    await run('git', ['-C', target, 'commit', '-m', 'Neue Datei per Push']);
    await run('git', ['-C', target, 'push', 'origin', 'main'], { env: gitEnv });

    // Der Push muss über die API sichtbar sein – also wirklich angekommen sein.
    const tree = await alice.get(`/api/v1/repos/${ALICE}/testprojekt/tree`);
    expect(tree.body.entries.map((e: any) => e.name)).toContain('neu.txt');
  }, 60_000);

  it('verweigert das Klonen eines privaten Repositories durch Fremde', async () => {
    const bobToken = (await bob.post('/api/v1/user/tokens', { name: 'test' })).body.token;
    const target = join(workdir, 'diebstahl');

    await expect(
      run('git', ['clone', remote(ALICE, 'privat', BOB, bobToken), target], { env: gitEnv }),
    ).rejects.toThrow();
  }, 60_000);

  it('verweigert den Push ohne Schreibrechte', async () => {
    const bobToken = (await bob.post('/api/v1/user/tokens', { name: 'test2' })).body.token;
    const target = join(workdir, 'klon');

    await expect(
      run(
        'git',
        ['-C', target, 'push', remote(ALICE, 'testprojekt', BOB, bobToken), 'main'],
        { env: gitEnv },
      ),
    ).rejects.toThrow();
  }, 60_000);

  it('verweigert das Klonen ohne Zugangsdaten bei privatem Repository', async () => {
    const target = join(workdir, 'anonym');
    const url = `${serverUrl}/git/${ALICE}/privat.git`;

    await expect(run('git', ['clone', url, target], { env: gitEnv })).rejects.toThrow();
  }, 60_000);
});

describe('Sitzungen und Tokens', () => {
  it('listet die aktive Sitzung', async () => {
    const result = await alice.get('/api/v1/auth/sessions');
    expect(result.body.items.length).toBeGreaterThanOrEqual(1);
    expect(result.body.items.some((s: any) => s.isCurrent)).toBe(true);
  });

  it('beendet alle Sitzungen beim Passwortwechsel', async () => {
    // Zweite Sitzung desselben Benutzers.
    const second = new Client();
    await second.bootstrap();
    const login = await second.post('/api/v1/auth/login', {
      identifier: ALICE,
      password: 'ein-langes-testpasswort',
    });
    expect(login.status).toBe(200);
    expect((await second.get('/api/v1/auth/me')).body.viewer).not.toBeNull();

    await alice.post('/api/v1/auth/password/change', {
      currentPassword: 'ein-langes-testpasswort',
      newPassword: 'ein-neues-langes-passwort',
    });

    // Die zweite Sitzung muss jetzt ungültig sein.
    expect((await second.get('/api/v1/auth/me')).body.viewer).toBeNull();
    // Die Sitzung, in der die Änderung stattfand, bleibt bestehen.
    expect((await alice.get('/api/v1/auth/me')).body.viewer).not.toBeNull();
  }, 30_000);

  it('widerruft ein Token zuverlässig', async () => {
    const created = await alice.post('/api/v1/user/tokens', { name: 'wegwerf' });
    const id = created.body.id;
    const token = created.body.token;

    const withToken = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(withToken.body).viewer).not.toBeNull();

    await alice.delete(`/api/v1/user/tokens/${id}`);

    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(afterRevoke.body).viewer).toBeNull();
  });
});

describe('Dashboard', () => {
  it('liefert echte Zahlen aus der Datenbank', async () => {
    const result = await alice.get('/api/v1/dashboard');
    expect(result.status).toBe(200);
    expect(result.body.ownRepositories.length).toBeGreaterThanOrEqual(2);
    expect(result.body.counts.repositories).toBeGreaterThanOrEqual(2);
  });

  it('ist ohne Anmeldung nicht erreichbar', async () => {
    const result = await anonymous.get('/api/v1/dashboard');
    expect(result.status).toBe(401);
  });
});
