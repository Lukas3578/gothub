/**
 * Öffentliche SSH-Schlüssel: Einlesen, Fingerabdruck, Verwaltung.
 *
 * Ein Schlüssel wird im OpenSSH-Format erwartet, also so, wie er in
 * `~/.ssh/id_ed25519.pub` steht:
 *
 *     ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... kommentar
 *
 * Der Fingerabdruck ist der SHA-256-Hash des Base64-Teils, wie ihn auch
 * `ssh-keygen -lf` ausgibt. Er ist der Schlüssel, über den sich eine
 * eingehende Verbindung einem Konto zuordnen lässt.
 */

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { namespaces, sshKeys, users } from '../db/schema.js';
import { conflict, notFound, validationFailed } from '../lib/errors.js';

/**
 * Schlüsseltypen, die angenommen werden.
 *
 * DSA fehlt absichtlich: es gilt als überholt und ist in aktuellen
 * OpenSSH-Versionen bereits abgeschaltet. ssh-rsa mit SHA-1 wird vom Server
 * ebenfalls nicht als Signaturverfahren angeboten, der Schlüsseltyp selbst
 * ist aber in Ordnung, weil moderne Clients rsa-sha2-256/512 nutzen.
 */
const ACCEPTED_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

export interface ParsedPublicKey {
  type: string;
  base64: string;
  comment: string | null;
  fingerprint: string;
  /** Normalisierte Form ohne Kommentar, wie sie gespeichert wird. */
  normalized: string;
  bits: number | null;
}

/**
 * Zerlegt und prüft einen öffentlichen Schlüssel.
 *
 * Es wird nicht nur das Format geprüft, sondern auch, dass der im Base64-Teil
 * eingebettete Typname mit dem vorangestellten übereinstimmt – sonst ließe
 * sich ein Schlüssel als etwas anderes ausgeben, als er ist.
 */
export function parsePublicKey(input: string): ParsedPublicKey {
  const line = input.trim().split('\n')[0]?.trim() ?? '';
  if (!line) throw validationFailed('Der Schlüssel ist leer.');

  const parts = line.split(/\s+/);
  if (parts.length < 2) {
    throw validationFailed(
      'Das Format stimmt nicht. Erwartet wird der Inhalt einer .pub-Datei, etwa "ssh-ed25519 AAAA... kommentar".',
    );
  }

  const [type, base64, ...rest] = parts;

  if (!ACCEPTED_TYPES.has(type!)) {
    throw validationFailed(`Schlüssel vom Typ "${type}" werden nicht unterstützt.`);
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(base64!, 'base64');
  } catch {
    throw validationFailed('Der Schlüssel ist nicht korrekt Base64-kodiert.');
  }

  if (raw.length < 8 || raw.toString('base64').replace(/=+$/, '') !== base64!.replace(/=+$/, '')) {
    throw validationFailed('Der Schlüssel ist beschädigt.');
  }

  // Der Blob beginnt mit der Länge des Typnamens, gefolgt vom Typnamen selbst.
  const typeLength = raw.readUInt32BE(0);
  if (typeLength > 64 || raw.length < 4 + typeLength) {
    throw validationFailed('Der Schlüssel ist beschädigt.');
  }
  const embeddedType = raw.subarray(4, 4 + typeLength).toString('ascii');

  if (embeddedType !== type) {
    throw validationFailed(
      `Der Schlüssel gibt sich als "${type}" aus, enthält aber "${embeddedType}".`,
    );
  }

  const fingerprint = createHash('sha256').update(raw).digest('base64').replace(/=+$/, '');

  return {
    type: type!,
    base64: base64!,
    comment: rest.length > 0 ? rest.join(' ').slice(0, 200) : null,
    fingerprint,
    normalized: `${type} ${base64}`,
    bits: estimateBits(type!, raw, typeLength),
  };
}

/** Schlüssellänge, soweit sie sich ohne Kryptobibliothek ablesen lässt. */
function estimateBits(type: string, raw: Buffer, typeLength: number): number | null {
  if (type === 'ssh-ed25519') return 256;
  if (type.startsWith('ecdsa-sha2-nistp')) return Number(type.slice('ecdsa-sha2-nistp'.length));

  if (type === 'ssh-rsa') {
    try {
      // Nach Typname folgen Exponent und Modulus, jeweils längenpräfixiert.
      let offset = 4 + typeLength;
      const exponentLength = raw.readUInt32BE(offset);
      offset += 4 + exponentLength;
      const modulusLength = raw.readUInt32BE(offset);
      // Ein führendes Nullbyte markiert das Vorzeichen und zählt nicht mit.
      const leadingZero = raw[offset + 4] === 0 ? 1 : 0;
      return (modulusLength - leadingZero) * 8;
    } catch {
      return null;
    }
  }
  return null;
}

/** Anzeigeform des Fingerabdrucks, wie ssh-keygen sie ausgibt. */
export function formatFingerprint(fingerprint: string): string {
  return `SHA256:${fingerprint}`;
}

export async function addKey(
  userId: string,
  title: string,
  publicKey: string,
): Promise<{ id: string; fingerprint: string; type: string; bits: number | null }> {
  const parsed = parsePublicKey(publicKey);

  try {
    const [created] = await db
      .insert(sshKeys)
      .values({
        userId,
        title: title.trim().slice(0, 100) || (parsed.comment ?? 'Schlüssel'),
        fingerprint: parsed.fingerprint,
        publicKey: parsed.normalized,
      })
      .returning();

    return {
      id: created!.id,
      fingerprint: formatFingerprint(parsed.fingerprint),
      type: parsed.type,
      bits: parsed.bits,
    };
  } catch (error) {
    if (String(error).includes('ssh_keys_fingerprint_key')) {
      // Der Fingerabdruck ist global eindeutig. Wäre er es nur je Benutzer,
      // ließe sich derselbe Schlüssel bei zwei Konten hinterlegen und die
      // Zuordnung einer Verbindung wäre mehrdeutig.
      throw conflict('Dieser Schlüssel ist bereits hinterlegt – möglicherweise bei einem anderen Konto.');
    }
    throw error;
  }
}

export async function listKeys(userId: string) {
  const rows = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.userId, userId))
    .orderBy(sshKeys.createdAt);

  return rows.map((row) => {
    const parsed = (() => {
      try {
        return parsePublicKey(row.publicKey);
      } catch {
        return null;
      }
    })();

    return {
      id: row.id,
      title: row.title,
      fingerprint: formatFingerprint(row.fingerprint),
      type: parsed?.type ?? 'unbekannt',
      bits: parsed?.bits ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function removeKey(userId: string, keyId: string): Promise<void> {
  const deleted = await db
    .delete(sshKeys)
    .where(and(eq(sshKeys.id, keyId), eq(sshKeys.userId, userId)))
    .returning();

  if (deleted.length === 0) throw notFound('Schlüssel nicht gefunden.');
}

/**
 * Ordnet einen Fingerabdruck einem Konto zu.
 *
 * Wird vom SSH-Server bei der Anmeldung aufgerufen. Gesperrte Konten liefern
 * null, damit eine Sperre auch den Git-Zugang über SSH trifft.
 */
export async function findUserByFingerprint(fingerprint: string): Promise<{
  userId: string;
  username: string;
  email: string;
  isAdmin: boolean;
  keyId: string;
} | null> {
  const rows = await db
    .select({
      keyId: sshKeys.id,
      userId: users.id,
      username: namespaces.name,
      email: users.email,
      isAdmin: users.isAdmin,
      isActive: users.isActive,
      suspendedAt: users.suspendedAt,
    })
    .from(sshKeys)
    .innerJoin(users, eq(users.id, sshKeys.userId))
    .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
    .where(eq(sshKeys.fingerprint, fingerprint))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (!row.isActive || row.suspendedAt) return null;

  return {
    userId: row.userId,
    username: row.username,
    email: row.email,
    isAdmin: row.isAdmin,
    keyId: row.keyId,
  };
}

export async function markKeyUsed(keyId: string): Promise<void> {
  await db
    .update(sshKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(sshKeys.id, keyId))
    .catch(() => {});
}
