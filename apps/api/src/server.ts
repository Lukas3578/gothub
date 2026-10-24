/**
 * Einstiegspunkt des API-Servers.
 */
import { mkdir } from 'node:fs/promises';
import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDatabase } from './db/index.js';
import { closeMailTransport } from './services/mail.js';
import { startSshServer } from './ssh-server.js';
import { checkRepositoryStorage, logStorageReport } from './lib/storage-check.js';
import { startScheduler } from './scheduler.js';

async function main(): Promise<void> {
  // Speicherverzeichnisse anlegen, bevor der erste Request kommt.
  await mkdir(config.git.storageRoot, { recursive: true });
  await mkdir(config.uploads.storageRoot, { recursive: true });

  const app = await buildApp();

  await app.listen({ port: config.server.port, host: config.server.host });

  const scheduler = startScheduler(app.log);
  const ssh = await startSshServer(app.log).catch((error) => {
    app.log.error({ err: error }, 'SSH-Dienst konnte nicht gestartet werden');
    return null;
  });

  app.log.info(
    `${config.brand.name} API läuft auf ${config.server.publicApiUrl} (Git-Endpunkt: ${config.server.publicApiUrl}/git)`,
  );

  app.log.info(
    `Frontend erwartet unter ${config.server.publicWebUrl} ` +
      `(Cookies: SameSite=${config.security.cookie.sameSite}, Secure=${config.security.cookie.secure})`,
  );

  // Prüft den Git-Speicher und meldet einen flüchtigen Datenträger deutlich.
  // Läuft nach dem Start, damit ein Problem hier den Dienst nicht blockiert.
  void checkRepositoryStorage()
    .then((report) => logStorageReport(report, app.log))
    .catch((error) => app.log.warn({ err: error }, 'Speicherprüfung fehlgeschlagen'));

  // Geordnetes Herunterfahren: laufende Anfragen werden noch beendet.
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} empfangen, fahre herunter...`);
    try {
      scheduler.stop();
      if (ssh) await ssh.close();
      await app.close();
      closeMailTransport();
      await closeDatabase();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Fehler beim Herunterfahren');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('Server konnte nicht gestartet werden:', error);
  process.exit(1);
});
