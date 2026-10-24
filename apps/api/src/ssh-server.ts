/**
 * Git über SSH.
 *
 * Der Server nimmt ausschließlich Public-Key-Anmeldungen entgegen und führt
 * genau zwei Kommandos aus: `git-upload-pack` und `git-receive-pack`. Alles
 * andere – eine Shell, Portweiterleitung, SFTP, beliebige Kommandos – wird
 * abgelehnt. Ein SSH-Zugang zu Forge ist damit kein Zugang zum Server.
 *
 * Die Rechteprüfung ist dieselbe wie bei Git über HTTPS: `resolveRepositoryAccess`.
 * Es gibt keinen zweiten Pfad, über den SSH mehr dürfte als HTTPS.
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
// ssh2 ist ein CommonJS-Paket ohne benannte ESM-Exporte; der Default-Import
// ist der einzige Weg, der unter Node mit ESM zuverlässig funktioniert.
import ssh2 from 'ssh2';
import type { Connection } from 'ssh2';

const { Server } = ssh2;
import { hasAccess } from '@forge/shared';
import { config } from './config.js';
import { db } from './db/index.js';
import { auditLogs, gists } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { spawnGit } from './git/exec.js';
import { repositoryExists, repositoryPath } from './git/storage.js';
import { loadRepository, resolveRepositoryAccess } from './services/permissions.js';
import { findUserByFingerprint, markKeyUsed } from './services/ssh-keys.js';

interface SshSessionUser {
  userId: string;
  username: string;
  email: string;
  isAdmin: boolean;
  keyId: string;
}

/**
 * Lädt den Hostschlüssel oder erzeugt ihn beim ersten Start.
 *
 * Ein fester Schlüssel ist wichtig: wechselt er, meldet jeder Client eine
 * mögliche Man-in-the-Middle-Attacke. Deshalb liegt er auf der Platte und
 * wird nicht bei jedem Start neu erzeugt.
 */
async function loadHostKey(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // RSA im PKCS#1-PEM-Format: ssh2 liest ed25519 nur im OpenSSH-Format,
    // das Node nicht erzeugt. 3072 Bit sind für einen Hostschlüssel
    // ausreichend und werden von jedem aktuellen Client akzeptiert.
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });

    await mkdir(dirname(path), { recursive: true });
    // Nur für den Serverprozess lesbar.
    await writeFile(path, privateKey, { mode: 0o600 });
    return privateKey;
  }
}

/**
 * Zerlegt das Kommando einer SSH-Sitzung.
 *
 * Erwartet wird genau `git-upload-pack '<pfad>'` oder
 * `git-receive-pack '<pfad>'`. Der Pfad wird nicht an eine Shell übergeben,
 * sondern hier zerlegt; Anführungszeichen werden entfernt, alles andere
 * bleibt unverändert und wandert als einzelnes Argument weiter.
 */
function parseGitCommand(
  command: string,
): { service: 'upload-pack' | 'receive-pack'; owner: string; repo: string } | null {
  const match = /^git[- ](upload-pack|receive-pack)\s+(.+)$/.exec(command.trim());
  if (!match) return null;

  const service = match[1] as 'upload-pack' | 'receive-pack';
  let path = match[2]!.trim();

  // Clients zitieren den Pfad üblicherweise einfach.
  if (
    (path.startsWith("'") && path.endsWith("'")) ||
    (path.startsWith('"') && path.endsWith('"'))
  ) {
    path = path.slice(1, -1);
  }

  path = path.replace(/^\/+/, '').replace(/\.git$/, '');

  const segments = path.split('/');
  if (segments.length !== 2) return null;

  const [owner, repo] = segments;
  if (!owner || !repo) return null;
  // Kein Segment darf den Pfad verlassen; die Auflösung erfolgt ohnehin über
  // die Datenbank, aber ein solcher Versuch wird gar nicht erst weitergereicht.
  if (owner.includes('..') || repo.includes('..') || owner.includes('\0') || repo.includes('\0')) {
    return null;
  }

  return { service, owner, repo };
}

export interface SshServerHandle {
  close: () => Promise<void>;
  port: number;
}

export async function startSshServer(logger: {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}): Promise<SshServerHandle | null> {
  if (!config.ssh.enabled) return null;

  const hostKey = await loadHostKey(resolve(config.ssh.hostKeyPath));

  const server = new Server(
    {
      hostKeys: [hostKey],
      // Kennzeichnet den Dienst; manche Clients protokollieren das.
      ident: `${config.brand.name}-Git`,
    },
    (client: Connection) => {
      let sessionUser: SshSessionUser | null = null;

      client.on('authentication', (ctx) => {
        // Nur Public-Key. Passwörter sind ausgeschlossen, weil sie hier
        // keinen zweiten Faktor kennen und raten erlauben würden.
        if (ctx.method !== 'publickey') {
          ctx.reject(['publickey'], false);
          return;
        }

        void (async () => {
          try {
            // Der Fingerabdruck wird aus dem Schlüsselblob gebildet, genau wie
            // beim Hinterlegen – so passen beide Seiten zusammen.
            const { createHash } = await import('node:crypto');
            const fingerprint = createHash('sha256')
              .update(ctx.key.data)
              .digest('base64')
              .replace(/=+$/, '');

            const found = await findUserByFingerprint(fingerprint);
            if (!found) {
              ctx.reject();
              return;
            }

            // Erste Phase: der Client fragt nur, ob der Schlüssel akzeptiert
            // würde, und liefert noch keine Signatur.
            if (!ctx.signature) {
              ctx.accept();
              return;
            }

            sessionUser = found;
            void markKeyUsed(found.keyId);
            ctx.accept();
          } catch (error) {
            logger.error({ err: error }, 'SSH-Anmeldung fehlgeschlagen');
            ctx.reject();
          }
        })();
      });

      client.on('ready', () => {
        client.on('session', (acceptSession) => {
          const session = acceptSession();

          // Eine interaktive Shell gibt es nicht.
          session.on('shell', (_accept: unknown, reject: () => void) => reject());
          session.on('sftp', (_accept: unknown, reject: () => void) => reject());

          session.on('exec', (acceptExec, _rejectExec, info) => {
            const stream = acceptExec();
            const user = sessionUser;

            if (!user) {
              stream.stderr.write('Nicht angemeldet.\n');
              stream.exit(1);
              stream.end();
              return;
            }

            const parsed = parseGitCommand(info.command);
            if (!parsed) {
              stream.stderr.write(
                `${config.brand.name} erlaubt über SSH nur git-upload-pack und git-receive-pack.\n`,
              );
              stream.exit(1);
              stream.end();
              return;
            }

            void handleGitCommand(parsed, user, stream, logger).catch((error) => {
              logger.error({ err: error }, 'SSH-Git-Kommando fehlgeschlagen');
              try {
                stream.stderr.write('Interner Fehler.\n');
                stream.exit(1);
                stream.end();
              } catch {
                // Der Stream kann bereits geschlossen sein.
              }
            });
          });
        });
      });

      client.on('error', (error) => {
        // Abgebrochene Verbindungen sind normal (Portscans, Clients mit
        // falschem Schlüssel) und werden nur auf niedriger Stufe vermerkt.
        logger.warn({ err: error.message }, 'SSH-Verbindung beendet');
      });
    },
  );

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(config.ssh.port, config.ssh.host, () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });

  logger.info(
    `SSH-Git-Dienst lauscht auf ${config.ssh.host}:${config.ssh.port} (Klon-Adresse: ${config.ssh.cloneHost})`,
  );

  return {
    port: config.ssh.port,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

/** Führt upload-pack bzw. receive-pack nach erfolgreicher Rechteprüfung aus. */
async function handleGitCommand(
  parsed: { service: 'upload-pack' | 'receive-pack'; owner: string; repo: string },
  user: SshSessionUser,
  stream: any,
  logger: { error: (...args: any[]) => void },
): Promise<void> {
  const fail = (message: string, code = 1) => {
    stream.stderr.write(`${config.brand.name}: ${message}\n`);
    stream.exit(code);
    stream.end();
  };

  // Gists sind über SSH nur lesbar, analog zu HTTPS.
  if (parsed.owner === 'gists') {
    if (parsed.service === 'receive-pack') {
      fail('Gists lassen sich nicht per Push ändern.');
      return;
    }

    const [gist] = await db
      .select({ id: gists.id })
      .from(gists)
      .where(eq(gists.id, parsed.repo))
      .limit(1);

    if (!gist) {
      fail('Gist nicht gefunden.');
      return;
    }

    const { gistPath } = await import('./services/gists.js');
    runGitService(parsed.service, gistPath(gist.id), user, stream, null);
    return;
  }

  const context = await loadRepository(parsed.owner, parsed.repo);
  if (!context) {
    fail('Repository nicht gefunden.');
    return;
  }

  const access = await resolveRepositoryAccess(context, {
    id: user.userId,
    isAdmin: user.isAdmin,
  });

  const required = parsed.service === 'receive-pack' ? 'write' : 'read';

  if (!hasAccess(access.level, required)) {
    // Dieselbe Unterscheidung wie über HTTPS: wer lesen darf, erfährt, dass
    // ihm nur das Schreibrecht fehlt; wer nicht lesen darf, erfährt nichts.
    fail(
      hasAccess(access.level, 'read')
        ? 'Du hast keine Schreibrechte in diesem Repository.'
        : 'Repository nicht gefunden.',
    );
    return;
  }

  if (parsed.service === 'receive-pack' && context.repository.isArchived) {
    fail('Dieses Repository ist archiviert und schreibgeschützt.');
    return;
  }

  if (!(await repositoryExists(context.repository.id))) {
    logger.error({ repositoryId: context.repository.id }, 'Repository fehlt im Speicher');
    fail('Das Repository fehlt im Speicher. Bitte einen Administrator informieren.');
    return;
  }

  runGitService(
    parsed.service,
    repositoryPath(context.repository.id),
    user,
    stream,
    context.repository.id,
  );
}

function runGitService(
  service: 'upload-pack' | 'receive-pack',
  path: string,
  user: SshSessionUser,
  stream: any,
  repositoryId: string | null,
): void {
  const child = spawnGit([service, path], {
    env:
      service === 'receive-pack' && repositoryId
        ? {
            // Derselbe Kontext wie bei HTTPS, damit der pre-receive-Hook
            // Branch-Schutz auch für SSH-Pushes durchsetzt.
            FORGE_PUSH_CONTEXT: JSON.stringify({
              repositoryId,
              userId: user.userId,
              username: user.username,
            }),
          }
        : {},
  });

  stream.pipe(child.stdin);
  child.stdout.pipe(stream);
  child.stderr.pipe(stream.stderr);

  child.on('error', () => {
    stream.exit(1);
    stream.end();
  });

  child.on('close', async (code: number | null) => {
    if (service === 'receive-pack' && repositoryId && code === 0) {
      await db
        .insert(auditLogs)
        .values({
          actorId: user.userId,
          action: 'repository.push',
          targetType: 'repository',
          targetId: repositoryId,
          repositoryId,
          metadata: { transport: 'ssh' },
        })
        .catch(() => {});

      const { syncRepositoryMetadata } = await import('./services/repository-metadata.js');
      await syncRepositoryMetadata(repositoryId).catch(() => {});
    }

    stream.exit(code ?? 0);
    stream.end();
  });

  stream.on('close', () => {
    if (!child.killed) child.kill('SIGKILL');
  });
}
