/**
 * Statischer Server für das gebaute Frontend.
 *
 * Nur nötig, wenn das Frontend als Web Service läuft. Ist es als Static Site
 * eingerichtet, liefert der Anbieter die Dateien selbst aus und diese Datei
 * bleibt unbenutzt.
 *
 * Bewusst ohne Abhängigkeiten: nur node:http und node:fs. Eine
 * Express-Instanz für das Ausliefern von fünf Dateien wäre unnötiger Ballast
 * und eine weitere Quelle für Sicherheitsaktualisierungen.
 *
 * Zwei Dinge, die ein Frontend mit clientseitigem Routing braucht:
 *  - Jeder unbekannte Pfad liefert index.html, damit ein direkter Aufruf von
 *    /dashboard oder ein Reload nicht in einem 404 endet.
 *  - Dateien mit Hash im Namen werden dauerhaft zwischengespeichert,
 *    index.html nie – sonst sieht ein Besucher nach einem Deployment noch
 *    die alte Seite, die auf nicht mehr vorhandene Bundles zeigt.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('./dist', import.meta.url)));
const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '0.0.0.0';

const INDEX = join(ROOT, 'index.html');

if (!existsSync(INDEX)) {
  console.error(
    `Kein Build gefunden: ${INDEX} fehlt.\n` +
      'Führe zuerst "npm run build --workspace @forge/web" aus.',
  );
  process.exit(1);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Löst einen Anfragepfad in eine Datei innerhalb von dist auf.
 *
 * Gibt null zurück, sobald der Pfad das Verzeichnis verlassen würde. Ohne
 * diese Prüfung wäre ein Aufruf wie /../../etc/passwd ein Weg, beliebige
 * Dateien des Servers auszulesen.
 */
function resolveFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }

  if (decoded.includes('\0')) return null;

  const candidate = resolve(ROOT, `.${normalize(decoded)}`);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;

  if (!existsSync(candidate)) return null;
  if (statSync(candidate).isDirectory()) return null;

  return candidate;
}

const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end('Method Not Allowed');
    return;
  }

  // Für Betriebsprüfungen des Hosting-Anbieters.
  if (request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }

  const file = resolveFile(request.url ?? '/');
  const target = file ?? INDEX;
  const isIndex = target === INDEX;

  const headers = {
    'content-type': MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    // Bundles tragen einen Hash im Namen; ändert sich der Inhalt, ändert sich
    // der Name. Deshalb ist unbegrenztes Zwischenspeichern sicher.
    // index.html trägt keinen Hash und muss immer frisch geladen werden.
    'cache-control': isIndex
      ? 'no-cache, must-revalidate'
      : 'public, max-age=31536000, immutable',
  };

  // Ein unbekannter Pfad liefert index.html – aber mit Status 200, weil der
  // Client-Router selbst entscheidet, ob die Route existiert.
  response.writeHead(200, headers);

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  createReadStream(target)
    .on('error', () => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    })
    .pipe(response);
});

server.listen(PORT, HOST, () => {
  console.log(`Frontend wird ausgeliefert auf http://${HOST}:${PORT} (Verzeichnis: ${ROOT})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
