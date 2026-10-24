/**
 * Integrationstests für Wiki, Gists, Projektboards, Profilbilder,
 * SSH-Schlüssel und die npm-Registry.
 *
 * Wie die übrigen Suiten gegen eine echte Datenbank und echte Git-Repositories.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { inArray, like } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { db } from '../db/index.js';
import { gists, namespaces, repositories, users } from '../db/schema.js';
import { config } from '../config.js';
import { parsePublicKey } from '../services/ssh-keys.js';
import { slugify, titleFromSlug } from '../services/wiki.js';

const RUN_ID = Math.random().toString(36).slice(2, 8);
const ANNA = `x${RUN_ID}anna`;
const BEN = `x${RUN_ID}ben`;
const REPO = 'wissen';

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
    return { status: response.statusCode, body: parsed, headers: response.headers, raw: response.rawPayload };
  }

  get = (path: string) => this.request('GET', path);
  post = (path: string, body?: unknown, headers?: Record<string, string>) =>
    this.request('POST', path, body, headers);
  patch = (path: string, body?: unknown) => this.request('PATCH', path, body);
  put = (path: string, body?: unknown, headers?: Record<string, string>) =>
    this.request('PUT', path, body, headers);
  delete = (path: string, body?: unknown) => this.request('DELETE', path, body);

  async bootstrap(): Promise<void> {
    await this.get('/api/v1/meta');
  }
}

let anna: Client;
let ben: Client;
let anon: Client;

/** Erzeugt ein gültiges, minimales PNG ohne externe Abhängigkeit. */
function makePng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crcTable: number[] = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, crcBuffer]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const raw = Buffer.from([0x00, 0xe2, 0x8a, 0x36]);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Baut einen gültigen OpenSSH-Public-Key-Blob für einen ed25519-Schlüssel. */
function makeSshPublicKey(): { line: string; fingerprint: string } {
  const { publicKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Die letzten 32 Byte der SPKI-Kodierung sind der rohe Schlüssel.
  const rawKey = publicKey.subarray(publicKey.length - 32);

  const typeName = Buffer.from('ssh-ed25519', 'ascii');
  const blob = Buffer.concat([
    lengthPrefixed(typeName),
    lengthPrefixed(rawKey),
  ]);

  return {
    line: `ssh-ed25519 ${blob.toString('base64')} test@forge`,
    fingerprint: createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''),
  };
}

function lengthPrefixed(data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

beforeAll(async () => {
  app = await buildApp();

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
}, 90_000);

afterAll(async () => {
  const testNamespaces = await db
    .select({ id: namespaces.id })
    .from(namespaces)
    .where(like(namespaces.nameLower, `x${RUN_ID}%`));

  const ids = testNamespaces.map((n) => n.id);
  if (ids.length > 0) {
    const testUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.namespaceId, ids));

    const userIds = testUsers.map((u) => u.id);
    if (userIds.length > 0) {
      await db.delete(gists).where(inArray(gists.ownerId, userIds));
    }

    await db.delete(repositories).where(inArray(repositories.ownerNamespaceId, ids));
    await db.delete(users).where(inArray(users.namespaceId, ids));
    await db.delete(namespaces).where(inArray(namespaces.id, ids));
  }

  await app.close();
}, 30_000);

const path = () => `/api/v1/repos/${ANNA}/${REPO}`;

// ---------------------------------------------------------------------------

describe('Wiki', () => {
  it('legt eine Seite an und liest sie zurück', async () => {
    const created = await anna.put(`${path()}/wiki/pages/Erste-Schritte`, {
      content: '# Erste Schritte\n\nSo geht es los.\n',
      message: 'Seite angelegt',
    });
    expect(created.status).toBe(200);
    expect(created.body.commitOid).toMatch(/^[0-9a-f]{40}$/);

    const read = await anna.get(`${path()}/wiki/pages/Erste-Schritte`);
    expect(read.body.content).toContain('So geht es los.');
    expect(read.body.title).toBe('Erste Schritte');
  });

  it('listet Seiten mit ihrem letzten Commit', async () => {
    await anna.put(`${path()}/wiki/pages/Konfiguration`, { content: '# Konfiguration\n' });

    const list = await anna.get(`${path()}/wiki/pages`);
    const titles = list.body.items.map((item: any) => item.title);
    expect(titles).toContain('Erste Schritte');
    expect(titles).toContain('Konfiguration');
    expect(list.body.items[0].lastCommit.oid).toMatch(/^[0-9a-f]{40}$/);
  });

  it('lässt Fremde ohne Schreibrecht keine Seite anlegen', async () => {
    const result = await ben.put(`${path()}/wiki/pages/Fremd`, { content: 'x' });
    expect(result.status).toBe(403);
  });

  it('erlaubt Fremden das Lesen eines öffentlichen Wikis', async () => {
    const result = await anon.get(`${path()}/wiki/pages/Erste-Schritte`);
    expect(result.status).toBe(200);
  });

  it('verhindert, dass ein Seitenname den Speicher verlässt', () => {
    // Pfadtrenner werden entfernt, nicht ersetzt: aus "../../boese" wird
    // "boese" – eine normale Seite, kein Pfad nach außen.
    expect(slugify('../../boese')).toBe('boese');
    expect(slugify('a/b/c')).toBe('abc');
    expect(() => slugify('///')).toThrow();
    expect(() => slugify('...')).toThrow();
  });

  it('macht die Umwandlung für die Anzeige rückgängig', () => {
    expect(titleFromSlug(slugify('Erste Schritte'))).toBe('Erste Schritte');
  });

  it('weist eine Änderung auf veraltetem Stand ab', async () => {
    const result = await anna.put(`${path()}/wiki/pages/Erste-Schritte`, {
      content: 'neu',
      expectedOid: '0000000000000000000000000000000000000000',
    });
    expect(result.status).toBe(422);
  });

  it('löscht eine Seite', async () => {
    await anna.put(`${path()}/wiki/pages/Wegwerf`, { content: 'x' });
    const removed = await anna.delete(`${path()}/wiki/pages/Wegwerf`);
    expect(removed.status).toBe(200);

    const read = await anna.get(`${path()}/wiki/pages/Wegwerf`);
    expect(read.status).toBe(404);
  });
});

describe('Gists', () => {
  let gistId: string;

  it('legt einen Gist mit mehreren Dateien an', async () => {
    const created = await anna.post('/api/v1/gists', {
      description: 'Zwei Schnipsel',
      isPublic: true,
      files: [
        { filename: 'hallo.ts', content: 'export const x = 1;\n' },
        { filename: 'notiz.md', content: '# Notiz\n' },
      ],
    });

    expect(created.status).toBe(201);
    expect(created.body.fileCount).toBe(2);
    expect(created.body.primaryLanguage).toBe('TypeScript');
    expect(created.body.files.map((f: any) => f.filename)).toEqual(['hallo.ts', 'notiz.md']);

    gistId = created.body.id;
  });

  it('weist Verzeichnisse im Dateinamen ab', async () => {
    const result = await anna.post('/api/v1/gists', {
      files: [{ filename: '../../boese.sh', content: 'rm -rf /' }],
    });
    expect(result.status).toBe(422);
  });

  it('verlangt mindestens eine Datei', async () => {
    const result = await anna.post('/api/v1/gists', { files: [] });
    expect(result.status).toBe(422);
  });

  it('ersetzt beim Bearbeiten den gesamten Dateisatz', async () => {
    await anna.patch(`/api/v1/gists/${gistId}`, {
      files: [{ filename: 'hallo.ts', content: 'export const x = 2;\n' }],
    });

    const read = await anna.get(`/api/v1/gists/${gistId}`);
    expect(read.body.files).toHaveLength(1);
    expect(read.body.files[0].content).toContain('= 2');
  });

  it('lässt Fremde einen Gist nicht ändern oder löschen', async () => {
    const patched = await ben.patch(`/api/v1/gists/${gistId}`, { description: 'übernommen' });
    expect(patched.status).toBe(403);

    const removed = await ben.delete(`/api/v1/gists/${gistId}`);
    expect(removed.status).toBe(403);
  });

  it('listet nicht gelistete Gists nicht für Fremde', async () => {
    const privateGist = await anna.post('/api/v1/gists', {
      isPublic: false,
      files: [{ filename: 'intern.txt', content: 'intern' }],
    });

    const forOthers = await ben.get(`/api/v1/gists?owner=${ANNA}`);
    const ids = forOthers.body.items.map((item: any) => item.id);
    expect(ids).not.toContain(privateGist.body.id);

    // Der Eigentümer sieht ihn.
    const forOwner = await anna.get(`/api/v1/gists?owner=${ANNA}`);
    expect(forOwner.body.items.map((item: any) => item.id)).toContain(privateGist.body.id);
  });

  it('schaltet einen Stern um, statt ihn zu verdoppeln', async () => {
    const on = await ben.put(`/api/v1/gists/${gistId}/star`);
    expect(on.body.starCount).toBe(1);

    const again = await ben.put(`/api/v1/gists/${gistId}/star`);
    expect(again.body.starCount).toBe(1);

    const off = await ben.delete(`/api/v1/gists/${gistId}/star`);
    expect(off.body.starCount).toBe(0);
  });

  it('speichert Kommentare', async () => {
    const created = await ben.post(`/api/v1/gists/${gistId}/comments`, { body: 'Nützlich.' });
    expect(created.status).toBe(201);

    const list = await anon.get(`/api/v1/gists/${gistId}/comments`);
    expect(list.body.items.map((item: any) => item.body)).toContain('Nützlich.');
  });
});

describe('Projektboards', () => {
  let boardNumber: number;
  let columnId: string;

  it('legt ein Board mit Standardspalten an', async () => {
    const created = await anna.post(`${path()}/projects`, { name: 'Fahrplan' });
    expect(created.status).toBe(201);
    boardNumber = created.body.number;

    const detail = await anna.get(`${path()}/projects/${boardNumber}`);
    expect(detail.body.columns.map((column: any) => column.name)).toEqual([
      'Offen',
      'In Arbeit',
      'Erledigt',
    ]);
    columnId = detail.body.columns[0].id;
  });

  it('legt eine Notizkarte an', async () => {
    const created = await anna.post(`${path()}/projects/${boardNumber}/columns/${columnId}/cards`, {
      note: 'Dokumentation schreiben',
    });
    expect(created.status).toBe(201);

    const detail = await anna.get(`${path()}/projects/${boardNumber}`);
    expect(detail.body.columns[0].cards[0].note).toBe('Dokumentation schreiben');
  });

  it('verknüpft ein Issue und lehnt eine fremde Nummer ab', async () => {
    const issue = await anna.post(`${path()}/issues`, { title: 'Aufgabe' });

    const linked = await anna.post(
      `${path()}/projects/${boardNumber}/columns/${columnId}/cards`,
      { issueNumber: issue.body.number },
    );
    expect(linked.status).toBe(201);

    const unknown = await anna.post(
      `${path()}/projects/${boardNumber}/columns/${columnId}/cards`,
      { issueNumber: 99999 },
    );
    expect(unknown.status).toBe(404);
  });

  it('verschiebt eine Karte in eine andere Spalte', async () => {
    const before = await anna.get(`${path()}/projects/${boardNumber}`);
    const card = before.body.columns[0].cards[0];
    const target = before.body.columns[1];

    const moved = await anna.post(`${path()}/projects/${boardNumber}/cards/${card.id}/move`, {
      columnId: target.id,
      afterCardId: null,
    });
    expect(moved.status).toBe(200);

    const after = await anna.get(`${path()}/projects/${boardNumber}`);
    const targetColumn = after.body.columns.find((column: any) => column.id === target.id);
    expect(targetColumn.cards.map((entry: any) => entry.id)).toContain(card.id);
  });

  it('lässt Fremde ohne Schreibrecht keine Karten anlegen', async () => {
    const result = await ben.post(
      `${path()}/projects/${boardNumber}/columns/${columnId}/cards`,
      { note: 'fremd' },
    );
    expect(result.status).toBe(403);
  });

  it('verlangt Notiz oder Issue', async () => {
    const result = await anna.post(
      `${path()}/projects/${boardNumber}/columns/${columnId}/cards`,
      {},
    );
    expect(result.status).toBe(422);
  });
});

describe('Profilbilder', () => {
  it('nimmt ein PNG an und liefert es unverändert aus', async () => {
    const png = makePng();

    const uploaded = await anna.post('/api/v1/user/avatar', png, { 'content-type': 'image/png' });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.avatarUrl).toContain('/media/avatars/');

    const key = uploaded.body.avatarUrl.split('/media/')[1];
    const served = await anna.get(`/media/${key}`);

    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(served.raw as Buffer, png)).toBe(0);
  });

  it('weist eine als PNG deklarierte HTML-Datei ab', async () => {
    // Der Typ wird an den ersten Bytes erkannt, nicht am Content-Type.
    const result = await anna.post(
      '/api/v1/user/avatar',
      Buffer.from('<html><script>alert(1)</script></html>'),
      { 'content-type': 'image/png' },
    );
    expect(result.status).toBe(422);
  });

  it('weist SVG ab', async () => {
    const result = await anna.post(
      '/api/v1/user/avatar',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      { 'content-type': 'image/png' },
    );
    expect(result.status).toBe(422);
  });
});

describe('SSH-Schlüssel', () => {
  it('nimmt einen gültigen Schlüssel an und berechnet den Fingerabdruck', async () => {
    const key = makeSshPublicKey();

    const created = await anna.post('/api/v1/user/ssh-keys', {
      title: 'Testschlüssel',
      key: key.line,
    });

    expect(created.status).toBe(201);
    expect(created.body.type).toBe('ssh-ed25519');
    expect(created.body.bits).toBe(256);
    expect(created.body.fingerprint).toBe(`SHA256:${key.fingerprint}`);
  });

  it('lehnt denselben Schlüssel ein zweites Mal ab', async () => {
    const key = makeSshPublicKey();
    await anna.post('/api/v1/user/ssh-keys', { title: 'A', key: key.line });

    // Auch bei einem anderen Konto: der Fingerabdruck ist global eindeutig,
    // sonst wäre die Zuordnung einer Verbindung mehrdeutig.
    const second = await ben.post('/api/v1/user/ssh-keys', { title: 'B', key: key.line });
    expect(second.status).toBe(409);
  });

  it('weist einen Schlüssel ab, dessen Typ nicht zum Inhalt passt', () => {
    const key = makeSshPublicKey();
    const manipulated = key.line.replace('ssh-ed25519', 'ssh-rsa');
    expect(() => parsePublicKey(manipulated)).toThrow(/gibt sich als/);
  });

  it('weist unsinnige Eingaben ab', () => {
    expect(() => parsePublicKey('')).toThrow();
    expect(() => parsePublicKey('nur-ein-wort')).toThrow();
    expect(() => parsePublicKey('ssh-dss AAAAB3NzaC1kc3M=')).toThrow(/nicht unterstützt/);
  });

  it('listet und entfernt Schlüssel', async () => {
    const list = await anna.get('/api/v1/user/ssh-keys');
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);

    const removed = await anna.delete(`/api/v1/user/ssh-keys/${list.body.items[0].id}`);
    expect(removed.status).toBe(200);
  });

  it('lässt einen fremden Schlüssel nicht löschen', async () => {
    const key = makeSshPublicKey();
    const created = await ben.post('/api/v1/user/ssh-keys', { title: 'Bens', key: key.line });

    const result = await anna.delete(`/api/v1/user/ssh-keys/${created.body.id}`);
    expect(result.status).toBe(404);
  });
});

describe('npm-Registry', () => {
  let token: string;

  beforeAll(async () => {
    const created = await anna.post('/api/v1/user/tokens', { name: 'npm' });
    token = created.body.token;
  });

  /** Minimaler Tarball-Ersatz; der Inhalt wird nicht entpackt. */
  const attachment = (name: string, version: string) => ({
    [`${name}-${version}.tgz`]: {
      data: Buffer.from('nicht wirklich ein tarball').toString('base64'),
      content_type: 'application/octet-stream',
    },
  });

  it('verlangt ein Zugriffstoken', async () => {
    const result = await anna.put(`/npm/@${ANNA}/paket`, {
      name: `@${ANNA}/paket`,
      versions: { '1.0.0': { name: `@${ANNA}/paket`, version: '1.0.0' } },
      _attachments: attachment(`@${ANNA}/paket`, '1.0.0'),
    });
    // Mit Cookie statt Token: abgelehnt.
    expect(result.status).toBe(403);
  });

  it('veröffentlicht ein Paket unter dem eigenen Scope', async () => {
    const result = await anon.put(
      `/npm/@${ANNA}/paket`,
      {
        name: `@${ANNA}/paket`,
        description: 'Testpaket',
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name: `@${ANNA}/paket`, version: '1.0.0' } },
        _attachments: attachment(`@${ANNA}/paket`, '1.0.0'),
        access: null,
      },
      { authorization: `Bearer ${token}` },
    );

    expect(result.status).toBe(201);
    expect(result.body.versions).toEqual(['1.0.0']);
  });

  it('liefert das packument mit dist-tags', async () => {
    const result = await anon.get(`/npm/@${ANNA}%2fpaket`);
    expect(result.status).toBe(200);
    expect(result.body['dist-tags'].latest).toBe('1.0.0');
    expect(Object.keys(result.body.versions)).toContain('1.0.0');
    expect(result.body.versions['1.0.0'].dist.tarball).toContain('/npm/');
  });

  it('lehnt das Überschreiben einer Version ab', async () => {
    const result = await anon.put(
      `/npm/@${ANNA}/paket`,
      {
        name: `@${ANNA}/paket`,
        versions: { '1.0.0': { name: `@${ANNA}/paket`, version: '1.0.0' } },
        _attachments: attachment(`@${ANNA}/paket`, '1.0.0'),
      },
      { authorization: `Bearer ${token}` },
    );
    expect(result.status).toBe(422);
  });

  it('lässt niemanden unter einem fremden Scope veröffentlichen', async () => {
    const bensToken = (await ben.post('/api/v1/user/tokens', { name: 'npm' })).body.token;

    const result = await anon.put(
      `/npm/@${ANNA}/geklaut`,
      {
        name: `@${ANNA}/geklaut`,
        versions: { '1.0.0': { name: `@${ANNA}/geklaut`, version: '1.0.0' } },
        _attachments: attachment(`@${ANNA}/geklaut`, '1.0.0'),
      },
      { authorization: `Bearer ${bensToken}` },
    );
    expect(result.status).toBe(403);
  });

  it('weist eine ungültige Version ab', async () => {
    const result = await anon.put(
      `/npm/@${ANNA}/paket`,
      {
        name: `@${ANNA}/paket`,
        versions: { 'nicht-semver': { name: `@${ANNA}/paket` } },
        _attachments: { [`@${ANNA}/paket-nicht-semver.tgz`]: { data: 'eA==' } },
      },
      { authorization: `Bearer ${token}` },
    );
    expect(result.status).toBe(422);
  });

  it('listet Pakete eines Besitzers mit Installationsbefehl', async () => {
    const result = await anon.get(`/api/v1/users/${ANNA}/packages`);
    const entry = result.body.items.find((item: any) => item.name === `@${ANNA}/paket`);
    expect(entry).toBeTruthy();
    expect(entry.installCommand).toContain('npm install');
    expect(entry.versions[0].version).toBe('1.0.0');
  });
});
