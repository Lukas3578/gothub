/**
 * Datenbankverbindung. Eine einzige Pool-Instanz pro Prozess – Fastify-Routen
 * und Hintergrundjobs teilen sie sich.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config.js';
import * as schema from './schema.js';

const client = postgres(config.database.url, {
  max: config.isTest ? 4 : 20,
  idle_timeout: 20,
  connect_timeout: 10,
  // Verhindert, dass Drizzle Werte aus parametrisierten Queries interpoliert.
  prepare: true,
  onnotice: () => {},
});

export const db = drizzle(client, { schema, logger: false });
export const sqlClient = client;
export { schema };

export type Database = typeof db;

/** Schließt den Pool geordnet – wird vom Shutdown-Handler aufgerufen. */
export async function closeDatabase(): Promise<void> {
  await client.end({ timeout: 5 });
}
