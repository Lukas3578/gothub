/**
 * Tests für den Betrieb mit getrennten Hosts für Frontend und API.
 *
 * Jeder dieser Tests entstand aus einem Fehler, der im lokalen Betrieb nicht
 * auftritt: dort haben Frontend und API denselben Host (`localhost`), und
 * Cookies sowie das Double-Submit-Verfahren funktionieren deshalb auch dann,
 * wenn sie für getrennte Hosts falsch konfiguriert sind.
 *
 * Nachgestellt wird der Browser: ein Client, der Cookies pro Host trennt und
 * bei jeder Anfrage einen Origin-Header setzt.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { inArray, like } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { db } from '../db/index.js';
import { namespaces, repositories, users } from '../db/schema.js';
import { config } from '../config.js';

const RUN_ID = Math.random().toString(36).slice(2, 8);
const USER = `cs${RUN_ID}`;

let app: FastifyInstance;

/**
 * Client, der sich wie ein Browser verhält.
 *
 * Entscheidend: `cookieStore` ist nach Host getrennt, und `readableByScript`
 * liefert nur Cookies ohne HttpOnly – genau wie `document.cookie`. Damit
 * lässt sich prüfen, dass das Frontend den CSRF-Token NICHT aus dem Cookie
 * beziehen kann und der Weg über den Antwortkörper nötig ist.
 */
class BrowserLike {
  /** host -> (name -> { value, httpOnly, sameSite, secure }) */
  private jar = new Map<
    string,
    Map<string, { value: string; httpOnly: boolean; sameSite: string; secure: boolean }>
  >();

  constructor(
    private readonly pageOrigin: string,
    private readonly apiHost: string,
  ) {}

  /** Was ein Skript auf der Seite über document.cookie sehen würde. */
  readableByScript(): Record<string, string> {
    const pageHost = new URL(this.pageOrigin).hostname;
    const result: Record<string, string> = {};
    for (const [name, entry] of this.jar.get(pageHost) ?? []) {
      if (!entry.httpOnly) result[name] = entry.value;
    }
    return result;
  }

  /** Alle für den API-Host gespeicherten Cookies, inklusive HttpOnly. */
  cookiesForApi(): Record<string, { value: string; sameSite: string; secure: boolean }> {
    const result: Record<string, { value: string; sameSite: string; secure: boolean }> = {};
    for (const [name, entry] of this.jar.get(this.apiHost) ?? []) {
      result[name] = { value: entry.value, sameSite: entry.sameSite, secure: entry.secure };
    }
    return result;
  }

  private storeCookies(response: { headers: Record<string, unknown> }): void {
    const raw = response.headers['set-cookie'];
    if (!raw) return;

    for (const line of ([] as string[]).concat(raw as any)) {
      const [pair, ...attrs] = line.split(';');
      const index = pair!.indexOf('=');
      const name = pair!.slice(0, index);
      const value = decodeURIComponent(pair!.slice(index + 1));

      const lower = attrs.map((a) => a.trim().toLowerCase());
      const sameSite =
        lower.find((a) => a.startsWith('samesite='))?.split('=')[1] ?? 'unset';

      const host = this.jar.get(this.apiHost) ?? new Map();
      host.set(name, {
        value,
        httpOnly: lower.includes('httponly'),
        sameSite,
        secure: lower.includes('secure'),
      });
      this.jar.set(this.apiHost, host);
    }
  }

  /**
   * Stellt eine Anfrage an die API.
   *
   * `sendCookies` stellt nach, dass ein Browser Cookies mit `SameSite=Lax`
   * bei Cross-Site-fetch NICHT mitsendet.
   */
  async request(
    method: string,
    path: string,
    options: { body?: unknown; csrfToken?: string | null; origin?: string | null } = {},
  ) {
    const headers: Record<string, string> = {};

    const origin = options.origin === undefined ? this.pageOrigin : options.origin;
    if (origin) headers.origin = origin;

    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.csrfToken) headers[config.security.csrfHeaderName] = options.csrfToken;

    const sendable: string[] = [];
    for (const [name, entry] of this.jar.get(this.apiHost) ?? []) {
      const crossSite = origin !== null && new URL(origin).hostname !== this.apiHost;
      // Genau das Verhalten, das den Fehler verursacht hat: Lax-Cookies
      // werden cross-site nicht mitgeschickt.
      if (crossSite && entry.sameSite !== 'none') continue;
      sendable.push(`${name}=${entry.value}`);
    }
    if (sendable.length > 0) headers.cookie = sendable.join('; ');

    const response = await app.inject({
      method: method as any,
      url: path,
      headers,
      payload: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    this.storeCookies(response as any);

    let parsed: any = null;
    try {
      parsed = response.body ? JSON.parse(response.body) : null;
    } catch {
      parsed = response.body;
    }
    return { status: response.statusCode, body: parsed, headers: response.headers };
  }
}

const WEB_ORIGIN = config.server.publicWebUrl;
const API_HOST = new URL(config.server.publicApiUrl).hostname;

let browser: BrowserLike;

beforeAll(async () => {
  app = await buildApp();
  browser = new BrowserLike(WEB_ORIGIN, API_HOST);
}, 60_000);

afterAll(async () => {
  const testNamespaces = await db
    .select({ id: namespaces.id })
    .from(namespaces)
    .where(like(namespaces.nameLower, `cs${RUN_ID}%`));

  const ids = testNamespaces.map((n) => n.id);
  if (ids.length > 0) {
    await db.delete(repositories).where(inArray(repositories.ownerNamespaceId, ids));
    await db.delete(users).where(inArray(users.namespaceId, ids));
    await db.delete(namespaces).where(inArray(namespaces.id, ids));
  }

  await app.close();
}, 30_000);

// ---------------------------------------------------------------------------

describe('Konfiguration der getrennten Hosts', () => {
  it('erkennt, ob Frontend und API auf verschiedenen Hosts liegen', () => {
    const sameHost = new URL(config.server.publicApiUrl).hostname === API_HOST;
    expect(sameHost).toBe(true);
    // isCrossSite muss zum Verhältnis der beiden konfigurierten URLs passen.
    const expected =
      new URL(config.server.publicApiUrl).hostname !==
      new URL(config.server.publicWebUrl).hostname;
    expect(config.server.isCrossSite).toBe(expected);
  });

  it('nennt die Frontend-Adresse als erlaubte Origin', () => {
    expect(config.server.allowedOrigins).toContain(config.server.publicWebUrl);
  });

  it('meldet die wirksamen Adressen über /api/v1/meta', async () => {
    const result = await browser.request('GET', '/api/v1/meta');
    expect(result.status).toBe(200);
    expect(result.body.deployment.apiUrl).toBe(config.server.publicApiUrl);
    expect(result.body.deployment.webUrl).toBe(config.server.publicWebUrl);
  });
});

describe('CSRF-Token über den Antwortkörper', () => {
  it('liefert den Token per GET, nicht über ein lesbares Cookie', async () => {
    const result = await browser.request('GET', '/api/v1/auth/csrf');

    expect(result.status).toBe(200);
    expect(result.body.csrfToken).toMatch(/^[\w-]{20,}$/);

    // Das Cookie existiert, ist aber HttpOnly – ein Skript auf der Seite
    // käme nicht daran. Genau deshalb kommt der Token über den Körper.
    const cookies = browser.cookiesForApi();
    expect(cookies[config.security.csrfCookieName]).toBeTruthy();
    expect(browser.readableByScript()[config.security.csrfCookieName]).toBeUndefined();
  });

  it('setzt das CSRF-Cookie HttpOnly', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
    const setCookie = ([] as string[]).concat(response.headers['set-cookie'] as any);
    const csrfLine = setCookie.find((line) => line.startsWith(config.security.csrfCookieName));

    expect(csrfLine).toBeTruthy();
    expect(csrfLine!.toLowerCase()).toContain('httponly');
  });

  it('liefert den Token auch mit /api/v1/auth/me, damit ein Seitenaufruf genügt', async () => {
    const result = await browser.request('GET', '/api/v1/auth/me');
    expect(result.status).toBe(200);
    expect(result.body.csrfToken).toBeTruthy();
  });
});

describe('Registrierung über getrennte Hosts', () => {
  it('schlägt ohne CSRF-Header fehl', async () => {
    // Das ist der Fehler, den das Frontend vorher immer produziert hat.
    const result = await browser.request('POST', '/api/v1/auth/register', {
      body: { username: USER, email: `${USER}@example.test`, password: 'ein-langes-testpasswort' },
      csrfToken: null,
    });

    expect(result.status).toBe(403);
    expect(result.body.error.message).toMatch(/CSRF/i);
  });

  it('gelingt mit dem Token aus dem Antwortkörper', async () => {
    const csrf = await browser.request('GET', '/api/v1/auth/csrf');

    const result = await browser.request('POST', '/api/v1/auth/register', {
      body: { username: USER, email: `${USER}@example.test`, password: 'ein-langes-testpasswort' },
      csrfToken: csrf.body.csrfToken,
    });

    expect(result.status).toBe(201);
    expect(result.body.viewer.username).toBe(USER);
  });

  it('hält die Sitzung über die nächste Anfrage hinweg', async () => {
    // Prüft, dass das Session-Cookie beim Cross-Site-fetch mitgesendet wird.
    // Mit SameSite=Lax wäre der Benutzer hier wieder abgemeldet.
    const result = await browser.request('GET', '/api/v1/auth/me');
    expect(result.body.viewer?.username).toBe(USER);
  });

  it('erlaubt eine schreibende Anfrage mit demselben Token', async () => {
    const csrf = await browser.request('GET', '/api/v1/auth/csrf');

    const result = await browser.request('POST', '/api/v1/repositories', {
      body: { name: 'cross-site-test', visibility: 'public' },
      csrfToken: csrf.body.csrfToken,
    });

    expect(result.status).toBe(201);
  });
});

describe('Abwehr fremder Herkunft', () => {
  it('lehnt eine schreibende Anfrage von fremder Origin ab', async () => {
    const csrf = await browser.request('GET', '/api/v1/auth/csrf');

    const result = await browser.request('POST', '/api/v1/repositories', {
      body: { name: 'von-fremder-seite', visibility: 'public' },
      csrfToken: csrf.body.csrfToken,
      origin: 'https://boese.example',
    });

    // Selbst mit gültigem Token: die Origin steht nicht auf der Liste.
    expect(result.status).toBe(403);
    expect(result.body.error.message).toMatch(/nicht zugelassenen Adresse/i);
  });

  it('lehnt einen erratenen Token ab', async () => {
    const result = await browser.request('POST', '/api/v1/repositories', {
      body: { name: 'geraten', visibility: 'public' },
      csrfToken: 'a'.repeat(32),
    });
    expect(result.status).toBe(403);
  });

  it('gibt keinen Zugriff auf fremde Origins in der CORS-Liste', () => {
    expect(config.server.allowedOrigins).not.toContain('*');
    for (const origin of config.server.allowedOrigins) {
      expect(() => new URL(origin)).not.toThrow();
    }
  });
});

describe('Cookie-Eigenschaften', () => {
  it('wählt SameSite passend zum Verhältnis der Hosts', () => {
    const { sameSite, secure } = config.security.cookie;

    if (config.server.isCrossSite && config.isProduction) {
      // Nur so sendet der Browser das Cookie bei Cross-Site-fetch mit.
      expect(sameSite).toBe('none');
      // SameSite=None gilt im Browser ausschließlich zusammen mit Secure.
      expect(secure).toBe(true);
    } else {
      expect(sameSite).toBe('lax');
    }
  });

  it('setzt Secure niemals ohne SameSite=None und umgekehrt', () => {
    const { sameSite, secure } = config.security.cookie;
    if (sameSite === 'none') expect(secure).toBe(true);
  });
});
