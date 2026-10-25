/**
 * Prüfung des Speicherorts beim Start.
 *
 * Hintergrund: Git-Repositories und Uploads liegen im Dateisystem, die
 * zugehörigen Datensätze in der Datenbank. Viele Plattformen – Render, Heroku,
 * Fly ohne Volume – geben einem Dienst ein **flüchtiges** Dateisystem: bei
 * jedem Deployment und jedem Neustart ist alles weg, was zur Laufzeit
 * geschrieben wurde. Die Datenbank überlebt, weil sie ein eigener Dienst ist.
 *
 * Das Ergebnis ist verwirrend: die Oberfläche zeigt Repositories an, aber
 * jeder Klon und jeder Dateibrowser scheitert. Diese Prüfung macht daraus eine
 * eindeutige Meldung im Protokoll, statt den Betreiber rätseln zu lassen.
 *
 * Beheben lässt sich das nur außerhalb des Codes: der Dienst braucht einen
 * dauerhaften Datenträger, und GIT_STORAGE_ROOT muss darauf zeigen.
 */

import { access, writeFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { repositoryPath } from '../git/storage.js';

export interface StorageReport {
  /** Verzeichnis ist vorhanden und beschreibbar. */
  writable: boolean;
  /** Anzahl Repositories in der Datenbank. */
  recordCount: number;
  /** Davon ohne Verzeichnis im Speicher. */
  missingCount: number;
  /** Beispiele fehlender Repositories, für die Meldung. */
  missingExamples: string[];
}

export async function checkRepositoryStorage(): Promise<StorageReport> {
  const report: StorageReport = {
    writable: false,
    recordCount: 0,
    missingCount: 0,
    missingExamples: [],
  };

  // 1. Ist der Speicherort überhaupt beschreibbar?
  try {
    const probe = join(config.git.storageRoot, `.schreibtest-${process.pid}`);
    await writeFile(probe, 'ok');
    await unlink(probe);
    report.writable = true;
  } catch {
    report.writable = false;
  }

  // 2. Gibt es Datensätze ohne zugehöriges Verzeichnis?
  //
  // Begrenzt auf 500 Einträge: die Prüfung soll den Start nicht verzögern.
  // Für eine klare Aussage genügt eine Stichprobe.
  const rows = await db
    .all(
      sql`SELECT r.id, n.name AS owner_name, r.name
          FROM repositories r
          JOIN namespaces n ON n.id = r.owner_namespace_id
          WHERE r.deleted_at IS NULL
          LIMIT 500`,
    )
    .catch(() => [] as unknown[]);

  const list = rows as unknown as { id: string; owner_name: string; name: string }[];
  report.recordCount = list.length;

  for (const row of list) {
    try {
      await access(join(repositoryPath(row.id), 'HEAD'), constants.R_OK);
    } catch {
      report.missingCount += 1;
      if (report.missingExamples.length < 5) {
        report.missingExamples.push(`${row.owner_name}/${row.name}`);
      }
    }
  }

  return report;
}

/**
 * Protokolliert das Ergebnis in einer Form, die den nächsten Schritt nennt.
 */
export function logStorageReport(
  report: StorageReport,
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
): void {
  if (!report.writable) {
    logger.error(
      `Der Git-Speicher unter ${config.git.storageRoot} ist nicht beschreibbar. ` +
        'Ohne ihn lassen sich keine Repositories anlegen. Prüfe die Schreibrechte ' +
        'oder setze GIT_STORAGE_ROOT auf einen beschreibbaren Pfad.',
    );
    return;
  }

  if (report.missingCount === 0) {
    logger.info(
      `Git-Speicher in Ordnung: ${report.recordCount} Repositories, alle vorhanden ` +
        `(${config.git.storageRoot}).`,
    );
    return;
  }

  logger.warn(
    [
      `${report.missingCount} von ${report.recordCount} Repositories haben keine Daten im Speicher.`,
      `Betroffen sind unter anderem: ${report.missingExamples.join(', ')}.`,
      '',
      'Typische Ursache: der Dienst läuft auf einem flüchtigen Dateisystem.',
      'Bei jedem Deployment wird es geleert, während die Datenbank bestehen bleibt.',
      '',
      'Abhilfe: dem Dienst einen dauerhaften Datenträger zuweisen und',
      'GIT_STORAGE_ROOT sowie UPLOAD_STORAGE_ROOT auf einen Pfad darauf setzen',
      `(aktuell: ${config.git.storageRoot}).`,
    ].join('\n'),
  );
}
