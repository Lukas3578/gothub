# Deployment auf Render

Ziel: eine Änderung nach GitHub pushen, Render baut und startet alles Weitere
von selbst.

Diese Datei beschreibt, was dafür im Repository eingerichtet ist und welche
Punkte sich **nicht** aus dem Repository heraus lösen lassen.

---

## Die bestehenden Dienste

| Dienst | Adresse |
|---|---|
| Frontend | `https://forge-wuj4.onrender.com` |
| API | `https://gothub-q0p7.onrender.com` |
| Datenbank | bestehende PostgreSQL-Instanz auf Render |

Die beiden Adressen stehen an genau zwei Stellen im Repository:

- `apps/api/src/deployment.ts` – für die API (CORS, Klon-URLs, E-Mail-Links)
- `apps/web/.env.production` – für das Frontend (Adresse der API im Bundle)

Ein Umzug auf andere Adressen berührt nur diese zwei Dateien.

---

## Befehle der beiden Dienste

**API (`gothub`)**

```
Build Command:  npm ci --include=dev && npm run build:api
Start Command:  npm run start:api
Health Check:   /health
```

**Frontend (`forge`)**

Als *Static Site*:
```
Build Command:        npm ci --include=dev && npm run build:web
Publish Directory:    apps/web/dist
Rewrite Rule:         /*  →  /index.html   (Typ: Rewrite)
```

Als *Web Service*:
```
Build Command:  npm ci --include=dev && npm run build:web
Start Command:  npm run start:web
```

Zu `--include=dev`: TypeScript, Vite und das Build-Werkzeug stehen in den
devDependencies. Bei `NODE_ENV=production` lässt `npm ci` sie ohne dieses
Flag weg, und der Build schlägt mit „tsc: not found" fehl.

---

## Umgebungsvariablen der API

Nötig (im Dashboard setzen, nicht im Repository):

| Variable | Hinweis |
|---|---|
| `DATABASE_URL` | interne Verbindungsadresse der Render-Datenbank |
| `SESSION_SECRET` | `openssl rand -base64 48`, mindestens 32 Zeichen |
| `ENCRYPTION_KEY` | `openssl rand -hex 32`, genau 64 Hex-Zeichen |

Ändert sich `ENCRYPTION_KEY` später, sind alle verschlüsselten Werte
unlesbar: Workflow-Secrets, Webhook-Geheimnisse und Zwei-Faktor-Seeds. Der
Wert gehört einmal gesetzt und dann nicht mehr angefasst.

Empfohlen:

| Variable | Wert | Zweck |
|---|---|---|
| `NODE_ENV` | `production` | schaltet `Secure` für Cookies ein – ohne das funktioniert die Anmeldung über getrennte Domains nicht |
| `GIT_STORAGE_ROOT` | `/var/data/repositories` | siehe nächster Abschnitt |
| `UPLOAD_STORAGE_ROOT` | `/var/data/uploads` | dito |
| `SSH_ENABLED` | `false` | Render veröffentlicht je Dienst einen HTTP-Port; SSH wäre nicht erreichbar |

`PORT` setzt Render selbst. `PUBLIC_API_URL` und `PUBLIC_WEB_URL` haben
Vorgaben im Code und müssen nur gesetzt werden, wenn andere Adressen gelten.

---

## Der eine Punkt, der sich nicht im Code lösen lässt

**Git-Repositories liegen im Dateisystem. Das Dateisystem eines Render Web
Service ist flüchtig.**

Bei jedem Deployment und jedem Neustart wird es geleert. Die Datenbank ist ein
eigener Dienst und überlebt. Das Ergebnis: die Oberfläche zeigt Repositories
an, deren Git-Daten nicht mehr existieren. Klonen und der Dateibrowser
scheitern dann mit „Das Repository fehlt im Speicher".

Dasselbe gilt für Profilbilder, Release-Dateien und veröffentlichte Pakete.

Abhilfe – einmalig im Dashboard, da über das Repository nicht möglich:

1. API-Dienst → **Settings → Disks → Add Disk**
   - Name: `forge-data`
   - Mount Path: `/var/data`
   - Größe: 10 GB (später erweiterbar)
2. Umgebungsvariablen setzen:
   - `GIT_STORAGE_ROOT=/var/data/repositories`
   - `UPLOAD_STORAGE_ROOT=/var/data/uploads`

Zwei Nebenwirkungen: Datenträger setzen einen bezahlten Plan voraus, und ein
Dienst mit Datenträger kann nicht auf mehrere Instanzen skalieren.

Die API prüft das beim Start selbst und schreibt bei fehlenden Daten eine
Meldung mit genau diesem Hinweis ins Protokoll.

---

## Warum die Registrierung einen 403 lieferte

Frontend und API liegen auf **verschiedenen Hosts**. Daraus folgten zwei
Fehler, die beide im lokalen Betrieb nicht auftreten – dort teilen sich beide
den Host `localhost`, und Ports spielen bei Cookies keine Rolle.

**1. Das Frontend konnte den CSRF-Token nicht lesen.**

Der Schutz arbeitete nach dem Double-Submit-Verfahren: Der Server setzt ein
Cookie, der Client liest es über `document.cookie` und spiegelt den Wert in
einen Header. Der Server vergleicht beide Hälften.

Ein Browser lässt `document.cookie` aber ausschließlich Cookies des **eigenen**
Hosts lesen. Das Cookie der API ist für die Seite auf der Frontend-Domain
unsichtbar. `readCookie('fg_csrf')` lieferte also immer `null`, der Header
blieb leer, und die Prüfung musste scheitern. Jede schreibende Anfrage endete
mit 403 – unabhängig von den Zugangsdaten.

**2. Das Session-Cookie wäre auch danach nicht mitgesendet worden.**

Beide Cookies hatten `SameSite=Lax`. Ein Browser sendet solche Cookies bei
Cross-Site-Anfragen aus JavaScript nicht mit. Nach einem erfolgreichen Login
wäre der Benutzer bei der nächsten Anfrage wieder abgemeldet gewesen.

### Wie es jetzt gelöst ist

- Der Token kommt aus dem **Antwortkörper** von `GET /api/v1/auth/csrf`, nicht
  aus einem Cookie. Das Frontend hält ihn im Speicher und sendet ihn als
  Header.
- Das Cookie bleibt bestehen, ist jetzt aber `HttpOnly` – gelesen wird es nur
  serverseitig für den Vergleich.
- Cookies verwenden bei getrennten Hosts `SameSite=None; Secure`.
- Zusätzlich prüft der Server bei jeder schreibenden Anfrage die `Origin`.

### Warum das weiterhin schützt

Der Schutz wurde nicht gelockert, sondern verlagert:

- Den Token kann nur eine Seite lesen, deren Origin in der CORS-Liste steht.
  Eine fremde Seite bekommt die Antwort vom Browser nicht ausgeliefert.
- Einen eigenen Header kann eine fremde Seite nicht cross-origin setzen, ohne
  einen Preflight auszulösen, den CORS für sie ablehnt.
- Das Cookie allein genügt nicht: es ist `HttpOnly`, und der Vergleich
  verlangt beide Hälften.
- Die Origin-Prüfung fängt zusätzlich den Fall ab, dass ein Token auf anderem
  Weg bekannt würde.

Nachgewiesen in `apps/api/src/__tests__/cross-site.test.ts`. Die Tests
stellen einen Browser nach, der Cookies pro Host trennt und `SameSite=Lax`
cross-site verwirft:

```bash
npm run test:deployment
```

---

## Was beim Push passiert

1. Render startet für beide Dienste einen Build.
2. API: `npm run build:api` baut `@forge/shared` nach JavaScript und
   übersetzt die API nach `apps/api/dist`.
3. API-Start: `npm run start:api` führt zuerst die Migrationen aus, dann
   `node apps/api/dist/server.js`.
4. Frontend: `npm run build:web` erzeugt `apps/web/dist`, mit der API-Adresse
   aus `.env.production` im Bundle.

Die Migrationen sind durch einen PostgreSQL-Advisory-Lock gegen gleichzeitige
Läufe abgesichert und brechen den Start ab, wenn sie fehlschlagen. Ein Start
mit halb migrierter Datenbank ist schlimmer als kein Start. Die vorhandenen
Migrationen sind additiv und löschen keine Daten.

---

## Fehlersuche

**Prüfen, welche Adressen wirklich gelten**

```bash
curl https://gothub-q0p7.onrender.com/api/v1/meta
```

Die Antwort enthält:

```json
{
  "deployment": {
    "apiUrl": "https://gothub-q0p7.onrender.com",
    "webUrl": "https://forge-wuj4.onrender.com",
    "crossSite": true,
    "cookieSameSite": "none",
    "cookieSecure": true
  }
}
```

| Beobachtung | Ursache |
|---|---|
| `webUrl` weicht von der Adresse im Browser ab | CORS lehnt die Anfragen des Frontends ab. `PUBLIC_WEB_URL` korrigieren. |
| `cookieSameSite` ist `lax` bei `crossSite: true` | `NODE_ENV` steht nicht auf `production`. Die Anmeldung kann so nicht funktionieren. |
| `cookieSecure` ist `false` | dito. |

**403 bei der Registrierung**

```bash
curl -i -c jar.txt https://gothub-q0p7.onrender.com/api/v1/auth/csrf
```

Das `Set-Cookie` muss `HttpOnly; Secure; SameSite=None` enthalten und der
Körper einen `csrfToken`. Fehlt `SameSite=None`, steht `NODE_ENV` nicht auf
`production`.

**Build bricht mit „tsc: not found" ab**

`--include=dev` fehlt im Build Command.

**Dienst startet nicht, Protokoll nennt einen Konfigurationsfehler**

`SESSION_SECRET` oder `ENCRYPTION_KEY` fehlt oder hat die falsche Länge. Die
API prüft das beim Start und bricht absichtlich ab, statt mit unsicheren
Werten zu laufen.

---

## Wenn ein KI-Assistent das Repository nicht erreicht

Fehlerbild im Assistenten:

```
fatal: unable to access 'https://gothub-q0p7.onrender.com/git/<benutzer>/<repo>.git/':
CONNECT tunnel failed, response 403
```

Das ist **kein Fehler auf dem Server**. `CONNECT tunnel failed` meldet der
Proxy des Assistenten, bevor die Anfrage den Server erreicht. Die meisten
Assistenten laufen in einem Sandkasten, der nur eine feste Liste von Adressen
zulässt; GitHub steht darauf, `onrender.com` nicht. Der Server sieht von so
einer Anfrage nichts, und keine Änderung am Code ändert daran etwas.

Zwei Wege:

**1. Die Adresse im Assistenten erlauben.** Bei Claude unter
*Einstellungen → Capabilities* `gothub-q0p7.onrender.com` zur Liste der
erlaubten Domains hinzufügen. Wirkt sofort, ohne Änderung am Projekt. Gilt
nur für diesen einen Assistenten.

**2. Nach GitHub spiegeln.** *Repository → Einstellungen → Spiegelung*, Richtung
*hinaus*, Adresse des GitHub-Repositories und ein Personal Access Token mit
`repo`. Danach schiebt Forge nach jedem Push automatisch weiter. Du arbeitest
weiter gegen Forge; der Assistent klont die Kopie auf GitHub und kommt damit
überall durch.

Bei einer Spiegelung hinaus ist das GitHub-Repository eine Kopie: Push dorthin
würde beim nächsten Lauf überschrieben. Änderungen des Assistenten kommen über
einen Pull Request oder einen Patch zurück nach Forge.

Der Haken *exakte Kopie* schaltet `git push --mirror`. Das löscht auf der
Gegenseite Branches, die es in Forge nicht gibt. Ohne den Haken werden nur
Branches und Tags aktualisiert, gelöscht wird nichts.

---

## Was auf Render nicht läuft

| Funktion | Grund |
|---|---|
| Git über SSH | Render veröffentlicht je Dienst einen HTTP-Port |
| CI-Workflows | Der Runner braucht Docker. Workflows bleiben in der Warteschlange, bis ein Runner auf eigener Hardware verbunden wird. |
| E-Mail-Versand | `MAIL_TRANSPORT=console` schreibt in das Protokoll. Für echten Versand `smtp` setzen und die `SMTP_*`-Werte ergänzen. |

Diese Funktionen stören den Betrieb nicht; sie sind in der Oberfläche
vorhanden, führen ohne die jeweilige Voraussetzung aber zu keinem Ergebnis.
