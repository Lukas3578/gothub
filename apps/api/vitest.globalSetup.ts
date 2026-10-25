/**
 * Richtet vor den Tests eine eigene Datenbank ein.
 *
 * Mit libSQL ist das eine Datei – kein Server, kein Container, kein
 * Aufräumen zwischen Läufen. Die Datei wird jedes Mal neu angelegt, damit
 * Tests auf einem bekannten Stand laufen und sich nicht gegenseitig über
 * liegengebliebene Zeilen beeinflussen.
 */

import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, 'data/test.db');

export default async function setup(): Promise<void> {
  process.env.DATABASE_URL = `file:${file}`;

  await mkdir(dirname(file), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(`${file}${suffix}`, { force: true });
  }

  const client = createClient({ url: `file:${file}` });
  await migrate(drizzle(client), { migrationsFolder: resolve(here, 'drizzle') });
  client.close();
}
