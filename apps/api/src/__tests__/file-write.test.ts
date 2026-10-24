/**
 * Tests für das Schreiben von Dateien über die API.
 *
 * Der Weg, den die Oberfläche beim Anlegen, Bearbeiten, Hochladen und Löschen
 * nimmt. Geprüft wird gegen echte Repositories auf der Platte – was hier grün
 * ist, erzeugt wirklich Commits, die ein `git clone` zu sehen bekommt.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { inArray, like } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { db } from '../db/index.js';
import { namespaces, repositories, users } from '../db/schema.js';
import { config } from '../config.js';

const RUN_ID = Math.random().toString(36).slice(2, 8);
const OWNER = `w${RUN_ID}owner`;
const OTHER = `w${RUN_ID}other`;
const REPO = 'schreiben';

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

    let parsed: unknown = null;
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
}

let owner: Client;
let other: Client;

const base = () => `/api/v1/repos/${OWNER}/${REPO}`;
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

async function read(path: string, ref = 'main') {
  const result = await owner.get(`${base()}/blob/${path}?ref=${encodeURIComponent(ref)}`);
  return result;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  owner = new Client();
  other = new Client();
  await Promise.all([owner.get('/api/v1/meta'), other.get('/api/v1/meta')]);

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

  await owner.post('/api/v1/repositories', {
    name: REPO,
    visibility: 'public',
    initializeWithReadme: true,
  });
}, 120_000);

afterAll(async () => {
  const testNamespaces = await db
    .select({ id: namespaces.id })
    .from(namespaces)
    .where(like(namespaces.nameLower, `w${RUN_ID}%`));

  const ids = testNamespaces.map((n) => n.id);
  if (ids.length > 0) {
    await db.delete(repositories).where(inArray(repositories.ownerNamespaceId, ids));
    await db.delete(users).where(inArray(users.namespaceId, ids));
    await db.delete(namespaces).where(inArray(namespaces.id, ids));
  }

  await app.close();
}, 60_000);

// ---------------------------------------------------------------------------

describe('Einzelne Datei', () => {
  it('legt eine Datei an', async () => {
    const result = await owner.put(`${base()}/contents/docs/anleitung.md`, {
      branch: 'main',
      message: 'Anleitung angelegt',
      contentBase64: b64('# Anleitung\n\nText.\n'),
    });

    expect(result.status).toBe(200);
    const blob = await read('docs/anleitung.md');
    expect(blob.status).toBe(200);
    expect((blob.body as unknown as { content: string }).content).toBe('# Anleitung\n\nText.\n');
  });

  it('erhält Umlaute und Zeilenenden unverändert', async () => {
    const text = 'Grüße aus Österreich\r\nZweite Zeile\tmit Tabulator\n';
    await owner.put(`${base()}/contents/umlaute.txt`, {
      branch: 'main',
      message: 'Umlaute',
      contentBase64: b64(text),
    });

    const blob = await read('umlaute.txt');
    expect((blob.body as unknown as { content: string }).content).toBe(text);
  });

  it('benennt eine Datei um, ohne eine Kopie zu hinterlassen', async () => {
    await owner.put(`${base()}/contents/umlaute.txt`, {
      branch: 'main',
      message: 'Umbenannt',
      contentBase64: b64('Grüße aus Österreich\r\nZweite Zeile\tmit Tabulator\n'),
      newPath: 'texte/umlaute.txt',
    });

    expect((await read('texte/umlaute.txt')).status).toBe(200);
    expect((await read('umlaute.txt')).status).toBe(404);
  });

  it('löscht eine Datei', async () => {
    await owner.put(`${base()}/contents/texte/umlaute.txt`, {
      branch: 'main',
      message: 'Gelöscht',
      contentBase64: null,
    });

    expect((await read('texte/umlaute.txt')).status).toBe(404);
    // Die Nachbardatei darf davon nichts abbekommen.
    expect((await read('docs/anleitung.md')).status).toBe(200);
  });

  it('weist einen Pfad mit .. ab', async () => {
    const result = await owner.put(`${base()}/contents/../entwischt.txt`, {
      branch: 'main',
      message: 'Versuch',
      contentBase64: b64('x'),
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
  });

  it('verweigert Schreiben ohne Berechtigung', async () => {
    const result = await other.put(`${base()}/contents/fremd.txt`, {
      branch: 'main',
      message: 'Fremd',
      contentBase64: b64('x'),
    });
    expect([403, 404]).toContain(result.status);
    expect((await read('fremd.txt')).status).toBe(404);
  });

  it('weist einen veralteten Stand ab, statt ihn zu überschreiben', async () => {
    const result = await owner.put(`${base()}/contents/docs/anleitung.md`, {
      branch: 'main',
      message: 'Auf altem Stand',
      contentBase64: b64('überschrieben'),
      // Ein Stand, den es nie gab.
      expectedOid: '0'.repeat(40),
    });

    expect(result.status).toBe(422);
    const blob = await read('docs/anleitung.md');
    expect((blob.body as unknown as { content: string }).content).toContain('# Anleitung');
  });
});

// ---------------------------------------------------------------------------

describe('Mehrere Dateien in einem Commit', () => {
  it('schreibt alle Dateien und erzeugt genau einen Commit', async () => {
    const before = await owner.get(`${base()}/commits?limit=1`);
    const beforeOid = (before.body as unknown as { items: { oid: string }[] }).items[0]!.oid;

    const result = await owner.post(`${base()}/contents`, {
      branch: 'main',
      message: 'Drei Dateien',
      changes: [
        { path: 'ablage/eins.txt', contentBase64: b64('eins') },
        { path: 'ablage/zwei.txt', contentBase64: b64('zwei') },
        { path: 'ablage/drei/tief.txt', contentBase64: b64('drei') },
      ],
    });

    expect(result.status).toBe(200);
    expect((result.body as unknown as { fileCount: number }).fileCount).toBe(3);

    expect((await read('ablage/eins.txt')).status).toBe(200);
    expect((await read('ablage/zwei.txt')).status).toBe(200);
    expect((await read('ablage/drei/tief.txt')).status).toBe(200);

    // Genau ein Commit zwischen vorher und nachher.
    const after = await owner.get(`${base()}/commits?limit=2`);
    const items = (after.body as unknown as { items: { oid: string; subject: string }[] }).items;
    expect(items[0]!.subject).toBe('Drei Dateien');
    expect(items[1]!.oid).toBe(beforeOid);
  });

  it('überträgt Binärinhalte unverfälscht', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 0, 255]);

    await owner.post(`${base()}/contents`, {
      branch: 'main',
      message: 'Binärdatei',
      changes: [{ path: 'ablage/daten.bin', contentBase64: bytes.toString('base64') }],
    });

    const blob = await read('ablage/daten.bin');
    expect(blob.status).toBe(200);
    // Binäres kommt nicht als Text zurück, wird aber als solches erkannt.
    expect((blob.body as unknown as { isBinary: boolean }).isBinary).toBe(true);
  });

  it('löscht und schreibt in derselben Übertragung', async () => {
    await owner.post(`${base()}/contents`, {
      branch: 'main',
      message: 'Aufgeräumt',
      changes: [
        { path: 'ablage/eins.txt', contentBase64: null },
        { path: 'ablage/vier.txt', contentBase64: b64('vier') },
      ],
    });

    expect((await read('ablage/eins.txt')).status).toBe(404);
    expect((await read('ablage/vier.txt')).status).toBe(200);
    expect((await read('ablage/zwei.txt')).status).toBe(200);
  });

  it('weist denselben Pfad zweimal ab', async () => {
    const result = await owner.post(`${base()}/contents`, {
      branch: 'main',
      message: 'Doppelt',
      changes: [
        { path: 'doppelt.txt', contentBase64: b64('a') },
        { path: 'doppelt.txt', contentBase64: b64('b') },
      ],
    });

    expect(result.status).toBe(422);
    // Kein halber Commit: die Datei darf gar nicht entstanden sein.
    expect((await read('doppelt.txt')).status).toBe(404);
  });

  it('weist eine zu große Übertragung ab', async () => {
    const big = 'x'.repeat(7 * 1024 * 1024);
    const result = await owner.post(`${base()}/contents`, {
      branch: 'main',
      message: 'Zu groß',
      changes: [{ path: 'gross.txt', contentBase64: b64(big) }],
    });

    // 413 aus der Prüfung, oder 413 von Fastify wegen bodyLimit – beides ist
    // eine Ablehnung, und beides ist richtig.
    expect(result.status).toBe(413);
    expect((await read('gross.txt')).status).toBe(404);
  });

  it('verweigert den Stapel ohne Berechtigung', async () => {
    const result = await other.post(`${base()}/contents`, {
      branch: 'main',
      message: 'Fremd',
      changes: [{ path: 'fremd-stapel.txt', contentBase64: b64('x') }],
    });

    expect([403, 404]).toContain(result.status);
    expect((await read('fremd-stapel.txt')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('Neuer Branch', () => {
  it('legt den Branch an und lässt den Ausgangsbranch unberührt', async () => {
    const result = await owner.put(`${base()}/contents/nur-im-zweig.txt`, {
      branch: 'vorschlag',
      startBranch: 'main',
      message: 'Im Zweig angelegt',
      contentBase64: b64('nur hier'),
    });

    expect(result.status).toBe(200);
    expect((await read('nur-im-zweig.txt', 'vorschlag')).status).toBe(200);
    expect((await read('nur-im-zweig.txt', 'main')).status).toBe(404);

    // Der neue Branch setzt auf main auf, trägt also dessen Dateien mit.
    expect((await read('docs/anleitung.md', 'vorschlag')).status).toBe(200);
  });

  it('schreibt einen zweiten Commit auf denselben Branch', async () => {
    const result = await owner.post(`${base()}/contents`, {
      branch: 'vorschlag',
      startBranch: 'main',
      message: 'Noch etwas im Zweig',
      changes: [{ path: 'zweites.txt', contentBase64: b64('zwei') }],
    });

    expect(result.status).toBe(200);
    // Der erste Commit im Zweig bleibt erhalten – startBranch darf den
    // bestehenden Branch nicht zurücksetzen.
    expect((await read('nur-im-zweig.txt', 'vorschlag')).status).toBe(200);
    expect((await read('zweites.txt', 'vorschlag')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('Geschützter Branch', () => {
  it('lässt direktes Schreiben nicht zu, den Umweg über einen Branch aber schon', async () => {
    const protection = await owner.put(`${base()}/branch-protections`, {
      pattern: 'main',
      requirePullRequest: true,
    });
    expect(protection.status).toBeLessThan(300);

    const direct = await owner.put(`${base()}/contents/trotzdem.txt`, {
      branch: 'main',
      message: 'Direkt',
      contentBase64: b64('x'),
    });
    expect(direct.status).toBe(422);
    expect((await read('trotzdem.txt')).status).toBe(404);

    const viaBranch = await owner.put(`${base()}/contents/trotzdem.txt`, {
      branch: 'umweg',
      startBranch: 'main',
      message: 'Über einen Branch',
      contentBase64: b64('x'),
    });
    expect(viaBranch.status).toBe(200);
    expect((await read('trotzdem.txt', 'umweg')).status).toBe(200);
  });
});
