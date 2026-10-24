# Forge

Eine selbst gehostete Entwicklerplattform. Echte Git-Repositories über HTTPS,
eigenes Benutzer- und Rechtesystem, Dateibrowser mit Historie und Diffs.

Der Name steht an genau einer Stelle (`FORGE_BRAND_NAME` in der `.env`) und
lässt sich ohne Codeänderung austauschen.

> **Stand des Projekts:** Repositories mit Git über HTTPS und SSH, Issues,
> Pull Requests mit Review und drei Merge-Strategien, Organisationen und Teams,
> Wiki, Gists, Projektboards, Benachrichtigungen, Releases, eine
> npm-kompatible Paket-Registry, Suche, Webhooks, Administration und eine CI
> mit Docker-isolierten Runnern sind implementiert und getestet. Was belegt
> funktioniert und was fehlt, steht vollständig in [STATUS.md](./STATUS.md).

## Voraussetzungen

| Komponente | Version | Zweck |
|---|---|---|
| Node.js | ≥ 20 | API und Frontend |
| PostgreSQL | ≥ 14 | Datenhaltung |
| Git | ≥ 2.30 | Repository-Verwaltung (wird als Prozess aufgerufen) |
| Redis | ≥ 6 | Caching und Rate-Limiting |
| Docker | ≥ 24 | nur auf dem Runner-Host: isolierte Workflow-Ausführung |

## Einrichtung

```bash
# 1. Dienste starten (Postgres, Redis)
./scripts/dev-up.sh

# 2. Abhängigkeiten
npm install

# 3. Konfiguration anlegen und Geheimnisse erzeugen
cp .env.example .env
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -base64 48)|" .env
sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -hex 32)|" .env

# 4. Datenbank anlegen und migrieren
createdb forge
npm run db:migrate

# 5. Starten
npm run dev
```

Danach läuft die API auf `http://localhost:4000` und das Frontend auf
`http://localhost:5173`.

**Der erste registrierte Account wird automatisch Administrator** (steuerbar
über `FIRST_USER_IS_ADMIN`). In der Entwicklung werden E-Mails nicht
verschickt, sondern in die Serverkonsole geschrieben – der Bestätigungslink
steht dort.

## CI-Runner betreiben

Workflows werden nicht vom API-Prozess ausgeführt, sondern von einem Runner,
der Jobs abholt und in Docker-Containern startet. Der Runner läuft bewusst als
eigener Prozess und darf auf einer anderen Maschine stehen.

```bash
# 1. Runner im Repository registrieren (Einstellungen → Actions → Runner)
#    oder über die API; das Token erscheint genau einmal.

# 2. Basis-Image bereitstellen. Der Name stammt aus RUNNER_IMAGE_MAP
#    in apps/api/src/services/workflow-parser.ts.
docker pull <dein-basis-image>
docker tag  <dein-basis-image> forge/runner-base:latest

# 3. Runner starten
FORGE_API_URL=http://localhost:4000 \
FORGE_RUNNER_TOKEN=fgr_... \
FORGE_RUNNER_LABELS=self-hosted,ubuntu-latest \
FORGE_RUNNER_NETWORK=none \
  npm run dev --workspace @forge/runner
```

Der Runner braucht Zugriff auf den Docker-Socket. Wer Jobs einstellen darf,
kann darüber indirekt Container auf dem Runner-Host starten – ein Runner
gehört deshalb auf eine Maschine, die sonst nichts Wichtiges tut.
`FORGE_RUNNER_NETWORK=none` schneidet Workflows vom Netz ab; `bridge` erlaubt
ausgehende Verbindungen.

Ein Workflow liegt unter `.forge/workflows/` im Repository:

```yaml
name: Build

on:
  push:
    branches: [main]

jobs:
  bauen:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: forge/checkout@v1
      - name: Abhängigkeiten
        run: npm ci
      - name: Bauen
        env:
          TOKEN: ${{ secrets.NPM_TOKEN }}
        run: npm run build
```

## Git über SSH

Standardmäßig abgeschaltet. Einschalten mit `SSH_ENABLED=true` in der `.env`.
Der Dienst führt ausschließlich `git-upload-pack` und `git-receive-pack` aus –
eine Shell, SFTP oder Portweiterleitung gibt es nicht.

```bash
# Öffentlichen Schlüssel unter Einstellungen → SSH-Schlüssel hinterlegen, dann:
git clone ssh://git@localhost:2222/<benutzer>/<repo>.git
```

Der Hostschlüssel wird beim ersten Start unter `data/ssh/host_key` erzeugt und
darf sich danach nicht mehr ändern, sonst melden Clients eine mögliche
Man-in-the-Middle-Attacke.

## Pakete veröffentlichen

Die Registry ist npm-kompatibel. Scoped-Pakete gehören dem gleichnamigen
Benutzer oder der gleichnamigen Organisation.

```bash
# .npmrc im Projekt
registry=http://localhost:4000/npm/
//localhost:4000/npm/:_authToken=<dein-zugriffstoken>

npm publish
npm install @<benutzer>/<paket>
```

Eine bereits veröffentlichte Version lässt sich nicht überschreiben – das
würde bereits installierte Stände verändern.

## Mit Git arbeiten

Git über HTTPS verlangt ein Zugriffstoken statt des Passworts. Du erstellst es
unter *Einstellungen → Zugriffstokens*. Der Benutzername ist beliebig, das
Token ist das Passwort.

```bash
git clone http://localhost:4000/git/<benutzer>/<repo>.git
git push origin main
```

Oder mit Token direkt in der URL (praktisch für Skripte, aber Vorsicht: die
URL landet in `.git/config`):

```bash
git clone http://<benutzer>:<token>@localhost:4000/git/<benutzer>/<repo>.git
```

## Auf GitHub oder GitLab spiegeln

*Repository → Einstellungen → Spiegelung.* Zwei Richtungen, je Repository
jeweils eine und nicht beide gleichzeitig:

| Richtung | Verhalten |
|---|---|
| **hinaus** (push) | Nach jedem Push an Forge schiebt Forge alle Branches und Tags an die angegebene Adresse weiter. |
| **herein** (pull) | Forge holt alle fünf Minuten von der angegebenen Adresse. Das Repository ist dann eine Kopie. |

Nötig sind die https-Adresse des Gegenstücks und ein Token mit Schreibrecht
(bei GitHub ein Personal Access Token mit `repo`). *Verbindung prüfen* fragt
nur die Referenzen ab und überträgt nichts – damit fällt ein falsches Token
beim Einrichten auf und nicht erst beim nächsten Push.

Wozu das gut ist: Werkzeuge, die eine selbst betriebene Instanz nicht
erreichen. Der Sandkasten vieler KI-Assistenten lässt nur eine feste Liste
von Adressen zu; GitHub steht darauf, eine eigene Domain nicht. Mit einer
Spiegelung hinaus arbeitest du weiter gegen Forge, und das Werkzeug klont die
Kopie auf GitHub.

Zum Umgang mit dem Token:

- Es wird mit `ENCRYPTION_KEY` verschlüsselt gespeichert und nie wieder
  ausgeliefert. Die API gibt nur `hasToken: true` zurück.
- Es steht nicht in der Kommandozeile. Git bekommt es über eine temporäre
  Datei mit Rechten 0600 (`credential.helper=store --file=…`); in der
  Prozessliste erscheint nur deren Pfad.
- Fehlermeldungen der Gegenseite werden maskiert, bevor sie gespeichert
  werden.

Die Zieladresse wird geprüft, bevor etwas passiert: nur `https`, keine
Zugangsdaten in der Adresse, und der aufgelöste Hostname darf nicht in einem
internen Netzbereich liegen. Ohne diese Prüfung wäre eine Spiegelung auf
`https://169.254.169.254/` ein Weg zu Cloud-Metadaten.

Nachgewiesen in `apps/api/src/__tests__/mirrors.test.ts`.

## Architektur

```
forge/
├── apps/
│   ├── api/                    Fastify-Backend (TypeScript)
│   │   ├── src/
│   │   │   ├── config.ts       validierte Konfiguration, bricht beim Start ab
│   │   │   ├── db/
│   │   │   │   ├── schema.ts   Drizzle-Schema, 62 Tabellen
│   │   │   │   └── migrate.ts  Migrationsläufer
│   │   │   ├── git/
│   │   │   │   ├── exec.ts     gehärteter Aufruf von Git-Unterprozessen
│   │   │   │   ├── storage.ts  Ablage der bare-Repositories
│   │   │   │   ├── repository.ts  Trees, Blobs, Commits, Diffs, Blame, Merge
│   │   │   │   └── http.ts     Git Smart HTTP (upload-pack / receive-pack)
│   │   │   ├── services/
│   │   │   │   ├── permissions.ts  zentrale Zugriffsprüfung
│   │   │   │   ├── auth.ts     Registrierung, Sessions, 2FA
│   │   │   │   └── repositories.ts
│   │   │   ├── routes/         HTTP-Endpunkte
│   │   │   └── middleware/     Auth-Kontext, CSRF, Wartungsmodus
│   │   └── drizzle/            generierte SQL-Migrationen
│   ├── web/                    React-Frontend (Vite, Tailwind)
│   └── runner/                 CI-Runner: holt Jobs, führt sie in Docker aus
├── packages/shared/            Typen und Validierungsregeln für beide Seiten
└── data/                       Repositories und Uploads (nicht im Git)
```

### Warum dieser Stack

- **Fastify statt NestJS.** Das Git-Smart-HTTP-Protokoll braucht rohen,
  ungepufferten Zugriff auf Request- und Response-Streams. NestJS'
  Interceptor-Pipeline müsste dafür umgangen werden.
- **Vite + React statt Next.js.** Das Backend ist ohnehin ein eigener Prozess;
  Next.js würde eine dritte Schicht einziehen, die überwiegend nur proxied.
  SSR lässt sich später für öffentliche Repository-Seiten nachrüsten, ohne das
  Backend zu ändern.
- **Das echte git-Binary statt einer Git-Implementierung in JavaScript.** Ein
  nachgebautes Protokoll wäre bei Edge Cases (Shallow Clones, Thin Packs,
  Protokoll v2) unzuverlässig.

### Zwei Entwurfsentscheidungen, die den Rest erklären

**Git ist die Quelle der Wahrheit.** Commits, Trees und Refs stehen
ausschließlich im Repository. Die Tabelle `commit_index` ist ausdrücklich nur
ein Suchindex und kann jederzeit verworfen und neu aufgebaut werden. Es gibt
keine Stelle, an der ein Commit in die Datenbank geschrieben wird und danach
als maßgeblich gilt.

**Benutzer und Organisationen teilen sich einen Namensraum.** Sonst wäre die
Route `/:owner` nicht eindeutig auflösbar. Durchgesetzt wird das über die
Tabelle `namespaces` mit einem UNIQUE-Index – nicht über Anwendungslogik, die
man an einer Stelle vergessen kann.

## Sicherheit

| Maßnahme | Umsetzung |
|---|---|
| Passwörter | Argon2id (19 MiB, 2 Runden), Parameter nicht konfigurierbar |
| Sessions | nur SHA-256-Hash gespeichert, signiertes HttpOnly-Cookie |
| Passwortwechsel | `credentialVersion` invalidiert alle anderen Sitzungen sofort |
| CSRF | Double-Submit-Cookie; Git- und Token-Routen sind begründet ausgenommen |
| Zugriffsprüfung | eine Funktion (`resolveRepositoryAccess`), eine SQL-Bedingung für alle Listen |
| Private Repositories | 404 statt 403, damit die Existenz nicht bestätigt wird |
| Path Traversal | Repository-Pfade aus UUIDs, nie aus Namen; `..` wird abgewiesen |
| Shell-Injection | `spawn` mit Argument-Array, niemals eine Shell; `--` vor Benutzerwerten |
| Git-Umgebung | Positivliste für Umgebungsvariablen (`GIT_SSH_COMMAND` u. ä. entfernt) |
| XSS in READMEs | gerendertes Markdown läuft durch eine Attribut- und Tag-Positivliste |
| Workflow-Secrets | nur als `FORGE_SECRET_*` im Container, nie unter Klarnamen; im Log durch `***` ersetzt |
| Workflow-Isolation | eigener Container je Job: CPU-, RAM- und PID-Grenze, `--cap-drop ALL`, `no-new-privileges`, read-only Dateisystem, wahlweise ohne Netz |
| Umgebungsdatei | Werte mit Zeilenumbruch werden verworfen, sonst ließen sich weitere Variablen einschleusen |
| Branch-Schutz | durchgesetzt im `pre-receive`-Hook, nicht nur in der Oberfläche |
| SSH-Zugang | nur Public-Key, nur `git-upload-pack` und `git-receive-pack`; keine Shell, kein SFTP, keine Portweiterleitung |
| Profilbilder | Typ an den Magic Bytes erkannt, nicht am Content-Type; SVG ausgeschlossen, weil es Skripte enthalten kann |
| Gists und Wiki | Dateinamen werden normalisiert statt interpretiert; ein Name wie `../../x` wird zu `x`, nicht zu einem Pfad |
| Webhooks | HMAC-SHA256-Signatur, SSRF-Schutz gegen interne Adressbereiche |
| Spiegelung | nur `https`, SSRF-Schutz in jeder Umgebung; Token verschlüsselt, über eine 0600-Datei an Git übergeben statt über die Kommandozeile, in Fehlermeldungen maskiert |
| Rohdateien | immer `octet-stream` als Anhang, `nosniff`, restriktive CSP |
| Secrets | AES-256-GCM, Schlüssel aus `ENCRYPTION_KEY` |
| Rate-Limiting | global pro Benutzer bzw. IP; Git-Routen ausgenommen |

## Tests

```bash
npm test
```

Die Tests laufen gegen eine echte Datenbank und echte Repositories: sie legen
Repositories auf der Platte an, klonen und pushen über HTTP und prüfen, dass
Unberechtigte weder lesen noch schreiben können. Nichts davon ist simuliert.

## Lizenz

Noch nicht festgelegt.
