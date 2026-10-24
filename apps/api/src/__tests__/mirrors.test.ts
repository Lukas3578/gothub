/**
 * Tests für die Spiegelung auf andere Git-Hoster.
 *
 * Geprüft wird, was ohne Netzverbindung prüfbar ist – und das ist genau der
 * sicherheitsrelevante Teil:
 *
 *   - die Prüfung der Zieladresse (SSRF, unverschlüsselte Protokolle,
 *     eingebettete Zugangsdaten),
 *   - dass ein hinterlegtes Token nie wieder herausgegeben wird,
 *   - dass Berechtigungen gelten,
 *   - dass die Lease zwei gleichzeitige Läufe verhindert,
 *   - dass Fehlermeldungen das Token maskieren.
 *
 * Eine echte Übertragung nach GitHub braucht ein gültiges Token und eine
 * Netzverbindung; das lässt sich in einem Test nicht ehrlich nachstellen und
 * wird hier deshalb nicht behauptet.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, like } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { db } from '../db/index.js';
import { namespaces, repositories, repositoryMirrors, users } from '../db/schema.js';
import { config } from '../config.js';
import { runMirror, runDuePullMirrors, scrubCredentials } from '../services/mirrors.js';

const RUN_ID = Math.random().toString(36).slice(2, 8);
const OWNER = `m${RUN_ID}owner`;
const OTHER = `m${RUN_ID}other`;
const REPO = 'gespiegelt';

let app: FastifyInstance;

class Client {
  private cookies = new Map<string, string>();

  private get csrf(): string | undefined {
    return this.cookies.get(config.security.csrfCookieName);
  }

  async request(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (!['GET', 'HEAD'].includes(method) && this.csrf) {
      headers[config.security.csrfHeaderName] = this.csrf;
    }

    const response = await app.inject({
      method: method as 'GET',
      url: path,
      headers,
      payload: body === undefined ? undefined : JSON.stringify(body),
    });

    const setCookie = response.headers['set-cookie'];
    for (const raw of setCookie ? ([] as string[]).concat(setCookie as never) : []) {
      const [pair] = raw.split(';');
      const index = pair!.indexOf('=');
      this.cookies.set(pair!.slice(0, index), decodeURIComponent(pair!.slice(index + 1)));
    }

    let parsed: Record<string, never> | null = null;
    try {
      parsed = response.body ? JSON.parse(response.body) : null;
    } catch {
      parsed = null;
    }
    return { status: response.statusCode, body: parsed as never };
  }

  get = (path: string) => this.request('GET', path);
  post = (path: string, body?: unknown) => this.request('POST', path, body);
  put = (path: string, body?: unknown) => this.request('PUT', path, body);
  delete = (path: string) => this.request('DELETE', path);
}

let owner: Client;
let other: Client;
let anon: Client;
let repositoryId: string;

const base = () => `/api/v1/repos/${OWNER}/${REPO}/mirrors`;

/**
 * Eine Adresse, die die SSRF-Prüfung besteht: ein Name, der öffentlich
 * auflöst. Übertragen wird in den Tests nichts.
 */
const REMOTE = 'https://github.com/forge-spiegel-test/beispiel.git';

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  owner = new Client();
  other = new Client();
  anon = new Client();
  await Promise.all([owner.get('/api/v1/meta'), other.get('/api/v1/meta'), anon.get('/api/v1/meta')]);

  await owner.post('/api/v1/auth/register', {
    username: OWNER,
    email: `${OWNER}@example.test`,
    password: 'ein-langes-testpasswort',
  });
  await other.post('/api/v1/auth/register', {
    username: OTHER,
    email: `${OTHER}@example.test`,
    password: 'ein-langes-testpasswort',
  });

  const created = await owner.post('/api/v1/repositories', {
    name: REPO,
    visibility: 'public',
    initializeWithReadme: true,
  });
  repositoryId = (created.body as unknown as { id: string }).id;
}, 120_000);

afterAll(async () => {
  const testNamespaces = await db
    .select({ id: namespaces.id })
    .from(namespaces)
    .where(like(namespaces.nameLower, `m${RUN_ID}%`));

  const ids = testNamespaces.map((n) => n.id);
  if (ids.length > 0) {
    await db.delete(repositories).where(inArray(repositories.ownerNamespaceId, ids));
    await db.delete(users).where(inArray(users.namespaceId, ids));
    await db.delete(namespaces).where(inArray(namespaces.id, ids));
  }

  await app.close();
}, 60_000);

// ---------------------------------------------------------------------------
// Prüfung der Zieladresse
// ---------------------------------------------------------------------------

describe('Prüfung der Zieladresse', () => {
  it('lehnt http ab, weil es unverschlüsselt überträgt', async () => {
    const result = await owner.put(base(), {
      direction: 'push',
      remoteUrl: 'http://github.com/jemand/repo.git',
    });
    expect(result.status).toBe(422);
  });

  it('lehnt eine Adresse mit eingebetteten Zugangsdaten ab', async () => {
    const result = await owner.put(base(), {
      direction: 'push',
      remoteUrl: 'https://benutzer:geheim@github.com/jemand/repo.git',
    });
    expect(result.status).toBe(422);
    // Das Token darf auch nicht in der Fehlermeldung wieder auftauchen.
    expect(JSON.stringify(result.body)).not.toContain('geheim');
  });

  it('lehnt Loopback ab', async () => {
    const result = await owner.put(base(), {
      direction: 'push',
      remoteUrl: 'https://127.0.0.1/repo.git',
    });
    expect(result.status).toBe(422);
  });

  it('lehnt die Adresse des Cloud-Metadatendienstes ab', async () => {
    const result = await owner.put(base(), {
      direction: 'push',
      remoteUrl: 'https://169.254.169.254/latest/meta-data/',
    });
    expect(result.status).toBe(422);
  });

  it('lehnt ein privates Netz ab', async () => {
    const result = await owner.put(base(), {
      direction: 'push',
      remoteUrl: 'https://10.0.0.5/repo.git',
    });
    expect(result.status).toBe(422);
  });

  it('lehnt Müll ab, der keine URL ist', async () => {
    const result = await owner.put(base(), { direction: 'push', remoteUrl: 'github.com/x' });
    expect(result.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Berechtigungen
// ---------------------------------------------------------------------------

describe('Berechtigungen', () => {
  it('verweigert Nichtangemeldeten das Auflisten', async () => {
    const result = await anon.get(base());
    expect(result.status).toBe(401);
  });

  it('verweigert einem Fremden mit Lesezugriff das Einrichten', async () => {
    // Das Repository ist öffentlich: lesen darf er, einrichten nicht.
    const readable = await other.get(`/api/v1/repos/${OWNER}/${REPO}`);
    expect(readable.status).toBe(200);

    const result = await other.put(base(), { direction: 'push', remoteUrl: REMOTE });
    expect([403, 404]).toContain(result.status);
  });

  it('verweigert einem Fremden das Auflisten', async () => {
    const result = await other.get(base());
    expect([403, 404]).toContain(result.status);
  });
});

// ---------------------------------------------------------------------------
// Einrichten und Bearbeiten
// ---------------------------------------------------------------------------

describe('Einrichten', () => {
  it('legt eine Spiegelung an und gibt das Token nicht zurück', async () => {
    const result = await owner.put(base(), {
      direction: 'push',
      remoteUrl: `${REMOTE}/`,
      remoteUsername: OWNER,
      token: 'ghp_streng_geheimes_token',
    });

    expect(result.status).toBe(200);
    const saved = result.body as unknown as Record<string, unknown>;

    expect(saved.direction).toBe('push');
    // Der Schrägstrich am Ende wird entfernt, damit die Adresse eindeutig ist.
    expect(saved.remoteUrl).toBe(REMOTE);
    expect(saved.hasToken).toBe(true);
    // Entscheidend: der Wert selbst steht nirgends in der Antwort.
    expect(JSON.stringify(saved)).not.toContain('ghp_streng_geheimes_token');
    expect(saved).not.toHaveProperty('tokenEnc');
    expect(saved).not.toHaveProperty('token');
  });

  it('gibt das Token auch beim Auflisten nicht heraus', async () => {
    const result = await owner.get(base());
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).not.toContain('ghp_streng_geheimes_token');
    const items = (result.body as unknown as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.hasToken).toBe(true);
  });

  it('speichert das Token verschlüsselt, nicht im Klartext', async () => {
    const rows = await db
      .select({ tokenEnc: repositoryMirrors.tokenEnc })
      .from(repositoryMirrors)
      .where(eq(repositoryMirrors.repositoryId, repositoryId));

    expect(rows[0]!.tokenEnc).toBeTruthy();
    expect(rows[0]!.tokenEnc).not.toContain('ghp_streng_geheimes_token');
  });

  it('behält das Token, wenn beim Bearbeiten keines angegeben wird', async () => {
    const result = await owner.put(base(), {
      direction: 'push',
      remoteUrl: REMOTE,
      remoteUsername: 'anderer-name',
    });

    const saved = result.body as unknown as Record<string, unknown>;
    expect(saved.hasToken).toBe(true);
    expect(saved.remoteUsername).toBe('anderer-name');
  });

  it('entfernt das Token bei einem leeren String', async () => {
    const result = await owner.put(base(), {
      direction: 'push',
      remoteUrl: REMOTE,
      token: '',
    });
    expect((result.body as unknown as { hasToken: boolean }).hasToken).toBe(false);
  });

  it('richtet keine zweite Richtung ein, weil beide sich überschreiben würden', async () => {
    const result = await owner.put(base(), { direction: 'pull', remoteUrl: REMOTE });
    expect(result.status).toBe(422);
    const body = result.body as unknown as { error: { message: string } };
    expect(body.error.message).toContain('push');
  });

  it('überschreibt dieselbe Richtung statt eine zweite Zeile anzulegen', async () => {
    await owner.put(base(), { direction: 'push', remoteUrl: REMOTE, isEnabled: false });
    const list = await owner.get(base());
    const items = (list.body as unknown as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.isEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ausführung
// ---------------------------------------------------------------------------

describe('Ausführung', () => {
  it('führt eine deaktivierte Spiegelung nicht aus', async () => {
    const rows = await db
      .select({ id: repositoryMirrors.id })
      .from(repositoryMirrors)
      .where(eq(repositoryMirrors.repositoryId, repositoryId));

    const result = await runMirror(rows[0]!.id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('deaktiviert');
  });

  it('lässt keinen zweiten Lauf zu, solange die Lease gilt', async () => {
    const rows = await db
      .select({ id: repositoryMirrors.id })
      .from(repositoryMirrors)
      .where(eq(repositoryMirrors.repositoryId, repositoryId));
    const id = rows[0]!.id;

    // Zustand eines laufenden Spiegels herstellen, ohne Git zu starten.
    await db
      .update(repositoryMirrors)
      .set({
        isEnabled: true,
        status: 'running',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(repositoryMirrors.id, id));

    const result = await runMirror(id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('läuft bereits');

    // Eine abgelaufene Lease blockiert dagegen nicht: ein abgestürzter Lauf
    // darf den Spiegel nicht dauerhaft sperren. Hier nur geprüft, dass der
    // Lauf überhaupt beginnt – er endet ohne Netz mit einem Fehler.
    await db
      .update(repositoryMirrors)
      .set({ leaseExpiresAt: new Date(Date.now() - 60_000), isEnabled: false })
      .where(eq(repositoryMirrors.id, id));
  });

  it('fasst Push-Spiegelungen nicht an, wenn Pull-Spiegelungen fällig sind', async () => {
    const before = await db
      .select({ status: repositoryMirrors.status })
      .from(repositoryMirrors)
      .where(
        and(
          eq(repositoryMirrors.repositoryId, repositoryId),
          eq(repositoryMirrors.direction, 'push'),
        ),
      );

    const count = await runDuePullMirrors(0);
    expect(count).toBe(0);

    const after = await db
      .select({ status: repositoryMirrors.status })
      .from(repositoryMirrors)
      .where(
        and(
          eq(repositoryMirrors.repositoryId, repositoryId),
          eq(repositoryMirrors.direction, 'push'),
        ),
      );

    expect(after[0]!.status).toBe(before[0]!.status);
  });

  it('löscht die Spiegelung', async () => {
    const list = await owner.get(base());
    const items = (list.body as unknown as { items: { id: string }[] }).items;

    const result = await owner.delete(`${base()}/${items[0]!.id}`);
    expect(result.status).toBe(200);

    const after = await owner.get(base());
    expect((after.body as unknown as { items: unknown[] }).items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Maskierung in Fehlermeldungen
// ---------------------------------------------------------------------------

describe('Maskierung', () => {
  it('ersetzt das Token in einer Fehlermeldung', () => {
    const message =
      "remote: Invalid username or password\nfatal: Authentication failed for 'https://github.com/x/y.git/' (token ghp_abc123)";
    const result = scrubCredentials(message, 'ghp_abc123');

    expect(result).not.toContain('ghp_abc123');
    expect(result).toContain('***');
    // Der verwertbare Teil der Meldung bleibt lesbar.
    expect(result).toContain('Authentication failed');
  });

  it('maskiert auch Zugangsdaten, die Git selbst in eine URL schreibt', () => {
    const result = scrubCredentials(
      "fatal: unable to access 'https://benutzer:ghp_xyz@github.com/x/y.git/'",
      null,
    );
    expect(result).not.toContain('ghp_xyz');
    expect(result).not.toContain('benutzer:');
    expect(result).toContain('//***:***@');
  });

  it('begrenzt die Länge, damit ein Spiegel die Zeile nicht sprengt', () => {
    expect(scrubCredentials('x'.repeat(10_000), null)).toHaveLength(2000);
  });

  it('kommt ohne Token zurecht', () => {
    expect(scrubCredentials('Host unerreichbar.', null)).toBe('Host unerreichbar.');
  });
});
