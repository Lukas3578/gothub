/**
 * Führt ausstehende Migrationen aus und beendet sich.
 * Aufruf: npm run db:migrate
 *
 * Zwei Dinge sind hier wichtig für ein automatisches Deployment:
 *
 * 1. Eine Sperre. Startet der Dienst in mehreren Instanzen gleichzeitig –
 *    bei einem Rolling Deploy der Normalfall –, würden alle Instanzen
 *    dieselbe Migration anwenden wollen. Drizzle führt Buch darüber, aber
 *    zwei gleichzeitige Läufe können sich beim Anlegen derselben Tabelle in
 *    die Quere kommen. Ein Advisory Lock in PostgreSQL serialisiert das:
 *    die erste Instanz migriert, die übrigen warten und finden danach nichts
 *    mehr zu tun.
 *
 * 2. Ein Exit-Code. Schlägt die Migration fehl, muss der Prozess mit einem
 *    Fehler enden, damit das Deployment abbricht statt mit halb migrierter
 *    Datenbank zu starten.
 *
 * Migrationen sind in diesem Projekt ausschließlich additiv erzeugt
 * (`drizzle-kit generate`); sie löschen keine Daten.
 */

import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { closeDatabase, db } from './index.js';

/**
 * Beliebige, aber feste Zahl. Alle Instanzen dieses Projekts verwenden
 * dieselbe, damit sie sich auf dieselbe Sperre beziehen.
 */
const LOCK_KEY = 4_075_112_001;

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

async function run(): Promise<void> {
  const start = Date.now();

  // Blockiert, bis die Sperre frei ist. Die Sperre ist an die Verbindung
  // gebunden und wird beim Schließen automatisch freigegeben – auch dann,
  // wenn der Prozess abstürzt.
  await db.execute(sql`SELECT pg_advisory_lock(${LOCK_KEY})`);

  try {
    await migrate(db, { migrationsFolder });
    console.log(`Migrationen abgeschlossen in ${Date.now() - start} ms`);
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${LOCK_KEY})`).catch(() => {});
  }
}

try {
  await run();
  await closeDatabase();
  process.exit(0);
} catch (error) {
  console.error('Migration fehlgeschlagen:', error);
  await closeDatabase().catch(() => {});
  // Exit-Code ungleich 0: das Deployment soll hier abbrechen.
  process.exit(1);
}
