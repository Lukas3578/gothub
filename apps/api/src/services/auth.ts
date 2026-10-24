/**
 * Authentifizierung: Registrierung, Anmeldung, Sessions, Zwei-Faktor.
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { authenticator } from 'otplib';
import {
  NAME_PATTERN,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  RESERVED_NAMES,
  type Viewer,
} from '@forge/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import {
  apiTokens,
  namespaces,
  notificationSettings,
  sessions,
  users,
  verificationTokens,
} from '../db/schema.js';
import {
  burnPasswordTime,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '../lib/crypto.js';
import { conflict, forbidden, notFound, unauthenticated, validationFailed } from '../lib/errors.js';
import { sendMail } from './mail.js';
import { avatarUrl } from './avatars.js';

export interface AuthenticatedUser {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarPath: string | null;
  isAdmin: boolean;
  twoFactorEnabled: boolean;
  namespaceId: string;
}

// ---------------------------------------------------------------------------
// Registrierung
// ---------------------------------------------------------------------------

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
}

export async function registerUser(input: RegisterInput): Promise<AuthenticatedUser> {
  if (!config.features.allowRegistration) {
    throw forbidden('Die Registrierung ist auf dieser Instanz deaktiviert.');
  }

  const username = input.username.trim();
  const emailLower = input.email.trim().toLowerCase();

  const fieldErrors: Record<string, string[]> = {};

  if (!NAME_PATTERN.test(username)) {
    fieldErrors.username = [
      'Erlaubt sind Buchstaben, Ziffern sowie - und _ im Inneren, maximal 39 Zeichen.',
    ];
  } else if (RESERVED_NAMES.has(username.toLowerCase())) {
    fieldErrors.username = ['Dieser Name ist für die Plattform reserviert.'];
  }

  if (input.password.length < PASSWORD_MIN_LENGTH) {
    fieldErrors.password = [`Das Passwort muss mindestens ${PASSWORD_MIN_LENGTH} Zeichen haben.`];
  } else if (input.password.length > PASSWORD_MAX_LENGTH) {
    fieldErrors.password = [`Das Passwort darf höchstens ${PASSWORD_MAX_LENGTH} Zeichen haben.`];
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw validationFailed('Die Eingaben sind unvollständig oder ungültig.', fieldErrors);
  }

  const passwordHash = await hashPassword(input.password);

  // Die gesamte Anlage läuft in einer Transaktion: ohne sie könnte ein
  // Namespace ohne zugehörigen Benutzer zurückbleiben und den Namen blockieren.
  return db.transaction(async (tx) => {
    const existingName = await tx
      .select({ id: namespaces.id })
      .from(namespaces)
      .where(eq(namespaces.nameLower, username.toLowerCase()))
      .limit(1);
    if (existingName[0]) {
      throw conflict('Dieser Benutzername ist bereits vergeben.');
    }

    const existingEmail = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.emailLower, emailLower))
      .limit(1);
    if (existingEmail[0]) {
      throw conflict('Für diese E-Mail-Adresse existiert bereits ein Konto.');
    }

    const [namespace] = await tx
      .insert(namespaces)
      .values({ name: username, nameLower: username.toLowerCase(), kind: 'user' })
      .returning();

    // Der erste Account der Instanz wird Administrator, damit das
    // Admin-Dashboard ohne manuellen Datenbankeingriff erreichbar ist.
    const countRows = await tx.select({ count: sql<number>`count(*)::int` }).from(users);
    const isFirstUser = (countRows[0]?.count ?? 0) === 0;

    const [user] = await tx
      .insert(users)
      .values({
        namespaceId: namespace!.id,
        email: input.email.trim(),
        emailLower,
        passwordHash,
        isAdmin: isFirstUser && config.features.firstUserIsAdmin,
        emailVerified: false,
      })
      .returning();

    await tx.insert(notificationSettings).values({ userId: user!.id });

    return {
      id: user!.id,
      username: namespace!.name,
      email: user!.email,
      emailVerified: user!.emailVerified,
      displayName: user!.displayName,
      avatarPath: user!.avatarPath,
      isAdmin: user!.isAdmin,
      twoFactorEnabled: user!.twoFactorEnabled,
      namespaceId: namespace!.id,
    };
  });
}

// ---------------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------------

export interface LoginResult {
  status: 'ok' | 'two_factor_required';
  user?: AuthenticatedUser;
  /** Kurzlebiges Token, das den zweiten Faktor an den ersten bindet. */
  challengeToken?: string;
}

/**
 * Prüft Anmeldedaten. Der Login akzeptiert Benutzername oder E-Mail.
 *
 * Fehlermeldungen unterscheiden bewusst nicht zwischen "Benutzer existiert
 * nicht" und "falsches Passwort", und bei unbekanntem Benutzer wird dieselbe
 * Rechenzeit verbraucht wie bei einer echten Prüfung.
 */
export async function authenticate(identifier: string, password: string): Promise<LoginResult> {
  const value = identifier.trim().toLowerCase();

  const rows = await db
    .select({ user: users, username: namespaces.name })
    .from(users)
    .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
    .where(value.includes('@') ? eq(users.emailLower, value) : eq(namespaces.nameLower, value))
    .limit(1);

  const row = rows[0];
  if (!row) {
    await burnPasswordTime();
    throw unauthenticated('Benutzername oder Passwort ist falsch.');
  }

  const ok = await verifyPassword(row.user.passwordHash, password);
  if (!ok) {
    throw unauthenticated('Benutzername oder Passwort ist falsch.');
  }

  if (!row.user.isActive || row.user.suspendedAt) {
    throw forbidden(
      row.user.suspendedReason
        ? `Dieses Konto wurde gesperrt: ${row.user.suspendedReason}`
        : 'Dieses Konto wurde gesperrt.',
    );
  }

  const user: AuthenticatedUser = {
    id: row.user.id,
    username: row.username,
    email: row.user.email,
    emailVerified: row.user.emailVerified,
    displayName: row.user.displayName,
    avatarPath: row.user.avatarPath,
    isAdmin: row.user.isAdmin,
    twoFactorEnabled: row.user.twoFactorEnabled,
    namespaceId: row.user.namespaceId,
  };

  if (row.user.twoFactorEnabled) {
    // Der zweite Faktor wird über ein kurzlebiges Token gebunden, damit der
    // Client das Passwort nicht erneut senden muss.
    const challenge = generateToken(24);
    await db.insert(verificationTokens).values({
      userId: user.id,
      purpose: 'two_factor_challenge',
      tokenHash: hashToken(challenge),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    return { status: 'two_factor_required', challengeToken: challenge };
  }

  return { status: 'ok', user };
}

/** Löst eine Zwei-Faktor-Challenge mit TOTP-Code oder Wiederherstellungscode auf. */
export async function completeTwoFactor(
  challengeToken: string,
  code: string,
): Promise<AuthenticatedUser> {
  const tokenHash = hashToken(challengeToken);

  const rows = await db
    .select({ token: verificationTokens, user: users, username: namespaces.name })
    .from(verificationTokens)
    .innerJoin(users, eq(users.id, verificationTokens.userId))
    .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
    .where(
      and(
        eq(verificationTokens.tokenHash, tokenHash),
        eq(verificationTokens.purpose, 'two_factor_challenge'),
        isNull(verificationTokens.consumedAt),
        gt(verificationTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw unauthenticated('Die Anmeldung ist abgelaufen. Bitte erneut anmelden.');

  const normalized = code.replace(/\s/g, '').toUpperCase();
  let valid = false;

  if (row.user.twoFactorSecretEnc && /^\d{6}$/.test(normalized)) {
    const secret = decryptSecret(row.user.twoFactorSecretEnc);
    valid = authenticator.check(normalized, secret);
  }

  // Wiederherstellungscode: wird nach Verwendung entfernt.
  if (!valid && row.user.twoFactorRecoveryHashes.length > 0) {
    for (const stored of row.user.twoFactorRecoveryHashes) {
      if (await verifyPassword(stored, normalized)) {
        valid = true;
        await db
          .update(users)
          .set({
            twoFactorRecoveryHashes: row.user.twoFactorRecoveryHashes.filter((h) => h !== stored),
          })
          .where(eq(users.id, row.user.id));
        break;
      }
    }
  }

  if (!valid) throw unauthenticated('Der eingegebene Code ist ungültig.');

  await db
    .update(verificationTokens)
    .set({ consumedAt: new Date() })
    .where(eq(verificationTokens.id, row.token.id));

  return {
    id: row.user.id,
    username: row.username,
    email: row.user.email,
    emailVerified: row.user.emailVerified,
    displayName: row.user.displayName,
    avatarPath: row.user.avatarPath,
    isAdmin: row.user.isAdmin,
    twoFactorEnabled: row.user.twoFactorEnabled,
    namespaceId: row.user.namespaceId,
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ipAddress?: string | null },
): Promise<CreatedSession> {
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + config.security.sessionTtlMs);

  const [user] = await db
    .select({ credentialVersion: users.credentialVersion })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw notFound('Benutzer nicht gefunden.');

  const [session] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      credentialVersion: user.credentialVersion,
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
      ipAddress: meta.ipAddress?.slice(0, 45) ?? null,
      expiresAt,
    })
    .returning();

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));

  return { token, sessionId: session!.id, expiresAt };
}

/**
 * Löst ein Session-Token auf.
 *
 * Eine Session gilt nur, wenn sie nicht abgelaufen, nicht widerrufen und ihre
 * `credentialVersion` noch aktuell ist. Letzteres sorgt dafür, dass ein
 * Passwortwechsel alle anderen Sessions sofort ungültig macht.
 */
export async function resolveSession(
  token: string,
): Promise<{ user: AuthenticatedUser; sessionId: string } | null> {
  const rows = await db
    .select({ session: sessions, user: users, username: namespaces.name })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.session.credentialVersion !== row.user.credentialVersion) return null;
  if (!row.user.isActive || row.user.suspendedAt) return null;

  // lastSeenAt nur minütlich fortschreiben, um bei jedem Request einen
  // Schreibvorgang auf die Session-Tabelle zu vermeiden.
  if (Date.now() - row.session.lastSeenAt.getTime() > 60_000) {
    void db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.id, row.session.id))
      .catch(() => {});
  }

  return {
    sessionId: row.session.id,
    user: {
      id: row.user.id,
      username: row.username,
      email: row.user.email,
      emailVerified: row.user.emailVerified,
      displayName: row.user.displayName,
      avatarPath: row.user.avatarPath,
      isAdmin: row.user.isAdmin,
      twoFactorEnabled: row.user.twoFactorEnabled,
      namespaceId: row.user.namespaceId,
    },
  };
}

export async function revokeSession(sessionId: string, userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
}

export async function revokeAllSessionsExcept(userId: string, keepSessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        sql`${sessions.id} <> ${keepSessionId}`,
      ),
    );
}

// ---------------------------------------------------------------------------
// API-Tokens (auch für Git über HTTPS)
// ---------------------------------------------------------------------------

export async function resolveApiToken(token: string): Promise<AuthenticatedUser | null> {
  const rows = await db
    .select({ token: apiTokens, user: users, username: namespaces.name })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
    .where(and(eq(apiTokens.tokenHash, hashToken(token)), isNull(apiTokens.revokedAt)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.token.expiresAt && row.token.expiresAt < new Date()) return null;
  if (!row.user.isActive || row.user.suspendedAt) return null;

  void db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, row.token.id))
    .catch(() => {});

  return {
    id: row.user.id,
    username: row.username,
    email: row.user.email,
    emailVerified: row.user.emailVerified,
    displayName: row.user.displayName,
    avatarPath: row.user.avatarPath,
    isAdmin: row.user.isAdmin,
    twoFactorEnabled: row.user.twoFactorEnabled,
    namespaceId: row.user.namespaceId,
  };
}

export async function createApiToken(
  userId: string,
  name: string,
  expiresInDays: number | null,
): Promise<{ token: string; id: string }> {
  const token = `fgp_${generateToken(24)}`;
  const [created] = await db
    .insert(apiTokens)
    .values({
      userId,
      name,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 12),
      expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null,
    })
    .returning();
  return { token, id: created!.id };
}

// ---------------------------------------------------------------------------
// E-Mail-Verifizierung und Passwort-Reset
// ---------------------------------------------------------------------------

export async function issueEmailVerification(userId: string, email: string, username: string) {
  const token = generateToken(32);
  await db.insert(verificationTokens).values({
    userId,
    purpose: 'email_verification',
    tokenHash: hashToken(token),
    payload: email,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  const link = `${config.server.publicWebUrl}/verify-email?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: email,
    subject: `${config.brand.name}: E-Mail-Adresse bestätigen`,
    text: `Hallo ${username},\n\nbestätige deine E-Mail-Adresse über diesen Link:\n${link}\n\nDer Link ist 24 Stunden gültig.`,
  });
}

export async function consumeEmailVerification(token: string): Promise<void> {
  const rows = await db
    .select()
    .from(verificationTokens)
    .where(
      and(
        eq(verificationTokens.tokenHash, hashToken(token)),
        eq(verificationTokens.purpose, 'email_verification'),
        isNull(verificationTokens.consumedAt),
        gt(verificationTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const record = rows[0];
  if (!record) throw validationFailed('Der Bestätigungslink ist ungültig oder abgelaufen.');

  await db.transaction(async (tx) => {
    await tx
      .update(verificationTokens)
      .set({ consumedAt: new Date() })
      .where(eq(verificationTokens.id, record.id));
    await tx.update(users).set({ emailVerified: true }).where(eq(users.id, record.userId));
  });
}

/**
 * Startet einen Passwort-Reset. Gibt immer ohne Fehler zurück, auch wenn die
 * Adresse unbekannt ist – sonst lässt sich die Nutzerdatenbank abfragen.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const rows = await db
    .select({ user: users, username: namespaces.name })
    .from(users)
    .innerJoin(namespaces, eq(namespaces.id, users.namespaceId))
    .where(eq(users.emailLower, email.trim().toLowerCase()))
    .limit(1);

  const row = rows[0];
  if (!row) return;

  const token = generateToken(32);
  await db.insert(verificationTokens).values({
    userId: row.user.id,
    purpose: 'password_reset',
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const link = `${config.server.publicWebUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: row.user.email,
    subject: `${config.brand.name}: Passwort zurücksetzen`,
    text: `Hallo ${row.username},\n\nsetze dein Passwort über diesen Link zurück:\n${link}\n\nDer Link ist eine Stunde gültig. Wenn du das nicht angefordert hast, ignoriere diese E-Mail.`,
  });
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    throw validationFailed('Das Passwort ist zu kurz.', {
      password: [`Mindestens ${PASSWORD_MIN_LENGTH} Zeichen.`],
    });
  }

  const rows = await db
    .select()
    .from(verificationTokens)
    .where(
      and(
        eq(verificationTokens.tokenHash, hashToken(token)),
        eq(verificationTokens.purpose, 'password_reset'),
        isNull(verificationTokens.consumedAt),
        gt(verificationTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const record = rows[0];
  if (!record) throw validationFailed('Der Link ist ungültig oder abgelaufen.');

  const passwordHash = await hashPassword(newPassword);

  await db.transaction(async (tx) => {
    await tx
      .update(verificationTokens)
      .set({ consumedAt: new Date() })
      .where(eq(verificationTokens.id, record.id));

    // credentialVersion hochzählen beendet alle bestehenden Sessions.
    await tx
      .update(users)
      .set({
        passwordHash,
        credentialVersion: sql`${users.credentialVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, record.userId));

    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, record.userId), isNull(sessions.revokedAt)));
  });
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionId: string,
): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw notFound('Benutzer nicht gefunden.');

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw validationFailed('Das aktuelle Passwort ist falsch.', {
      currentPassword: ['Falsches Passwort.'],
    });
  }
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    throw validationFailed('Das neue Passwort ist zu kurz.', {
      newPassword: [`Mindestens ${PASSWORD_MIN_LENGTH} Zeichen.`],
    });
  }

  const passwordHash = await hashPassword(newPassword);

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        passwordHash,
        credentialVersion: sql`${users.credentialVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    // Alle Sessions beenden, außer der aktuellen – sonst würde sich der
    // Benutzer durch die Passwortänderung selbst ausloggen.
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(sessions.userId, userId), isNull(sessions.revokedAt), sql`${sessions.id} <> ${keepSessionId}`),
      );

    await tx
      .update(sessions)
      .set({ credentialVersion: sql`${sessions.credentialVersion} + 1` })
      .where(eq(sessions.id, keepSessionId));
  });
}

// ---------------------------------------------------------------------------
// Zwei-Faktor-Einrichtung
// ---------------------------------------------------------------------------

export async function beginTwoFactorSetup(
  userId: string,
  username: string,
): Promise<{ secret: string; otpauthUrl: string }> {
  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri(username, config.brand.name, secret);

  // Der Seed wird verschlüsselt abgelegt, aber twoFactorEnabled bleibt false,
  // bis der Benutzer einen gültigen Code eingegeben hat.
  await db
    .update(users)
    .set({ twoFactorSecretEnc: encryptSecret(secret), twoFactorEnabled: false })
    .where(eq(users.id, userId));

  return { secret, otpauthUrl };
}

export async function confirmTwoFactorSetup(userId: string, code: string): Promise<string[]> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.twoFactorSecretEnc) {
    throw validationFailed('Die Einrichtung wurde nicht gestartet.');
  }

  const secret = decryptSecret(user.twoFactorSecretEnc);
  if (!authenticator.check(code.replace(/\s/g, ''), secret)) {
    throw validationFailed('Der Code ist ungültig.', { code: ['Ungültiger Code.'] });
  }

  const recoveryCodes = generateRecoveryCodes();
  const hashes = await Promise.all(recoveryCodes.map((c) => hashPassword(c)));

  await db
    .update(users)
    .set({ twoFactorEnabled: true, twoFactorRecoveryHashes: hashes })
    .where(eq(users.id, userId));

  return recoveryCodes;
}

export async function disableTwoFactor(userId: string, password: string): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw notFound('Benutzer nicht gefunden.');
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw validationFailed('Das Passwort ist falsch.', { password: ['Falsches Passwort.'] });
  }

  await db
    .update(users)
    .set({ twoFactorEnabled: false, twoFactorSecretEnc: null, twoFactorRecoveryHashes: [] })
    .where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------------

export function toViewer(user: AuthenticatedUser): Viewer {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: avatarUrl(user.avatarPath),
    email: user.email,
    emailVerified: user.emailVerified,
    isAdmin: user.isAdmin,
    twoFactorEnabled: user.twoFactorEnabled,
  };
}
