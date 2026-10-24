/**
 * Führt ausstehende Migrationen aus und beendet sich.
 * Aufruf: npm run db:migrate
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, closeDatabase } from './index.js';

const start = Date.now();
await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
console.log(`Migrationen abgeschlossen in ${Date.now() - start} ms`);
await closeDatabase();
