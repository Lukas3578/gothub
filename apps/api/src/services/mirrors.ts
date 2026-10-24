/**
 * Spiegelung von Repositories auf andere Git-Hoster.
 *
 * Anlass: Werkzeuge, die diese Instanz nicht erreichen können. Der Sandkasten
 * vieler KI-Assistenten lässt nur eine feste Liste von Adressen zu – GitHub
 * gehört dazu, eine selbst betriebene Instanz nicht. Eine Spiegelung nach
 * GitHub macht das Projekt für solche Werkzeuge zugänglich, ohne dass hier
 * etwas geöffnet werden muss.
 *
 * Zwei Dinge sind hier sicherheitsrelevant:
 *
 * 1. Die Zieladresse kommt vom Benutzer. Ohne Prüfung wäre das eine
 *    SSRF-Lücke: ein Spiegel auf http://169.254.169.254/ würde
 *    Cloud-Metadaten abrufen. Geprüft wird die aufgelöste IP-Adresse, nicht
 *    nur der Hostname – dieselbe Prüfung wie bei Webhooks.
 *
 * 2. Das Zugangstoken darf nicht in den Prozessargumenten landen. Stünde es
 *    in der Remote-URL, wäre es für jeden sichtbar, der die Prozessliste
 *    lesen kann. Stattdessen wird es in eine temporäre Datei mit Rechten 0600
 *    geschrieben, die Git über `credential.helper=store --file=…` liest; in
 *    den Argumenten steht nur der Pfad.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { namespaces, repositories, repositoryMirrors } from '../db/schema.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { forbidden, notFound, validationFailed } from '../lib/errors.js';
import { runGit } from '../git/exec.js';
import { repositoryPath } from '../git/storage.js';
import { syncRepositoryMetadata } from './repository-metadata.js';
import { assertDeliverableUrl, isBlockedAddress } from './webhooks.js';

/** Ein einzelner Lauf darf nicht beliebig lange blockieren. */
const SYNC_TIMEOUT_MS = 10 * 60 * 1000;
/** Solange gilt ein laufender Spiegel als belegt. */
const LEASE_MS = 15 * 60 * 1000;

export interface MirrorView {
  id: string;
  direction: 'push' | 'pull';
  remoteUrl: string;
  remoteUsername: string | null;
  /** Nur ob ein Token hinterlegt ist – niemals der Wert selbst. */
  hasToken: boolean;
  isEnabled: boolean;
  isExactCopy: boolean;
  status: 'idle' | 'running' | 'success' | 'failure';
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Prüfung der Zieladresse
// ---------------------------------------------------------------------------

/**
 * Prüft eine Remote-Adresse.
 *
 * Nur https. `git://` und `http://` übertragen unverschlüsselt, `ssh://`
 * bräuchte einen Schlüssel auf dem Server und ist hier nicht vorgesehen.
 * Eingebettete Zugangsdaten werden abgelehnt: das Token gehört in das dafür
 * vorgesehene Feld, nicht in eine Adresse, die in Protokollen auftaucht.
 */
export async function assertValidRemote(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw validationFailed('Die Adresse des Gegenstücks ist keine gültige URL.');
  }

  if (url.protocol !== 'https:') {
    throw validationFailed(
      'Nur https wird unterstützt. Andere Protokolle übertragen unverschlüsselt oder brauchen einen Schlüssel auf dem Server.',
    );
  }

  if (url.username || url.password) {
    throw validationFailed(
      'Die Adresse darf keine Zugangsdaten enthalten. Trage das Token in das vorgesehene Feld ein.',
    );
  }

  // Dieselbe Prüfung wie bei Webhooks: löst den Namen auf und weist
  // Loopback, private Netze und link-local ab.
  await assertDeliverableUrl(url.toString());

  // Und zusätzlich unabhängig von der Umgebung.
  //
  // Die Webhook-Prüfung überspringt die Adressprüfung außerhalb von
  // production, damit sich während der Entwicklung ein Hook auf einen lokalen
  // Empfänger richten lässt. Bei einer Spiegelung ist das kein sinnvoller
  // Fall: das Gegenstück ist immer ein öffentlicher Hoster, und anders als
  // bei einem Hook wird hier ein Zugangstoken mitgeschickt. Deshalb gilt die
  // Prüfung hier immer.
  const addresses = isIP(url.hostname)
    ? [url.hostname]
    : await lookup(url.hostname, { all: true })
        .then((entries) => entries.map((entry) => entry.address))
        .catch(() => []);

  if (addresses.length === 0) {
    throw validationFailed(
      `Der Name "${url.hostname}" konnte nicht aufgelöst werden. Prüfe die Adresse.`,
    );
  }

  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw validationFailed(
        'Diese Adresse liegt in einem internen Netzbereich und ist als Ziel einer Spiegelung nicht zulässig.',
      );
    }
  }

  return url;
}

// ---------------------------------------------------------------------------
// Verwaltung
// ---------------------------------------------------------------------------

export interface UpsertMirrorInput {
  repositoryId: string;
  direction: 'push' | 'pull';
  remoteUrl: string;
  remoteUsername?: string | null;
  /** Null lässt ein vorhandenes Token unverändert, '' entfernt es. */
  token?: string | null;
  isEnabled?: boolean;
  isExactCopy?: boolean;
  actorId: string;
}

export async function upsertMirror(input: UpsertMirrorInput): Promise<MirrorView> {
  await assertValidRemote(input.remoteUrl);

  const existingRows = await db
    .select()
    .from(repositoryMirrors)
    .where(eq(repositoryMirrors.repositoryId, input.repositoryId));

  // Beide Richtungen gleichzeitig würden sich gegenseitig überschreiben.
  const opposite = existingRows.find((row) => row.direction !== input.direction);
  if (opposite) {
    throw validationFailed(
      `Für dieses Repository ist bereits eine Spiegelung in Richtung "${opposite.direction}" eingerichtet. ` +
        'Beide Richtungen gleichzeitig würden sich gegenseitig überschreiben.',
    );
  }

  const existing = existingRows.find((row) => row.direction === input.direction);

  const tokenEnc =
    input.token === undefined || input.token === null
      ? (existing?.tokenEnc ?? null)
      : input.token === ''
        ? null
        : encryptSecret(input.token);

  const values = {
    repositoryId: input.repositoryId,
    direction: input.direction,
    remoteUrl: input.remoteUrl.replace(/\/$/, ''),
    remoteUsername: input.remoteUsername?.trim() || null,
    tokenEnc,
    isEnabled: input.isEnabled ?? true,
    isExactCopy: input.isExactCopy ?? false,
    createdById: input.actorId,
    updatedAt: new Date(),
  };

  const [saved] = existing
    ? await db
        .update(repositoryMirrors)
        .set(values)
        .where(eq(repositoryMirrors.id, existing.id))
        .returning()
    : await db.insert(repositoryMirrors).values(values).returning();

  return toView(saved!);
}

export async function listMirrors(repositoryId: string): Promise<MirrorView[]> {
  const rows = await db
    .select()
    .from(repositoryMirrors)
    .where(eq(repositoryMirrors.repositoryId, repositoryId));
  return rows.map(toView);
}

export async function deleteMirror(repositoryId: string, mirrorId: string): Promise<void> {
  const deleted = await db
    .delete(repositoryMirrors)
    .where(
      and(eq(repositoryMirrors.id, mirrorId), eq(repositoryMirrors.repositoryId, repositoryId)),
    )
    .returning();

  if (deleted.length === 0) throw notFound('Spiegelung nicht gefunden.');
}

function toView(row: typeof repositoryMirrors.$inferSelect): MirrorView {
  return {
    id: row.id,
    direction: row.direction,
    remoteUrl: row.remoteUrl,
    remoteUsername: row.remoteUsername,
    hasToken: Boolean(row.tokenEnc),
    isEnabled: row.isEnabled,
    isExactCopy: row.isExactCopy,
    status: row.status,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Ausführung
// ---------------------------------------------------------------------------

/**
 * Legt eine temporäre Zugangsdatei an und gibt die Git-Argumente zurück, die
 * sie verwenden.
 *
 * Git liest das Format `https://benutzer:token@host` je Zeile. Die Datei liegt
 * in einem eigenen Verzeichnis mit Rechten 0600 und wird danach gelöscht.
 */
async function withCredentials<T>(
  remote: URL,
  username: string | null,
  token: string | null,
  run: (args: string[]) => Promise<T>,
): Promise<T> {
  if (!token) return run([]);

  const directory = await mkdtemp(join(tmpdir(), 'forge-mirror-'));
  const file = join(directory, 'credentials');

  // Der Benutzername ist bei Token-Anmeldung meist beliebig; GitHub erwartet
  // irgendeinen Wert und wertet nur das Token aus.
  const user = encodeURIComponent(username || 'x-access-token');
  const secret = encodeURIComponent(token);

  try {
    await writeFile(file, `${remote.protocol}//${user}:${secret}@${remote.host}\n`, {
      mode: 0o600,
    });

    // Nur der Pfad steht in den Argumenten, nicht das Token.
    return await run(['-c', `credential.helper=store --file=${file}`]);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Entfernt Zugangsdaten aus einer Fehlermeldung, bevor sie gespeichert wird.
 *
 * Exportiert, weil sich die Maskierung sonst nicht prüfen lässt: Fehler von
 * Git entstehen nur mit echter Netzverbindung, die Maskierung muss aber auch
 * ohne sie nachweisbar sein.
 */
export function scrubCredentials(message: string, token: string | null): string {
  let result = message;
  if (token) result = result.split(token).join('***');
  // Falls Git eine URL mit eingebetteten Daten ausgibt.
  result = result.replace(/\/\/[^@\s/]+:[^@\s/]+@/g, '//***:***@');
  return result.slice(0, 2000);
}

/**
 * Führt eine Spiegelung aus.
 *
 * Die Lease verhindert, dass zwei Läufe gleichzeitig dasselbe Repository
 * anfassen – etwa wenn schnell hintereinander gepusht wird.
 */
export async function runMirror(mirrorId: string): Promise<{ ok: boolean; error?: string }> {
  // Lease setzen; schlägt fehl, wenn bereits ein Lauf aktiv ist.
  const claimed = await db
    .update(repositoryMirrors)
    .set({ status: 'running', leaseExpiresAt: new Date(Date.now() + LEASE_MS) })
    .where(
      and(
        eq(repositoryMirrors.id, mirrorId),
        eq(repositoryMirrors.isEnabled, true),
        or(
          isNull(repositoryMirrors.leaseExpiresAt),
          lt(repositoryMirrors.leaseExpiresAt, new Date()),
        ),
      ),
    )
    .returning();

  const mirror = claimed[0];
  if (!mirror) return { ok: false, error: 'Spiegelung läuft bereits oder ist deaktiviert.' };

  const token = mirror.tokenEnc ? safeDecrypt(mirror.tokenEnc) : null;

  try {
    const remote = await assertValidRemote(mirror.remoteUrl);
    const cwd = repositoryPath(mirror.repositoryId);

    await withCredentials(remote, mirror.remoteUsername, token, async (credentialArgs) => {
      const base = [
        ...credentialArgs,
        // Keine interaktive Abfrage: ohne gültiges Token soll der Lauf
        // scheitern statt zu hängen.
        '-c',
        'core.askPass=',
      ];

      if (mirror.direction === 'push') {
        const refspec = mirror.isExactCopy
          ? ['--mirror']
          : ['--all', '--follow-tags', '--force'];

        await runGit([...base, 'push', ...refspec, mirror.remoteUrl], {
          cwd,
          timeoutMs: SYNC_TIMEOUT_MS,
        });
      } else {
        // Holt alle Branches und Tags und setzt die lokalen Refs darauf.
        await runGit(
          [
            ...base,
            'fetch',
            '--prune',
            '--tags',
            '--force',
            mirror.remoteUrl,
            '+refs/heads/*:refs/heads/*',
          ],
          { cwd, timeoutMs: SYNC_TIMEOUT_MS },
        );
      }
    });

    if (mirror.direction === 'pull') {
      // Nach einem Pull haben sich Inhalt und Sprachen geändert.
      await syncRepositoryMetadata(mirror.repositoryId).catch(() => {});
    }

    await db
      .update(repositoryMirrors)
      .set({
        status: 'success',
        lastSyncAt: new Date(),
        lastError: null,
        leaseExpiresAt: null,
      })
      .where(eq(repositoryMirrors.id, mirror.id));

    return { ok: true };
  } catch (error) {
    const raw =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: string }).stderr || error.message)
        : error instanceof Error
          ? error.message
          : 'Unbekannter Fehler.';

    const message = scrubCredentials(raw, token);

    await db
      .update(repositoryMirrors)
      .set({
        status: 'failure',
        lastSyncAt: new Date(),
        lastError: message,
        leaseExpiresAt: null,
      })
      .where(eq(repositoryMirrors.id, mirror.id));

    return { ok: false, error: message };
  }
}

function safeDecrypt(value: string): string | null {
  try {
    return decryptSecret(value);
  } catch {
    return null;
  }
}

/**
 * Stößt die Push-Spiegelung eines Repositories an.
 *
 * Wird nach einem erfolgreichen Push aufgerufen. Läuft absichtlich ohne
 * await im Aufrufer: ein nicht erreichbares Gegenstück darf den Push des
 * Benutzers nicht verzögern oder scheitern lassen.
 */
export async function triggerPushMirror(repositoryId: string): Promise<void> {
  const rows = await db
    .select({ id: repositoryMirrors.id })
    .from(repositoryMirrors)
    .where(
      and(
        eq(repositoryMirrors.repositoryId, repositoryId),
        eq(repositoryMirrors.direction, 'push'),
        eq(repositoryMirrors.isEnabled, true),
      ),
    )
    .limit(1);

  if (!rows[0]) return;
  await runMirror(rows[0].id);
}

/**
 * Holt fällige Pull-Spiegelungen.
 *
 * Vom Scheduler aufgerufen. Ein Repository wird höchstens alle `intervalMs`
 * abgeglichen, damit ein stündlicher Lauf nicht zu dauerndem Abrufen führt.
 */
export async function runDuePullMirrors(intervalMs: number): Promise<number> {
  const threshold = new Date(Date.now() - intervalMs);

  const due = await db
    .select({ id: repositoryMirrors.id })
    .from(repositoryMirrors)
    .where(
      and(
        eq(repositoryMirrors.direction, 'pull'),
        eq(repositoryMirrors.isEnabled, true),
        or(
          isNull(repositoryMirrors.lastSyncAt),
          lt(repositoryMirrors.lastSyncAt, threshold),
        ),
      ),
    )
    .limit(20);

  let count = 0;
  for (const row of due) {
    const result = await runMirror(row.id);
    if (result.ok) count += 1;
  }
  return count;
}

/**
 * Prüft eine Verbindung, ohne etwas zu übertragen.
 *
 * `ls-remote` fragt nur die Referenzen ab. Damit lässt sich beim Einrichten
 * feststellen, ob Adresse und Token stimmen, bevor der erste echte Lauf
 * stattfindet.
 */
export async function testRemote(options: {
  remoteUrl: string;
  remoteUsername?: string | null;
  token?: string | null;
  /** Wird verwendet, wenn kein neues Token angegeben wurde. */
  repositoryId?: string;
  direction?: 'push' | 'pull';
}): Promise<{ ok: boolean; refCount?: number; error?: string }> {
  const remote = await assertValidRemote(options.remoteUrl);

  let token = options.token ?? null;

  // Beim Bearbeiten wird das gespeicherte Token verwendet, wenn kein neues
  // eingegeben wurde – sonst müsste es bei jedem Test erneut eingetippt werden.
  if (!token && options.repositoryId && options.direction) {
    const rows = await db
      .select({ tokenEnc: repositoryMirrors.tokenEnc })
      .from(repositoryMirrors)
      .where(
        and(
          eq(repositoryMirrors.repositoryId, options.repositoryId),
          eq(repositoryMirrors.direction, options.direction),
        ),
      )
      .limit(1);
    if (rows[0]?.tokenEnc) token = safeDecrypt(rows[0].tokenEnc);
  }

  try {
    const output = await withCredentials(
      remote,
      options.remoteUsername ?? null,
      token,
      async (credentialArgs) => {
        const result = await runGit(
          [...credentialArgs, '-c', 'core.askPass=', 'ls-remote', '--heads', options.remoteUrl],
          { timeoutMs: 30_000, maxBuffer: 1024 * 1024 },
        );
        return result.stdout.toString('utf8');
      },
    );

    const refCount = output.split('\n').filter((line) => line.trim().length > 0).length;
    return { ok: true, refCount };
  } catch (error) {
    const raw =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: string }).stderr || error.message)
        : error instanceof Error
          ? error.message
          : 'Unbekannter Fehler.';
    return { ok: false, error: scrubCredentials(raw, token) };
  }
}
