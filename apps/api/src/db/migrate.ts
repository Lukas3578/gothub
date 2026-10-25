/**
 * Führt ausstehende Migrationen aus und beendet sich.
 * Aufruf: npm run db:migrate
 *
 * Zwei Dinge sind hier wichtig für ein automatisches Deployment:
 *
 * 1. **Eine Sperre.** Startet der Dienst in mehreren Instanzen gleichzeitig –
 *    bei einem Rolling Deploy der Normalfall –, würden alle dieselbe
 *    Migration anwenden wollen. In PostgreSQL erledigte das ein Advisory
 *    Lock. libSQL kennt so etwas nicht, deshalb dient hier eine Tabelle als
 *    Sperre: `INSERT` auf einen festen Primärschlüssel gelingt genau einmal,
 *    alle weiteren Läufe scheitern an der Eindeutigkeit und warten.
 *
 *    Eine Sperre in einer Tabelle hat einen Haken, den eine Verbindungssperre
 *    nicht hat: stirbt der Prozess mitten im Lauf, bleibt sie stehen. Deshalb
 *    verfällt sie nach `LOCK_TIMEOUT_MS` und wird dann übernommen.
 *
 * 2. **Ein Exit-Code.** Schlägt die Migration fehl, muss der Prozess mit
 *    einem Fehler enden, damit das Deployment abbricht statt mit halb
 *    migrierter Datenbank zu starten.
 *
 * Migrationen sind in diesem Projekt ausschließlich additiv erzeugt
 * (`drizzle-kit generate`); sie löschen keine Daten.
 */

import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { closeDatabase, db, sqlClient } from './index.js';

/** Nach dieser Zeit gilt eine Sperre als verwaist. */
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
/** Solange wird auf eine fremde Sperre gewartet. */
const WAIT_TIMEOUT_MS = 6 * 60 * 1000;
const POLL_MS = 1000;

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const owner = `${process.pid}@${Date.now()}`;

async function ensureLockTable(): Promise<void> {
  await sqlClient.execute(
    `CREATE TABLE IF NOT EXISTS _forge_migration_lock (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       owner TEXT NOT NULL,
       acquired_at INTEGER NOT NULL
     )`,
  );
}

/** Versucht die Sperre zu nehmen; gibt zurück, ob es gelungen ist. */
async function tryAcquire(): Promise<boolean> {
  const now = Date.now();

  const inserted = await sqlClient.execute({
    sql: `INSERT INTO _forge_migration_lock (id, owner, acquired_at)
          VALUES (1, ?, ?)
          ON CONFLICT (id) DO UPDATE
            SET owner = excluded.owner, acquired_at = excluded.acquired_at
            WHERE _forge_migration_lock.acquired_at < ?`,
    args: [owner, now, now - LOCK_TIMEOUT_MS],
  });

  return inserted.rowsAffected > 0;
}

async function release(): Promise<void> {
  await sqlClient
    .execute({ sql: `DELETE FROM _forge_migration_lock WHERE owner = ?`, args: [owner] })
    .catch(() => {});
}

async function run(): Promise<void> {
  const start = Date.now();

  await ensureLockTable();

  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!(await tryAcquire())) {
    if (Date.now() > deadline) {
      throw new Error(
        'Eine andere Instanz migriert seit über sechs Minuten. Abbruch, statt parallel zu migrieren.',
      );
    }
    console.log('Eine andere Instanz migriert gerade – warte.');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  try {
    await migrate(db, { migrationsFolder });
    console.log(`Migrationen abgeschlossen in ${Date.now() - start} ms`);
  } finally {
    await release();
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
