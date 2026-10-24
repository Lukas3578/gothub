/**
 * Profilbilder für Benutzer und Organisationen.
 *
 * Zwei Dinge sind hier sicherheitsrelevant:
 *
 *  1. Der Dateityp wird an den ersten Bytes erkannt, nicht am mitgeschickten
 *     Content-Type. Sonst ließe sich eine HTML-Datei als `image/png`
 *     deklarieren und später im Kontext der Plattform ausliefern.
 *  2. Die Auslieferung erfolgt mit dem erkannten Typ, `nosniff` und einer
 *     restriktiven CSP – selbst wenn doch einmal etwas anderes durchkäme,
 *     würde der Browser es nicht als Dokument ausführen.
 */

import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { payloadTooLarge, validationFailed } from '../lib/errors.js';
import { deleteObject, objectPath, storeBuffer } from './storage-objects.js';

/** Erlaubte Bildformate mit ihrer Signatur. */
const SIGNATURES: { type: string; extension: string; test: (buffer: Buffer) => boolean }[] = [
  {
    type: 'image/png',
    extension: 'png',
    test: (b) =>
      b.length > 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    type: 'image/jpeg',
    extension: 'jpg',
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    type: 'image/gif',
    extension: 'gif',
    test: (b) => b.length > 6 && b.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/) !== null,
  },
  {
    type: 'image/webp',
    extension: 'webp',
    test: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

export interface StoredAvatar {
  storageKey: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Prüft und speichert ein Profilbild.
 *
 * SVG ist bewusst nicht zugelassen: eine SVG-Datei darf Skripte enthalten und
 * würde, im selben Ursprung ausgeliefert, zu einer XSS-Lücke führen.
 */
export async function storeAvatar(buffer: Buffer): Promise<StoredAvatar> {
  if (buffer.length === 0) {
    throw validationFailed('Die hochgeladene Datei ist leer.');
  }
  if (buffer.length > config.uploads.maxAvatarBytes) {
    throw payloadTooLarge(
      `Das Bild ist größer als ${Math.round(config.uploads.maxAvatarBytes / 1024)} KB.`,
    );
  }

  const match = SIGNATURES.find((signature) => signature.test(buffer));
  if (!match) {
    throw validationFailed(
      'Nur PNG, JPEG, GIF und WebP sind zulässig. SVG ist ausgeschlossen, weil es Skripte enthalten kann.',
    );
  }

  const stored = await storeBuffer('avatars', buffer);

  return {
    storageKey: stored.storageKey,
    contentType: match.type,
    sizeBytes: stored.sizeBytes,
  };
}

/** Liest ein gespeichertes Profilbild und erkennt seinen Typ erneut. */
export async function readAvatar(
  storageKey: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const buffer = await readFile(objectPath(storageKey));
    const match = SIGNATURES.find((signature) => signature.test(buffer));
    // Passt die Signatur nicht mehr, wird nichts ausgeliefert – lieber kein
    // Bild als eine Datei unbekannten Inhalts.
    if (!match) return null;
    return { buffer, contentType: match.type };
  } catch {
    return null;
  }
}

export async function removeAvatar(storageKey: string | null): Promise<void> {
  if (!storageKey) return;
  await deleteObject(storageKey).catch(() => {});
}

/**
 * Baut die öffentliche URL eines Profilbilds.
 *
 * Einziger Ort, an dem diese URL entsteht; alle Darstellungsschichten rufen
 * diese Funktion auf, damit ein Pfadwechsel nur hier anfällt.
 */
export function avatarUrl(storageKey: string | null | undefined): string | null {
  if (!storageKey) return null;
  return `${config.server.publicApiUrl}/media/${storageKey}`;
}
