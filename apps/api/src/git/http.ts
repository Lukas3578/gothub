/**
 * Git Smart HTTP Transport.
 *
 * Implementiert die Endpunkte, die ein Git-Client beim Klonen und Pushen über
 * HTTP anspricht:
 *
 *   GET  /git/:owner/:repo.git/info/refs?service=git-upload-pack
 *   GET  /git/:owner/:repo.git/info/refs?service=git-receive-pack
 *   POST /git/:owner/:repo.git/git-upload-pack      (clone, fetch, pull)
 *   POST /git/:owner/:repo.git/git-receive-pack     (push)
 *
 * Die eigentliche Protokollarbeit übernimmt das git-Binary; diese Schicht
 * kümmert sich um Authentifizierung, Berechtigungen, Header und das
 * Durchreichen der Streams.
 *
 * Wichtig für die Korrektheit: die Antwort darf NICHT gepuffert werden.
 * Git-Clients verarbeiten die Ausgabe inkrementell, und ein Klon eines großen
 * Repositories würde sonst erst den gesamten Packfile im Speicher halten.
 */

import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { hasAccess } from '@forge/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import {
  auditLogs,
  gists,
  namespaces as namespacesTable,
  pushEvents,
  repositories,
} from '../db/schema.js';
import {
  loadRepository,
  resolveRepositoryAccess,
  type ResolvedAccess,
} from '../services/permissions.js';
import { spawnGit } from './exec.js';
import { repositoryExists, repositoryPath, repositorySize } from './storage.js';
import { isEmpty, getHeadBranch } from './repository.js';
import { syncRepositoryMetadata } from '../services/repository-metadata.js';
import { HOOK_SECRET } from './hooks.js';

const UPLOAD_PACK = 'git-upload-pack';
const RECEIVE_PACK = 'git-receive-pack';

/**
 * Kodiert eine Zeile im pkt-line-Format: vier Hex-Zeichen Länge, dann Inhalt.
 * Wird für die Service-Ankündigung in der info/refs-Antwort gebraucht.
 */
function pktLine(content: string): string {
  const length = content.length + 4;
  return length.toString(16).padStart(4, '0') + content;
}

/** Das Flush-Paket signalisiert das Ende eines Abschnitts. */
const FLUSH_PKT = '0000';

interface GitRequestParams {
  owner: string;
  repo: string;
}

/**
 * Löst das Repository auf und prüft die Berechtigung für die angeforderte
 * Operation.
 *
 * Bei fehlender Berechtigung wird 401 mit WWW-Authenticate gesendet, wenn der
 * Client noch keine Zugangsdaten geschickt hat – so fragt Git nach Benutzer
 * und Passwort, statt mit einem unverständlichen Fehler abzubrechen. Hat der
 * Client sich bereits ausgewiesen und reicht es trotzdem nicht, folgt 404,
 * damit die Existenz privater Repositories nicht bestätigt wird.
 */
async function authorizeGitRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  service: string,
) {
  const { owner, repo } = request.params as GitRequestParams;
  const repoName = repo.replace(/\.git$/, '');

  // Gists liegen unter /git/gists/<id>.git. Sie haben kein Rechtesystem:
  // wer die ID kennt, darf lesen. Schreiben darf ausschließlich der
  // Eigentümer, und zwar nur über die API – ein Push auf einen Gist ist
  // nicht vorgesehen, weil dabei die Dateiliste in der Datenbank
  // auseinanderliefe.
  if (owner === 'gists') {
    return authorizeGistRequest(request, reply, service, repoName);
  }

  const context = await loadRepository(owner, repoName);
  if (!context) {
    reply.code(404).send('Repository nicht gefunden.');
    return null;
  }

  // Runner dürfen das Repository des Jobs klonen, den sie gerade ausführen –
  // nur lesend und nur dieses eine. Ein Runner-Token ist damit deutlich
  // schwächer als ein persönliches Zugriffstoken und taugt nicht, um sich
  // fremde Repositories zu holen.
  if (service === UPLOAD_PACK) {
    const runnerAccess = await resolveRunnerJobAccess(request, context.repository.id);
    if (runnerAccess) {
      return {
        path: repositoryPath(context.repository.id),
        context,
        access: runnerAccess,
        viewer: null,
      };
    }
  }

  const viewer = request.viewer;
  const access = await resolveRepositoryAccess(context, viewer);

  const required = service === RECEIVE_PACK ? 'write' : 'read';

  if (!hasAccess(access.level, required)) {
    if (!viewer) {
      reply
        .code(401)
        .header('WWW-Authenticate', `Basic realm="${config.brand.name}"`)
        .send('Authentifizierung erforderlich.');
      return null;
    }

    // Darf der Benutzer das Repository lesen, fehlt ihm nur das Schreibrecht.
    // Dann ist 403 mit klarer Begründung richtig – ein 404 wäre hier eine
    // irreführende Meldung über ein Repository, das er sehen kann.
    if (hasAccess(access.level, 'read')) {
      reply
        .code(403)
        .send('Du hast keine Schreibrechte in diesem Repository. Forke es und öffne einen Pull Request.');
      return null;
    }

    // Ohne Leserecht darf die Antwort die Existenz nicht bestätigen.
    reply.code(404).send('Repository nicht gefunden.');
    return null;
  }

  if (service === RECEIVE_PACK && context.repository.isArchived) {
    reply.code(403).send('Dieses Repository ist archiviert und schreibgeschützt.');
    return null;
  }

  if (!(await repositoryExists(context.repository.id))) {
    reply.code(500).send('Das Repository fehlt im Speicher. Bitte einen Administrator informieren.');
    return null;
  }

  return { path: repositoryPath(context.repository.id), context, access, viewer };
}


/**
 * Zugriff auf das Repository eines Gists.
 *
 * Gibt einen Kontext zurück, der dieselbe Form hat wie der eines
 * Repositories, aber auf den Gist-Pfad zeigt. Nur Lesen ist erlaubt.
 */
async function authorizeGistRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  service: string,
  gistId: string,
) {
  if (service === RECEIVE_PACK) {
    reply
      .code(403)
      .send('Gists lassen sich nicht per Push ändern. Nutze die Oberfläche oder die API.');
    return null;
  }

  const { gistPath } = await import('../services/gists.js');

  let path: string;
  try {
    path = gistPath(gistId);
  } catch {
    reply.code(404).send('Gist nicht gefunden.');
    return null;
  }

  const [gist] = await db
    .select({ id: gists.id })
    .from(gists)
    .where(eq(gists.id, gistId))
    .limit(1);

  if (!gist) {
    reply.code(404).send('Gist nicht gefunden.');
    return null;
  }

  // Dieselbe Form wie beim Repository-Kontext, damit die Aufrufer keinen
  // Sonderfall brauchen. `context` ist null – daran erkennt der Push-Pfad,
  // dass keine Nachbereitung stattfindet.
  return { path, context: null, access: null, viewer: request.viewer } as const;
}

/** Header, die verhindern, dass Proxys oder der Browser die Antwort cachen. */
function setNoCache(reply: FastifyReply): void {
  reply.header('Expires', 'Fri, 01 Jan 1980 00:00:00 GMT');
  reply.header('Pragma', 'no-cache');
  reply.header('Cache-Control', 'no-cache, max-age=0, must-revalidate');
}


/**
 * Prüft, ob die Anfrage von einem Runner stammt, der gerade einen Job für
 * dieses Repository ausführt.
 *
 * Die Bindung an einen laufenden Job ist der entscheidende Teil: ohne sie
 * wäre ein Runner-Token ein dauerhafter Leseschlüssel für alles, worauf der
 * Runner jemals Zugriff hatte.
 */
async function resolveRunnerJobAccess(
  request: FastifyRequest,
  repositoryId: string,
): Promise<ResolvedAccess | null> {
  const header = request.headers.authorization;
  if (!header) return null;

  let token: string | null = null;
  if (header.startsWith('Bearer ')) {
    token = header.slice(7).trim();
  } else if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator !== -1) token = decoded.slice(separator + 1);
  }

  if (!token?.startsWith('fgr_')) return null;

  const { runners, workflowJobs, workflowRuns } = await import('../db/schema.js');
  const { hashToken } = await import('../lib/crypto.js');
  const { and: andOp } = await import('drizzle-orm');

  const rows = await db
    .select({ runnerId: runners.id })
    .from(runners)
    .where(eq(runners.tokenHash, hashToken(token)))
    .limit(1);

  const runner = rows[0];
  if (!runner) return null;

  const jobRows = await db
    .select({ id: workflowJobs.id })
    .from(workflowJobs)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowJobs.runId))
    .where(
      andOp(
        eq(workflowJobs.runnerId, runner.runnerId),
        eq(workflowJobs.status, 'running'),
        eq(workflowRuns.repositoryId, repositoryId),
      ),
    )
    .limit(1);

  if (!jobRows[0]) return null;

  const context = await loadRepositoryById(repositoryId);
  if (!context) return null;

  return { ...context, level: 'read', isAnonymousRead: false };
}

/** Lädt den Repository-Kontext anhand der ID. */
async function loadRepositoryById(repositoryId: string) {
  const { organizations } = await import('../db/schema.js');

  const rows = await db
    .select({
      repository: repositories,
      ownerName: namespacesTable.name,
      ownerKind: namespacesTable.kind,
      organizationId: organizations.id,
    })
    .from(repositories)
    .innerJoin(namespacesTable, eq(namespacesTable.id, repositories.ownerNamespaceId))
    .leftJoin(organizations, eq(organizations.namespaceId, namespacesTable.id))
    .where(eq(repositories.id, repositoryId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    repository: row.repository,
    ownerName: row.ownerName,
    ownerKind: row.ownerKind,
    organizationId: row.organizationId,
  };
}

export async function registerGitHttpRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Der Body von git-upload-pack und git-receive-pack ist ein binärer Stream,
   * den Fastify nicht parsen darf. Dieser Content-Type-Parser reicht die
   * Anfrage unverändert durch.
   */
  app.addContentTypeParser(
    ['application/x-git-upload-pack-request', 'application/x-git-receive-pack-request'],
    (_request, payload, done) => {
      done(null, payload);
    },
  );

  // -------------------------------------------------------------------------
  // Schritt 1: Ref-Ankündigung
  // -------------------------------------------------------------------------
  app.get<{ Params: GitRequestParams; Querystring: { service?: string } }>(
    '/git/:owner/:repo/info/refs',
    async (request, reply) => {
      const service = request.query.service;

      if (service !== UPLOAD_PACK && service !== RECEIVE_PACK) {
        // Das "dumme" HTTP-Protokoll wird nicht unterstützt. Ein klarer
        // Fehler ist hier besser als ein halb funktionierender Fallback.
        reply.code(403).send('Nur das Smart-HTTP-Protokoll wird unterstützt.');
        return reply;
      }

      const authorized = await authorizeGitRequest(request, reply, service);
      if (!authorized) return reply;

      const path = authorized.path;

      setNoCache(reply);
      reply.header('Content-Type', `application/x-${service}-advertisement`);

      const child = spawnGit(
        [service.replace('git-', ''), '--stateless-rpc', '--advertise-refs', path],
        { env: { GIT_PROTOCOL: (request.headers['git-protocol'] as string) ?? '' } },
      );

      // Die Antwort beginnt mit der Ankündigung des Dienstes, danach folgt
      // unverändert, was git ausgibt.
      reply.raw.writeHead(200, {
        'Content-Type': `application/x-${service}-advertisement`,
        'Cache-Control': 'no-cache, max-age=0, must-revalidate',
        Pragma: 'no-cache',
        Expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
      });
      reply.raw.write(pktLine(`# service=${service}\n`));
      reply.raw.write(FLUSH_PKT);

      child.stdout.pipe(reply.raw);

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString('utf8');
      });

      child.on('error', () => {
        reply.raw.end();
      });

      child.on('close', (code) => {
        if (code !== 0) {
          request.log.error({ service, code, stderr }, 'Git-Ref-Ankündigung fehlgeschlagen');
        }
        reply.raw.end();
      });

      // Bricht der Client die Verbindung ab, wird der Git-Prozess beendet
      // statt weiterzulaufen.
      //
      // Der Abbruch wird am Response-Stream erkannt, nicht am Request-Stream:
      // dessen 'close' feuert bereits, sobald der Request-Body vollständig
      // gelesen wurde, also mitten in einer völlig normalen Anfrage.
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded && !child.killed) child.kill('SIGKILL');
      });

      return reply;
    },
  );

  // -------------------------------------------------------------------------
  // Schritt 2a: Klonen und Abrufen
  // -------------------------------------------------------------------------
  app.post<{ Params: GitRequestParams }>(
    '/git/:owner/:repo/git-upload-pack',
    async (request, reply) => {
      const authorized = await authorizeGitRequest(request, reply, UPLOAD_PACK);
      if (!authorized) return reply;

      const path = authorized.path;

      reply.raw.writeHead(200, {
        'Content-Type': `application/x-${UPLOAD_PACK}-result`,
        'Cache-Control': 'no-cache, max-age=0, must-revalidate',
        Pragma: 'no-cache',
        Expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
      });

      const child = spawnGit(['upload-pack', '--stateless-rpc', path], {
        env: { GIT_PROTOCOL: (request.headers['git-protocol'] as string) ?? '' },
      });

      child.stdout.pipe(reply.raw);

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString('utf8');
      });

      child.on('close', (code) => {
        if (code !== 0) request.log.error({ code, stderr }, 'upload-pack fehlgeschlagen');
        reply.raw.end();
      });

      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded && !child.killed) child.kill('SIGKILL');
      });

      // Git komprimiert den Request-Body optional mit gzip.
      const source =
        request.headers['content-encoding'] === 'gzip'
          ? (request.raw.pipe(createGunzip()) as NodeJS.ReadableStream)
          : request.raw;

      try {
        await pipeline(source, child.stdin);
      } catch (error) {
        request.log.warn({ err: error }, 'upload-pack: Request-Stream abgebrochen');
      }

      return reply;
    },
  );

  // -------------------------------------------------------------------------
  // Schritt 2b: Push
  // -------------------------------------------------------------------------
  app.post<{ Params: GitRequestParams }>(
    '/git/:owner/:repo/git-receive-pack',
    async (request, reply) => {
      const authorized = await authorizeGitRequest(request, reply, RECEIVE_PACK);
      if (!authorized) return reply;

      const { context, viewer } = authorized;
      // Gists erreichen diesen Pfad nicht: authorizeGitRequest weist
      // receive-pack für sie bereits mit 403 ab.
      if (!context) {
        reply.code(403).send('Dieses Repository nimmt keine Pushes entgegen.');
        return reply;
      }

      const repositoryId = context.repository.id;
      const path = authorized.path;

      const wasEmpty = await isEmpty(repositoryId);

      reply.raw.writeHead(200, {
        'Content-Type': `application/x-${RECEIVE_PACK}-result`,
        'Cache-Control': 'no-cache, max-age=0, must-revalidate',
        Pragma: 'no-cache',
        Expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
      });

      const child = spawnGit(['receive-pack', '--stateless-rpc', path], {
        env: {
          // Wird vom pre-receive-Hook ausgelesen, um Branch-Schutzregeln
          // durchzusetzen und den Push dem richtigen Benutzer zuzuordnen.
          FORGE_PUSH_CONTEXT: JSON.stringify({
            repositoryId,
            userId: viewer?.id ?? null,
            username: viewer?.username ?? null,
            // Der Hook ruft über diese Adresse zurück. Immer die lokale
            // Schleife, nie die öffentliche URL: der Hook läuft auf derselben
            // Maschine, und so umgeht der Aufruf Proxys und TLS-Terminierung.
            //
            // Der Port kommt aus der Verbindung selbst, nicht aus der
            // Konfiguration: lauscht der Prozess auf einem anderen Port – etwa
            // auf einem zufälligen im Test – zeigte ein fester Wert auf einen
            // fremden Server, dessen Hook-Geheimnis nicht passt.
            callbackUrl: `http://127.0.0.1:${request.socket.localPort ?? config.server.port}/internal/git/pre-receive`,
            secret: HOOK_SECRET,
          }),
        },
      });

      child.stdout.pipe(reply.raw);

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString('utf8');
      });

      child.on('close', async (code) => {
        reply.raw.end();

        if (code !== 0) {
          request.log.error({ code, stderr }, 'receive-pack fehlgeschlagen');
          return;
        }

        // Nach einem erfolgreichen Push werden die abgeleiteten Daten
        // aktualisiert: Default-Branch, Sprachen, Größe, pushedAt.
        // Fehler hier dürfen den Push nicht nachträglich scheitern lassen,
        // werden aber protokolliert.
        try {
          await onPushCompleted(repositoryId, wasEmpty, viewer?.id ?? null, request.ip);
        } catch (error) {
          request.log.error({ err: error, repositoryId }, 'Nachbereitung des Push fehlgeschlagen');
        }
      });

      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded && !child.killed) child.kill('SIGKILL');
      });

      const source =
        request.headers['content-encoding'] === 'gzip'
          ? (request.raw.pipe(createGunzip()) as NodeJS.ReadableStream)
          : request.raw;

      try {
        await pipeline(source, child.stdin);
      } catch (error) {
        request.log.warn({ err: error }, 'receive-pack: Request-Stream abgebrochen');
      }

      return reply;
    },
  );
}

/**
 * Aktualisiert den Repository-Datensatz nach einem erfolgreichen Push.
 *
 * Wird der erste Commit gepusht, muss der Default-Branch auf das gesetzt
 * werden, was tatsächlich angekommen ist – ein Client, der `master` statt
 * `main` pusht, hinterlässt sonst ein Repository, dessen Default-Branch
 * nicht existiert.
 */
async function onPushCompleted(
  repositoryId: string,
  wasEmpty: boolean,
  userId: string | null,
  ipAddress: string,
): Promise<void> {
  const nowEmpty = await isEmpty(repositoryId);

  if (wasEmpty && !nowEmpty) {
    const head = await getHeadBranch(repositoryId);
    const [repo] = await db
      .select({ defaultBranch: repositories.defaultBranch })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1);

    // Wenn der konfigurierte Default-Branch nach dem Push nicht existiert,
    // den tatsächlich vorhandenen übernehmen.
    const { listBranches } = await import('./repository.js');
    const branches = await listBranches(repositoryId, repo?.defaultBranch ?? 'main');
    const configured = branches.find((b) => b.name === repo?.defaultBranch);

    if (!configured && branches[0]) {
      const { setHeadBranch } = await import('./repository.js');
      await setHeadBranch(repositoryId, branches[0].name);
      await db
        .update(repositories)
        .set({ defaultBranch: branches[0].name })
        .where(eq(repositories.id, repositoryId));
    } else if (head && repo && head !== repo.defaultBranch && configured) {
      const { setHeadBranch } = await import('./repository.js');
      await setHeadBranch(repositoryId, repo.defaultBranch);
    }
  }

  const sizeBytes = await repositorySize(repositoryId);

  await db
    .update(repositories)
    .set({
      isEmpty: nowEmpty,
      pushedAt: new Date(),
      updatedAt: new Date(),
      sizeBytes,
    })
    .where(eq(repositories.id, repositoryId));

  await db.insert(auditLogs).values({
    actorType: userId ? 'user' : 'system',
    actorId: userId,
    action: 'repository.push',
    targetType: 'repository',
    targetId: repositoryId,
    repositoryId,
    ipAddress,
    metadata: {},
  });

  // Sprachen und Commit-Index im Hintergrund aktualisieren.
  await syncRepositoryMetadata(repositoryId).catch(() => {});

  if (!nowEmpty) {
    await onPushWorkflows(repositoryId, userId);
  }
}

/**
 * Liest die Workflow-Dateien neu ein und löst passende Läufe aus.
 *
 * Grundlage sind die Push-Ereignisse, die der pre-receive-Hook geschrieben
 * hat: dort steht, welche Refs sich wie verändert haben. Ein Tag-Push löst
 * andere Workflows aus als ein Branch-Push, und ohne diese Unterscheidung
 * liefe bei jedem Tag die komplette CI mit.
 */
async function onPushWorkflows(repositoryId: string, userId: string | null): Promise<void> {
  const { syncWorkflows, triggerWorkflows } = await import('../services/workflows.js');
  const { pushEvents: pushEventsTable } = await import('../db/schema.js');
  const { desc: descOrder } = await import('drizzle-orm');

  const [repo] = await db
    .select({ defaultBranch: repositories.defaultBranch, hasActions: repositories.hasActions })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);

  if (!repo?.hasActions) return;

  await syncWorkflows(repositoryId, repo.defaultBranch).catch(() => {});

  // Die Ereignisse dieses Pushes: alles, was in den letzten Sekunden
  // geschrieben wurde. Der Hook läuft unmittelbar vor diesem Aufruf.
  const recent = await db
    .select()
    .from(pushEventsTable)
    .where(eq(pushEventsTable.repositoryId, repositoryId))
    .orderBy(descOrder(pushEventsTable.createdAt))
    .limit(20);

  const cutoff = Date.now() - 60_000;
  const ZERO = '0'.repeat(40);

  for (const event of recent) {
    if (event.createdAt.getTime() < cutoff) break;
    if (event.newOid === ZERO) continue; // Löschung löst nichts aus

    const isBranch = event.refName.startsWith('refs/heads/');
    const isTag = event.refName.startsWith('refs/tags/');
    if (!isBranch && !isTag) continue;

    const name = event.refName.replace(/^refs\/(heads|tags)\//, '');

    // Geänderte Pfade ermitteln, damit Pfadfilter greifen können.
    let changedPaths: string[] | null = null;
    if (event.oldOid !== ZERO) {
      const { runGitText } = await import('./exec.js');
      const output = await runGitText(
        ['diff', '--name-only', `${event.oldOid}..${event.newOid}`],
        { cwd: repositoryPath(repositoryId), maxBuffer: 4 * 1024 * 1024 },
      ).catch(() => '');
      changedPaths = output.split('\n').filter(Boolean);
    }

    await triggerWorkflows({
      repositoryId,
      event: 'push',
      headSha: event.newOid,
      headBranch: isBranch ? name : null,
      tag: isTag ? name : null,
      changedPaths,
      triggeredById: userId,
    }).catch(() => {});
  }
}
