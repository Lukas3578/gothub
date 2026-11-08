# Vortex Git – Umzug von GitHub auf unseren eigenen Server

Vortex Git ist diese Plattform (gothub/Forge), eingerichtet unter **https://git.vortexpvp.eu**.
Sie spricht nach außen dieselbe Sprache wie GitHub, deshalb funktionieren Launcher-Updates,
Downloads, der Admin-Bereich und die Build-Workflows fast unverändert:

| GitHub                                                      | Vortex Git                                                        |
|-------------------------------------------------------------|-------------------------------------------------------------------|
| `api.github.com/repos/…`                                    | `git.vortexpvp.eu/api/v3/repos/…`                                 |
| `uploads.github.com/repos/…/releases/<id>/assets`           | `git.vortexpvp.eu/api/uploads/repos/…/releases/<id>/assets`       |
| `github.com/<o>/<r>/releases/download/<tag>/<datei>`        | `git.vortexpvp.eu/<o>/<r>/releases/download/<tag>/<datei>`        |
| `github.com/<o>/<r>/releases.atom` (electron-updater)       | `git.vortexpvp.eu/<o>/<r>/releases.atom`                          |
| `raw.githubusercontent.com/<o>/<r>/<ref>/<pfad>`            | `git.vortexpvp.eu/<o>/<r>/raw/<ref>/<pfad>`                       |
| `git clone https://github.com/<o>/<r>.git`                  | `git clone https://git.vortexpvp.eu/<o>/<r>.git`                  |
| GitHub Actions (`.github/workflows`)                        | eigener Runner, `.forge/workflows` (oder `.github/workflows`)     |
| `GITHUB_TOKEN` im Workflow                                  | Repo-Secret `FORGE_TOKEN` (auch über `github.token` erreichbar)   |

Alles läuft auf dem code-server neben dem Freunde-Server. Daten liegen in `data/`
(Repos, Releases, Datenbank) – diesen Ordner sichern.

---

## 1. Plattform installieren (einmal, ca. 5 Minuten)

Im Terminal des code-servers:

```bash
cd /root
git clone -b vortex-selfhost https://github.com/Lukas3578/gothub.git
cd gothub
bash scripts/vortex-setup.sh
```

Das Skript legt `.env` mit neuen geheimen Schlüsseln an, baut alles, migriert die
Datenbank und startet `vortex-git` in pm2 auf Port 4100. Am Ende steht „API läuft“.

Aktualisieren später: `cd /root/gothub && git pull && bash scripts/vortex-setup.sh`.

## 2. Cloudflare-Tunnel: git.vortexpvp.eu

Genau wie bei stats.vortexpvp.eu und friends.vortexpvp.eu einen weiteren Eintrag anlegen:

- **Im Cloudflare-Dashboard** (Zero Trust → Networks → Tunnels → euer Tunnel → Public Hostname → Add):
  Subdomain `git`, Domain `vortexpvp.eu`, Service `HTTP` → `localhost:4100`.
- **Oder in der config.yml** von cloudflared bei `ingress:` vor der letzten Zeile:
  ```yaml
    - hostname: git.vortexpvp.eu
      service: http://localhost:4100
  ```
  danach `cloudflared tunnel route dns <tunnel-name> git.vortexpvp.eu` und cloudflared neu starten.

Test: https://git.vortexpvp.eu öffnet die Oberfläche.

## 3. Konten anlegen, Registrierung schließen

1. Auf https://git.vortexpvp.eu registrieren. **Das erste Konto wird Administrator.**
2. Marcinator registriert sich ebenfalls.
3. In `/root/gothub/.env` die Zeile `ALLOW_REGISTRATION=true` auf `false` ändern und
   `pm2 restart vortex-git`. Sonst könnte jeder ein Konto anlegen.

## 4. Organisation und Repos anlegen

Oben rechts → Einstellungen → **Zugriffstokens** → Token erstellen (Name z. B. „Server“).
Das Token (`fgp_…`) nirgends posten, nur ins Terminal einfügen:

```bash
cd /root/gothub
bash scripts/vortex-repos.sh fgp_DEINTOKEN
```

Legt die Organisation `vortex` und die Repos `Vortex-Launcher`, `Vortex-Client`
(öffentlich), `Vortex-Addon-v2` (privat) und `Vortex-Client-Cosmetics` an.
Marcinator in der Organisation als Mitglied/Owner hinzufügen (Organisation → Mitglieder).

## 5. Code hochladen

Die Dateien `launcher.bundle`, `client.bundle`, `addon.bundle` (aus dem Chat) im code-server
nach `/root/vortex-umzug/` hochladen. Sie enthalten den letzten Stand von GitHub plus die
Umstellung auf Vortex Git.

```bash
cd /root/vortex-umzug
for r in launcher:Vortex-Launcher client:Vortex-Client addon:Vortex-Addon-v2; do
  b=${r%%:*}; n=${r#*:}
  git clone -q $b.bundle $n && git -C $n push http://127.0.0.1:4100/vortex/$n.git main
done
```

Benutzername = dein Name auf Vortex Git, Passwort = das Zugriffstoken.
**Lokal pushen (127.0.0.1)**, nicht über git.vortexpvp.eu: Cloudflare lässt pro Anfrage nur
100 MB durch, das erste Hochladen ist größer.

**Hat jemand einen neueren vollständigen Stand** (mit ganzer Historie)? Dann lieber den nehmen:
- Launcher: `git am launcher-auf-gothub.patch`, dann wie oben pushen.
- Client und Addon: `python3 /root/gothub/tools/github-umzug/umstellen.py` im Repo-Ordner,
  `git add -A && git commit -m "Auf Vortex Git umgestellt"`, pushen.

**Vortex-Client-Cosmetics** (die `cosmetics.json` für Capes im Spiel) haben wir hier nicht.
Wer sie hat, pusht sie nach `vortex/Vortex-Client-Cosmetics` (Branch `main`).

Danach arbeitet ihr normal weiter: `git remote set-url origin https://git.vortexpvp.eu/vortex/<Repo>.git`.

## 6. Secret FORGE_TOKEN

In **jedem** der drei Repos: Einstellungen → Secrets → `FORGE_TOKEN` = ein Zugriffstoken
mit Schreibrecht (am besten ein eigenes Token „Builds“). Damit legen die Builds Releases an.
Es ersetzt den automatischen `GITHUB_TOKEN` von GitHub.

## 7. Build-Runner starten (ersetzt GitHub Actions)

In jedem Repo: Einstellungen → **Runner** → Runner hinzufügen (Labels: `self-hosted`) → Token kopieren.

```bash
cd /root/gothub
bash scripts/vortex-runner.sh launcher <runner-token-launcher>
bash scripts/vortex-runner.sh client   <runner-token-client>
bash scripts/vortex-runner.sh addon    <runner-token-addon>
```

Die Runner bauen direkt auf dem Server (kein Docker nötig), als eigener Benutzer
`vortex-runner` ohne Zugriff auf `/root` – also auch nicht auf `store.env`. Sie nehmen nur
Jobs aus ihrem Repo der Organisation `vortex` an. JDK 21/25, Go und Node lädt der Runner
beim ersten Build selbst herunter.

Nötig auf dem Server: `git`, `curl`, `tar`, `python3`, `bash`
(Debian/Ubuntu: `apt install -y git curl tar xz-utils python3`).
Optional für Symbol und Versionsinfo in der Launcher-EXE: `apt install -y wine64`.

## 8. Clip-Werkzeuge für den Launcher-Build

Der Launcher-Build braucht `ffmpeg.exe` und `vortex-audio.exe` aus dem Release **clip-tools**
(früher baute die GitHub-Action sie auf Windows; das kann unser Linux-Runner nicht).

1. Auf einem PC mit installiertem Launcher 2.37 die Dateien aus
   `%LOCALAPPDATA%\Programs\Vortex Client\resources\app.asar.unpacked\assets\clips\` nehmen.
2. Auf Vortex Git: `vortex/Vortex-Launcher` → Releases → Neues Release, Tag `clip-tools`,
   als Vorabversion, beide `.exe` hochladen.

## 9. Erster Launcher-Build und Freigabe

Der Push aus Schritt 5 startet „Launcher bauen und veröffentlichen“ (Repo → Actions).
Fertig ist er, wenn das Release `v2.38.<Nummer>` mit `latest.yml` und der Setup-EXE da ist.
Es ist erst eine **Beta**. Zum ersten Mal für alle freigeben:

```bash
cd /root/vortex-umzug/Vortex-Launcher
FORGE_TOKEN=fgp_DEINTOKEN FORGE_HOST=http://127.0.0.1:4100 GITHUB_REPOSITORY=vortex/Vortex-Launcher \
  node tools/forge/release-api.mjs promote v2.38.<Nummer>
```

Ab dann geht Freigeben wieder im Launcher (Admin → Launcher versions), angemeldet mit
einem Vortex-Git-Token statt dem GitHub-Token.

Client/Addon: Nach ihrem ersten Build im Launcher-Repo den Workflow
„Client und Addon automatisch veröffentlichen“ von Hand starten, dann im Launcher
Admin → „Für alle freigeben“.

## 10. Wichtig für die Spieler

Installierte Launcher bis 2.37 fragen noch bei GitHub nach Updates – dort ist alles weg.
**Jeder muss den Launcher einmal neu von https://stats.vortexpvp.eu/download installieren**
(Einstellungen, Welten und Konten bleiben erhalten). Ab 2.38 kommen Updates von Vortex Git.
Am besten im Discord ankündigen.

Einladungslinks aus dem Launcher zeigen jetzt auf `https://stats.vortexpvp.eu/join`
(neues Website-Addon nötig).

## Probleme?

- `pm2 logs vortex-git` – Server
- `pm2 logs vortex-runner-launcher` – Runner
- Repo → Actions → Lauf anklicken – Build-Log mit allen Schritten
