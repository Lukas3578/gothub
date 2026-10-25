/**
 * Datenbankverbindung (libSQL / Turso).
 *
 * Ein Client pro Prozess – Fastify-Routen und Hintergrundjobs teilen ihn sich.
 *
 * libSQL ist SQLite mit einem Netzprotokoll davor. Das hat zwei Folgen, die
 * den Rest des Projekts betreffen:
 *
 * 1. **Ein Schreiber zur Zeit.** SQLite serialisiert Schreibzugriffe. Für
 *    Forge ist das unkritisch, weil die eigentliche Last – Commits, Trees,
 *    Packfiles – gar nicht in der Datenbank liegt, sondern im Dateisystem.
 *    In der Datenbank stehen nur Metadaten.
 *
 * 2. **Keine serverseitigen Sperren.** `pg_advisory_lock` gibt es nicht; die
 *    Migration serialisiert deshalb anders (siehe migrate.ts).
 *
 * Eine `file:`-Adresse braucht keinen Server und keinen Container. Das ist
 * der Grund, warum die Tests jetzt ohne laufende Datenbank auskommen.
 */

import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { config } from '../config.js';
import * as schema from './schema.js';

/** Ein Token ergibt nur bei einer entfernten Adresse Sinn. */
const isRemote = /^(libsql|wss?|https?):/.test(config.database.url);

const client: Client = createClient({
  url: config.database.url,
  ...(isRemote && config.database.authToken ? { authToken: config.database.authToken } : {}),
});

export const db = drizzle(client, { schema, logger: false });
export const sqlClient = client;
export { schema };

export type Database = typeof db;

/** Schließt die Verbindung geordnet – wird vom Shutdown-Handler aufgerufen. */
export async function closeDatabase(): Promise<void> {
  client.close();
}
