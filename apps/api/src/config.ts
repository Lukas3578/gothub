/**
 * Zentrale Konfiguration. Alle Werte stammen aus Umgebungsvariablen und werden
 * beim Start validiert – der Prozess startet nicht mit einer unvollständigen
 * oder unsicheren Konfiguration.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

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

  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL ist erforderlich'),
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

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',

  brand: {
    name: env.FORGE_BRAND_NAME,
    tagline: env.FORGE_BRAND_TAGLINE,
  },

  server: {
    port: env.API_PORT,
    host: env.API_HOST,
    publicApiUrl: env.PUBLIC_API_URL.replace(/\/$/, ''),
    publicWebUrl: env.PUBLIC_WEB_URL.replace(/\/$/, ''),
  },

  database: { url: env.DATABASE_URL },
  redis: { url: env.REDIS_URL },

  security: {
    sessionSecret: env.SESSION_SECRET,
    encryptionKey: Buffer.from(env.ENCRYPTION_KEY, 'hex'),
    sessionTtlMs: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    /** Cookie-Name bewusst ohne Produktnamen, um Fingerprinting zu erschweren. */
    sessionCookieName: 'fg_session',
    csrfCookieName: 'fg_csrf',
    csrfHeaderName: 'x-forge-csrf',
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
