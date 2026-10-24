/**
 * Git-Hooks.
 *
 * Branch-Schutzregeln müssen auch beim Push über die Kommandozeile greifen –
 * sonst schützen sie nur die Weboberfläche und sind damit wertlos.
 *
 * Umsetzung: in jedem bare-Repository liegt ein `pre-receive`-Hook. Git ruft
 * ihn vor dem Schreiben der Refs auf und übergibt die geplanten Änderungen auf
 * stdin. Der Hook fragt beim API-Prozess nach, ob der Push erlaubt ist; ein
 * Exit-Code ungleich 0 bricht den Push ab, bevor irgendetwas geschrieben wird.
 *
 * Der Hook spricht die API über HTTP an, statt selbst die Datenbank zu
 * öffnen. Das hält ihn klein, vermeidet eine zweite Verbindungsquelle zur
 * Datenbank und bedeutet, dass die Regeln an genau einer Stelle ausgewertet
 * werden.
 */

import { chmod, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { repositoryPath } from './storage.js';

/**
 * Geteiltes Geheimnis zwischen Hook und API, bei jedem Start neu erzeugt.
 *
 * Es wird dem Hook über die Umgebung mitgegeben, nicht in die Datei
 * geschrieben – so steht es nicht dauerhaft auf der Platte, und ein alter Hook
 * kann nach einem Neustart nichts mehr ausrichten.
 */
export const HOOK_SECRET = randomBytes(32).toString('hex');

export function verifyHookSecret(value: string | undefined): boolean {
  if (!value || value.length !== HOOK_SECRET.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(HOOK_SECRET));
}

/**
 * Der Inhalt des pre-receive-Hooks.
 *
 * Bewusst ohne Abhängigkeiten: nur Node-Bordmittel, damit der Hook auch dann
 * läuft, wenn im Repository-Verzeichnis keine node_modules liegen.
 */
const PRE_RECEIVE_SOURCE = `#!/usr/bin/env node
'use strict';

/**
 * Von Forge erzeugt. Nicht von Hand bearbeiten.
 * Fragt vor jedem Push beim API-Prozess nach, ob die Ref-Änderungen erlaubt sind.
 */

const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const ZERO = '0'.repeat(40);

/**
 * Prüft Abstammung und zählt Commits.
 *
 * Das muss hier geschehen und nicht im API-Prozess: Git legt die neu
 * empfangenen Objekte während pre-receive in ein Quarantäne-Verzeichnis, das
 * nur über die Umgebung dieses Prozesses erreichbar ist. Ein git-Aufruf von
 * außerhalb sähe die neuen Commits nicht und hielte jeden Fast-Forward
 * fälschlich für einen Force-Push.
 */
function gitOk(args) {
  try {
    execFileSync('git', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function gitOut(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function describe(update) {
  const isCreation = update.oldOid === ZERO;
  const isDeletion = update.newOid === ZERO;

  let isForcePush = false;
  let commitCount = 0;

  if (!isDeletion) {
    const range = isCreation ? update.newOid : update.oldOid + '..' + update.newOid;
    commitCount = Number(gitOut(['rev-list', '--count', range])) || 0;

    if (!isCreation) {
      isForcePush = !gitOk(['merge-base', '--is-ancestor', update.oldOid, update.newOid]);
    }
  }

  return { ...update, isCreation, isDeletion, isForcePush, commitCount };
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const updates = raw
    .split('\\n')
    .filter(Boolean)
    .map((line) => {
      const [oldOid, newOid, refName] = line.split(' ');
      return describe({ oldOid, newOid, refName });
    });

  if (updates.length === 0) process.exit(0);

  let context;
  try {
    context = JSON.parse(process.env.FORGE_PUSH_CONTEXT || '{}');
  } catch {
    context = {};
  }

  // Ohne Kontext ist nicht entscheidbar, wer pusht. Dann wird abgelehnt –
  // ein offener Push wäre hier die gefährlichere Annahme.
  if (!context.callbackUrl || !context.secret) {
    process.stderr.write('Forge: Push-Kontext fehlt. Push abgelehnt.\\n');
    process.exit(1);
  }

  const payload = JSON.stringify({
    repositoryId: context.repositoryId,
    userId: context.userId || null,
    updates,
  });

  const url = new URL(context.callbackUrl);
  const client = url.protocol === 'https:' ? https : http;

  const request = client.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-forge-hook-secret': context.secret,
      },
      timeout: 30000,
    },
    (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* unverändert */ }

        if (response.statusCode === 200 && parsed.allowed) {
          process.exit(0);
        }

        const reasons = Array.isArray(parsed.reasons) ? parsed.reasons : ['Push abgelehnt.'];
        for (const reason of reasons) {
          process.stderr.write('Forge: ' + reason + '\\n');
        }
        process.exit(1);
      });
    },
  );

  request.on('timeout', () => {
    request.destroy();
    process.stderr.write('Forge: Zeitüberschreitung bei der Prüfung. Push abgelehnt.\\n');
    process.exit(1);
  });

  request.on('error', (error) => {
    process.stderr.write('Forge: Prüfung nicht erreichbar (' + error.message + '). Push abgelehnt.\\n');
    process.exit(1);
  });

  request.end(payload);
});
`;

/** Schreibt die Hooks in ein Repository. Idempotent. */
export async function installHooks(repositoryId: string): Promise<void> {
  const hooksDir = join(repositoryPath(repositoryId), 'hooks');
  await mkdir(hooksDir, { recursive: true });

  const target = join(hooksDir, 'pre-receive');
  await writeFile(target, PRE_RECEIVE_SOURCE, 'utf8');
  await chmod(target, 0o755);
}
