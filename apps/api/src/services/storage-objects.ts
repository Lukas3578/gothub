/**
 * Ablage für hochgeladene Dateien: Release-Assets, Workflow-Artefakte,
 * Paketdateien.
 *
 * Die Dateien liegen unter einem Schlüssel, der aus einer zufälligen ID
 * gebildet wird – nie aus dem vom Benutzer gewählten Dateinamen. Damit kann
 * ein Name wie `../../etc/passwd` den Speicherbereich nicht verlassen, und
 * zwei gleichnamige Dateien überschreiben sich nicht gegenseitig.
 *
 * Der Originalname wird in der Datenbank gehalten und erst beim Download als
 * Content-Disposition gesetzt.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { config } from '../config.js';
import { payloadTooLarge, validationFailed } from '../lib/errors.js';

export interface StoredObject {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Bildet einen Speicherschlüssel.
 *
 * Form: <bereich>/<aa>/<bb>/<uuid>, mit Sharding wie bei den Repositories,
 * damit kein Verzeichnis unüberschaubar groß wird.
 */
function buildKey(area: string): string {
  const id = randomUUID();
  return `${area}/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
}

/** Löst einen Schlüssel in einen Pfad auf und prüft, dass er im Bereich bleibt. */
export function objectPath(storageKey: string): string {
  if (!/^[a-z-]+\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f-]{36}$/.test(storageKey)) {
    throw validationFailed('Ungültiger Speicherschlüssel.');
  }

  const root = resolve(config.uploads.storageRoot);
  const path = resolve(root, storageKey);

  if (!path.startsWith(root + sep)) {
    throw validationFailed('Ungültiger Speicherschlüssel.');
  }
  return path;
}

/**
 * Schreibt einen Stream in den Objektspeicher.
 *
 * Größe und Prüfsumme werden während des Schreibens berechnet, nicht
 * nachträglich – so wird die Datei nur einmal gelesen und die Obergrenze
 * greift, bevor die Platte volläuft.
 */
export async function storeStream(
  area: string,
  source: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<StoredObject> {
  const storageKey = buildKey(area);
  const path = objectPath(storageKey);
  await mkdir(dirname(path), { recursive: true });

  const hash = createHash('sha256');
  let size = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new Error('OBJECT_TOO_LARGE'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(source, meter, createWriteStream(path));
  } catch (error) {
    await rm(path, { force: true }).catch(() => {});
    if (error instanceof Error && error.message === 'OBJECT_TOO_LARGE') {
      throw payloadTooLarge(
        `Die Datei überschreitet die Obergrenze von ${Math.round(maxBytes / 1024 / 1024)} MB.`,
      );
    }
    throw error;
  }

  return { storageKey, sizeBytes: size, sha256: hash.digest('hex') };
}

export async function storeBuffer(area: string, buffer: Buffer): Promise<StoredObject> {
  const storageKey = buildKey(area);
  const path = objectPath(storageKey);
  await mkdir(dirname(path), { recursive: true });

  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, buffer);

  return {
    storageKey,
    sizeBytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

export async function deleteObject(storageKey: string): Promise<void> {
  await rm(objectPath(storageKey), { force: true }).catch(() => {});
}

export async function objectExists(storageKey: string): Promise<boolean> {
  try {
    await stat(objectPath(storageKey));
    return true;
  } catch {
    return false;
  }
}

/**
 * Bereinigt einen Dateinamen für die Auslieferung.
 *
 * Entfernt Pfadanteile und Steuerzeichen. Der Name wird nur im
 * Content-Disposition-Header verwendet; Anführungszeichen müssen weg, sonst
 * ließe sich der Header manipulieren.
 */
export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'download';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\x00-\x1f\x7f"\\]/g, '').slice(0, 200) || 'download';
}
