/**
 * Setzt die Git-Hooks in allen bestehenden Repositories neu.
 * Nötig nach einem Update, das die Hooks verändert hat.
 *
 * Aufruf: npx tsx src/scripts/install-hooks.ts
 */
import { isNull } from 'drizzle-orm';
import { db, closeDatabase } from '../db/index.js';
import { repositories } from '../db/schema.js';
import { installHooks } from '../git/hooks.js';

const rows = await db
  .select({ id: repositories.id, name: repositories.name })
  .from(repositories)
  .where(isNull(repositories.deletedAt));

let installed = 0;
for (const row of rows) {
  try {
    await installHooks(row.id);
    installed += 1;
  } catch (error) {
    console.error(`Hooks für ${row.name} fehlgeschlagen:`, error);
  }
}

console.log(`Hooks in ${installed} von ${rows.length} Repositories gesetzt.`);
await closeDatabase();
