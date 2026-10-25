import type { Config } from 'drizzle-kit';

/**
 * `turso` deckt beide Fälle ab: eine lokale `file:`-Datei und eine
 * `libsql://`-Adresse bei Turso. Der Dialekt ist derselbe, nur das Ziel
 * unterscheidet sich.
 */
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'turso',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'file:./data/forge.db',
    ...(process.env.TURSO_AUTH_TOKEN ? { authToken: process.env.TURSO_AUTH_TOKEN } : {}),
  },
  strict: true,
} satisfies Config;
