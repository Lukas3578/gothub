/**
 * Zentrale Konfiguration. Alle Werte stammen aus Umgebungsvariablen und werden
 * beim Start validiert – der Prozess startet nicht mit einer unvollständigen
 * oder unsicheren Konfiguration.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  ADDITIONAL_ALLOWED_ORIGINS,
  DEFAULT_PUBLIC_API_URL,
  DEFAULT_PUBLIC_WEB_URL,
  isSameHost,
} from './deployment.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

/** Minimaler .env-Loader (kein dotenv nötig, keine Shell-Expansion). */
function loadDotEnv(): void {
  for (const candidate of [resolve(repoRoot, '.env'), resolve(repoRoot, 'apps/api/.env')]) {
    if (!existsSync(candidate)) continue;
    const content = readFileSync(candidate, 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (key in process.env) continue; // echte Umgebungsvariablen haben Vorrang
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const booleanish = z
  .string()
  .transform((v) => v.toLowerCase() === 'true' || v === '1')
  .pipe(z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  FORGE_BRAND_NAME: z.string().min(1).default('Forge'),
  FORGE_BRAND_TAGLINE: z.string().default('Self-hosted developer platform'),

  /**
   * Viele Hosting-Anbieter – darunter Render – geben den Port über `PORT` vor
   * und erwarten, dass der Dienst genau dort lauscht. Wird dort ein anderer
   * Port belegt, gilt der Dienst als nicht erreichbar. `PORT` hat deshalb
   * Vorrang vor `API_PORT`.
   */
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  PUBLIC_API_URL: z.string().url().optional(),
  PUBLIC_WEB_URL: z.string().url().optional(),

  /**
   * libSQL-Adresse. Drei Formen sind gültig:
   *
   *   file:./data/forge.db          lokale Datei, kein Server nötig
   *   libsql://name-org.turso.io    Turso, zusammen mit TURSO_AUTH_TOKEN
   *   http://127.0.0.1:8080         lokaler sqld, etwa im Container
   */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL ist erforderlich'),
  /** Zugangstoken für Turso. Bei einer lokalen Datei nicht nötig. */
  TURSO_AUTH_TOKEN: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET muss mindestens 32 Zeichen lang sein (openssl rand -base64 48)'),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY muss 64 Hex-Zeichen lang sein (openssl rand -hex 32)'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  GIT_STORAGE_ROOT: z.string().default('./data/repositories'),
  GIT_MAX_PUSH_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024 * 1024),
  GIT_PROCESS_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  UPLOAD_STORAGE_ROOT: z.string().default('./data/uploads'),
  MAX_AVATAR_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),

  RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_AUTH_PER_15MIN: z.coerce.number().int().positive().default(10),

  MAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('Forge <noreply@example.com>'),

  /**
   * SSH ist standardmäßig aus. Auf Plattformen, die je Dienst genau einen
   * HTTP-Port veröffentlichen (Render, Heroku, Fly ohne eigene Portfreigabe),
   * ist der Dienst von außen ohnehin nicht erreichbar; ein Start würde nur
   * Fehler ins Protokoll schreiben.
   */
  SSH_ENABLED: booleanish.default('false'),
  SSH_PORT: z.coerce.number().int().min(1).max(65535).default(2222),
  SSH_HOST: z.string().default('0.0.0.0'),
  SSH_HOST_KEY_PATH: z.string().default('./data/ssh/host_key'),
  SSH_CLONE_HOST: z.string().default('localhost'),

  FIRST_USER_IS_ADMIN: booleanish.default('true'),
  ALLOW_REGISTRATION: booleanish.default('true'),
  MAINTENANCE_MODE: booleanish.default('false'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  console.error(
    `\nKonfigurationsfehler. Lege eine .env nach dem Muster von .env.example an.\n\n${issues}\n`,
  );
  process.exit(1);
}

const env = parsed.data;

// ---------------------------------------------------------------------------
// Abgeleitete Adressen
// ---------------------------------------------------------------------------

const stripSlash = (value: string): string => value.replace(/\/$/, '');

/**
 * Die öffentlichen Adressen stammen aus der Umgebung, sonst aus
 * deployment.ts. In der Entwicklung sind die localhost-Adressen gemeint,
 * deshalb greifen die Produktions-Vorgaben nur außerhalb von `development`.
 */
const publicApiUrl = stripSlash(
  env.PUBLIC_API_URL ??
    (env.NODE_ENV === 'development' ? 'http://localhost:4000' : DEFAULT_PUBLIC_API_URL),
);

const publicWebUrl = stripSlash(
  env.PUBLIC_WEB_URL ??
    (env.NODE_ENV === 'development' ? 'http://localhost:5173' : DEFAULT_PUBLIC_WEB_URL),
);

const allowedOrigins = [...new Set([publicWebUrl, ...ADDITIONAL_ALLOWED_ORIGINS])];

/**
 * Macht einen relativen `file:`-Pfad eindeutig.
 *
 * `file:./data/forge.db` ist relativ zum Arbeitsverzeichnis des Prozesses –
 * und das unterscheidet sich je nach Startweg: `npm run dev:api` startet in
 * `apps/api`, `npm start` in der Wurzel. Dieselbe Konfiguration zeigte so auf
 * zwei verschiedene Dateien, und der Server fand die migrierte Datenbank
 * nicht ("no such table: namespaces").
 *
 * Deshalb wird gegen die Wurzel des Projekts aufgelöst, genau wie beim
 * Git-Speicher und beim Upload-Verzeichnis. Absolute Pfade und entfernte
 * Adressen bleiben unangetastet.
 */
function resolveDatabaseUrl(url: string): string {
  if (!url.startsWith('file:')) return url;

  const path = url.slice('file:'.length);
  if (path.startsWith('/')) return url;

  return `file:${resolve(repoRoot, path)}`;
}

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',

  brand: {
    name: env.FORGE_BRAND_NAME,
    tagline: env.FORGE_BRAND_TAGLINE,
  },

  server: {
    port: env.PORT ?? env.API_PORT,
    host: env.API_HOST,
    publicApiUrl: publicApiUrl,
    publicWebUrl: publicWebUrl,
    /**
     * Alle Origins, die auf die API zugreifen dürfen. Die Frontend-Adresse
     * steht immer darin; die Zusatzliste erlaubt lokale Entwicklung.
     */
    allowedOrigins,
    /**
     * True, wenn Frontend und API auf verschiedenen Hosts liegen. In diesem
     * Fall gelten Anfragen des Frontends als Cross-Site, und Cookies brauchen
     * `SameSite=None; Secure` – siehe security.cookie.
     */
    isCrossSite: !isSameHost(publicApiUrl, publicWebUrl),
  },

  database: {
    url: resolveDatabaseUrl(env.DATABASE_URL),
    authToken: env.TURSO_AUTH_TOKEN,
  },
  redis: { url: env.REDIS_URL },

  security: {
    sessionSecret: env.SESSION_SECRET,
    encryptionKey: Buffer.from(env.ENCRYPTION_KEY, 'hex'),
    sessionTtlMs: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    /** Cookie-Name bewusst ohne Produktnamen, um Fingerprinting zu erschweren. */
    sessionCookieName: 'fg_session',
    csrfCookieName: 'fg_csrf',
    csrfHeaderName: 'x-forge-csrf',

    /**
     * Cookie-Eigenschaften, die für Session UND CSRF-Cookie gelten müssen.
     *
     * Liegen Frontend und API auf verschiedenen Hosts, sind die Anfragen des
     * Frontends Cross-Site. Ein Cookie mit `SameSite=Lax` wird dann bei
     * fetch-Aufrufen NICHT mitgesendet – der Benutzer wäre nach dem Login bei
     * jeder weiteren Anfrage wieder abgemeldet. Dafür ist `SameSite=None`
     * nötig, das der Browser nur zusammen mit `Secure` akzeptiert.
     *
     * Bei gleichem Host bleibt `Lax` die bessere Wahl: es schützt zusätzlich
     * gegen CSRF und funktioniert auch über http in der Entwicklung.
     *
     * Dass Cookies cross-site mitgesendet werden, macht den CSRF-Schutz nicht
     * überflüssig, sondern erst recht nötig – er steckt in middleware/context.ts.
     */
    cookie: (() => {
      const crossSite = !isSameHost(publicApiUrl, publicWebUrl);
      const production = env.NODE_ENV === 'production';
      return {
        sameSite: (crossSite && production ? 'none' : 'lax') as 'none' | 'lax',
        // SameSite=None gilt im Browser nur mit Secure. Ohne https wäre das
        // Cookie damit unbrauchbar, deshalb in der Entwicklung Lax + unsicher.
        secure: production,
        path: '/' as const,
      };
    })(),
  },

  git: {
    storageRoot: resolve(repoRoot, env.GIT_STORAGE_ROOT),
    maxPushBytes: env.GIT_MAX_PUSH_BYTES,
    processTimeoutMs: env.GIT_PROCESS_TIMEOUT_MS,
    /** Obergrenze für die Anzeige einer Datei im Browser. */
    maxBlobDisplayBytes: 1024 * 1024,
    /** Obergrenze für einen gerenderten Diff pro Datei. */
    maxDiffBytes: 512 * 1024,
  },

  uploads: {
    storageRoot: resolve(repoRoot, env.UPLOAD_STORAGE_ROOT),
    maxAvatarBytes: env.MAX_AVATAR_BYTES,
  },

  rateLimit: {
    globalPerMinute: env.RATE_LIMIT_GLOBAL_PER_MINUTE,
    authPer15Min: env.RATE_LIMIT_AUTH_PER_15MIN,
  },

  mail: {
    transport: env.MAIL_TRANSPORT,
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    from: env.MAIL_FROM,
  },

  ssh: {
    enabled: env.SSH_ENABLED,
    port: env.SSH_PORT,
    host: env.SSH_HOST,
    hostKeyPath: resolve(repoRoot, env.SSH_HOST_KEY_PATH),
    /** Adresse, die in Klon-URLs erscheint. */
    cloneHost: env.SSH_CLONE_HOST,
  },

  features: {
    firstUserIsAdmin: env.FIRST_USER_IS_ADMIN,
    allowRegistration: env.ALLOW_REGISTRATION,
    maintenanceMode: env.MAINTENANCE_MODE,
  },
} as const;

export type Config = typeof config;
