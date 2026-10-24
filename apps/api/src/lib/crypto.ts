/**
 * Kryptographische Primitive.
 *
 * Grundregeln, die hier durchgesetzt werden:
 *  - Tokens werden nur als SHA-256-Hash gespeichert. Ein Datenbankleck gibt
 *    einem Angreifer dadurch keine verwendbaren Sessions oder API-Tokens.
 *  - Vergleiche von Geheimnissen laufen immer in konstanter Zeit.
 *  - Verschlüsselung nutzt AES-256-GCM mit zufälliger IV und Authentifizierung.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Passwörter
// ---------------------------------------------------------------------------

/**
 * Argon2id-Parameter. Orientiert an den OWASP-Empfehlungen (19 MiB, 2 Runden,
 * Parallelität 1). Bewusst nicht konfigurierbar: ein zu schwach eingestellter
 * Wert in der .env wäre eine stille Sicherheitslücke.
 */
// Algorithm.Argon2id entspricht dem Wert 2. Die Konstante wird nicht
// importiert, weil es sich um ein ambient const enum handelt, das sich mit
// isolatedModules nicht zur Laufzeit auflösen lässt.
const ARGON_OPTIONS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTIONS);
}

/**
 * Prüft ein Passwort. Gibt bei fehlerhaftem Hash `false` zurück statt zu
 * werfen, damit ein korrupter Datensatz keine 500er-Antwort erzeugt, die
 * Rückschlüsse auf die Existenz des Accounts erlaubt.
 */
export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hashValue, plain, ARGON_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Verbrennt vergleichbare Rechenzeit wie eine echte Passwortprüfung.
 * Wird aufgerufen, wenn der Benutzer nicht existiert, damit die Antwortzeit
 * keine Auskunft darüber gibt, ob eine E-Mail registriert ist.
 */
export async function burnPasswordTime(): Promise<void> {
  await argonHash('forge-timing-equalizer', ARGON_OPTIONS);
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Erzeugt ein URL-sicheres Zufallstoken mit 256 Bit Entropie. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256-Hex eines Tokens. Für Tokens mit voller Entropie ausreichend. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Zeitkonstanter String-Vergleich. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // timingSafeEqual verlangt gleiche Länge; trotzdem einen Vergleich
    // durchführen, damit die Laufzeit nicht von der Länge abhängt.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Symmetrische Verschlüsselung (Workflow-Secrets, TOTP-Seeds, Webhook-Keys)
// ---------------------------------------------------------------------------

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Verschlüsselt einen Klartext mit AES-256-GCM.
 * Format: base64(iv | authTag | ciphertext)
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', config.security.encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Entschlüsselt einen mit `encryptSecret` erzeugten Wert.
 * Wirft, wenn der Authentifizierungs-Tag nicht passt – ein manipulierter
 * Datensatz darf nicht stillschweigend als gültig durchgehen.
 */
export function decryptSecret(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Verschlüsselter Wert ist zu kurz oder beschädigt');
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', config.security.encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Sonstiges
// ---------------------------------------------------------------------------

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Erzeugt Wiederherstellungscodes für die Zwei-Faktor-Authentifizierung.
 * Format: xxxxx-xxxxx (Crockford-Base32 ohne mehrdeutige Zeichen).
 */
export function generateRecoveryCodes(count = 10): string[] {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = randomBytes(10);
    let code = '';
    for (let j = 0; j < 10; j += 1) {
      code += alphabet[bytes[j]! % alphabet.length];
      if (j === 4) code += '-';
    }
    codes.push(code);
  }
  return codes;
}
