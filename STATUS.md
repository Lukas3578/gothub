# Status

Maßstab dieser Liste: durch automatisierte Tests oder einen nachvollzogenen
Durchlauf gegen den laufenden Server belegt. Was nur im Schema vorbereitet ist,
steht unter „Nicht implementiert" – nicht bei den fertigen Funktionen.

Stand: 25.10.2026 · 225 Tests (194 Backend, 31 Frontend), alle grün ·
41.900 Zeilen · 62 Tabellen · 217 HTTP-Endpunkte · vier Pakete typgeprüft

---

## Fertig und belegt

### Authentifizierung und Konten
Registrierung, Anmeldung über Benutzername oder E-Mail, Abmeldung,
E-Mail-Verifizierung, Passwort zurücksetzen und ändern, Sitzungsverwaltung mit
Einzelwiderruf, Zwei-Faktor-Authentifizierung (TOTP mit QR-Code und
Wiederherstellungscodes), persönliche Zugriffstokens, SSH-Schlüssel,
Profilbild, Profil bearbeiten, Benutzername ändern, Folgen, Blockieren, Melden.

*Belegt:* Ein Passwortwechsel beendet nachweislich alle übrigen Sitzungen; ein
widerrufenes Token wird sofort abgelehnt; falsches Passwort und unbekannter
Benutzer liefern dieselbe Meldung.

### Repositories und Git
Anlegen mit Sichtbarkeit öffentlich/intern/privat, Startinhalt (README,
.gitignore, Lizenz), Umbenennen, Übertragen, Archivieren, Soft-Delete, Forken,
Sterne, Beobachten, Themen, Spracherkennung, Suche und Filter.

Git über **HTTPS und SSH**: `clone`, `push`, `fetch`, `pull`, neue Branches,
Tags, Protokoll v1 und v2.

Dateibrowser mit Syntaxhervorhebung, README-Rendering, Blame, Rohdownload,
Dateien anlegen/ändern/umbenennen/löschen über die Oberfläche mit Schutz gegen
das Überschreiben fremder Änderungen.

Branches, Tags, Commit-Historie mit Suche, Commit-Diffs mit Hunks und
Umbenennungserkennung, Vergleich zweier Refs mit Konfliktprüfung.

*Belegt:* `git clone` und `git push` gegen den laufenden Server über beide
Transportwege; private Repositories sind für Fremde über API, HTTPS und SSH
unsichtbar.

### Git über SSH
Eigener SSH-Dienst mit Public-Key-Anmeldung. Er führt **ausschließlich**
`git-upload-pack` und `git-receive-pack` aus; Shell, SFTP, Portweiterleitung
und beliebige Kommandos werden abgelehnt. Die Rechteprüfung ist dieselbe
Funktion wie bei HTTPS – es gibt keinen zweiten Pfad, über den SSH mehr dürfte.
Der Hostschlüssel wird beim ersten Start erzeugt und bleibt danach stabil.

*Belegt:* Mit einem hinterlegten Schlüssel liefert `git-upload-pack` die
Ref-Ankündigung (440 Byte, beginnend mit dem HEAD-Hash). `ls -la /`,
`/bin/bash` und `git-upload-pack '/../../etc/passwd'` werden jeweils mit
Exit-Code 1 und erklärender Meldung abgewiesen; ein unbekanntes Repository
liefert „nicht gefunden".

### Branch-Schutz
Muster-basierte Regeln (`main`, `release/*`), Pflicht zu Pull Requests,
Mindestanzahl Zustimmungen, Blockade von Force-Push und Löschung,
Status-Checks, lineare Historie.

*Belegt:* Durchgesetzt im `pre-receive`-Hook, also auch gegen `git push` und
`git push --force` direkt – über HTTPS wie über SSH.

### Issues
Anlegen, bearbeiten, schließen und wieder öffnen, Kommentare, Labels,
Milestones mit Fortschritt, Assignees, Reaktionen, Verknüpfungen,
Ereignisverlauf, Unterhaltung sperren, Filter nach Zustand, Label, Assignee,
Autor und Milestone, Volltextsuche, Markdown mit Vorschau.

### Pull Requests
Anlegen aus Branch oder Fork, Diff- und Commit-Ansicht, Reviews mit
Zeilenkommentaren und Threads, Reviewer anfragen, Draft-PRs, Merge per
Merge-Commit, Squash **und echtem Rebase**, Konflikterkennung über
`merge-tree`, Merge-Prüfungen einzeln ausgewiesen, automatisches Schließen
referenzierter Issues.

*Belegt:* Vollständiger Durchlauf live: Issue mit Erwähnung → Branch → PR →
Merge ohne Review abgelehnt („Mindestens 1 Zustimmung") → Review mit
Zeilenkommentar → Squash-Merge → Issue automatisch geschlossen. Ein
Rebase-Merge zweier Commits erzeugt zwei neue Commits mit je einem Elternteil,
also lineare Historie ohne Merge-Commit.

### Organisationen und Teams
Organisationen anlegen und verwalten, Mitglieder mit Rollen (Owner, Admin,
Member), Einladungen, Teams mit Standardberechtigung, Team-Mitglieder,
Repository-Zuweisung an Teams, Organisations-Avatar, Organisations-Dashboard.

*Belegt:* Ein Organisationsmitglied sieht ein privates Repository erst, nachdem
sein Team Zugriff erhalten hat – vorher 404, danach `write`. Der letzte
Eigentümer kann nicht entfernt werden.

### Wiki
Pro Repository ein eigenes Git-Repository (`<id>.wiki.git`) mit Markdown-Seiten,
Verlauf je Seite, Vorschau beim Bearbeiten, optimistischer Sperre gegen
gleichzeitige Änderungen. Wird erst beim ersten Schreibzugriff angelegt.

*Belegt:* Seitenname `../../boese` wird zu `boese` normalisiert, nicht zu einem
Pfad nach außen; Fremde ohne Schreibrecht erhalten 403, Leser eines
öffentlichen Repositories 200.

### Gists
Code-Schnipsel als eigenständige Git-Repositories: mehrere Dateien, Historie,
klonbar über HTTPS und SSH, Sterne, Kommentare, öffentlich oder nicht gelistet.

*Belegt:* Ein Gist lässt sich klonen und liefert seine Dateien; ein Push darauf
wird mit 403 abgewiesen, weil sonst die Dateiliste in der Datenbank
auseinanderliefe. Verzeichnisse im Dateinamen werden abgelehnt.

### Projektboards
Kanban-Boards je Repository mit Spalten, Notizkarten und verknüpften Issues,
Verschieben per Drag-and-drop, Positionierung mit Lückenverfahren statt
Neunummerierung aller Karten.

*Belegt:* Eine Karte lässt sich zwischen Spalten verschieben; eine fremde
Issue-Nummer wird abgelehnt, ebenso eine Karte ohne Notiz und ohne Issue.

### Benachrichtigungen
Erzeugung bei Anlegen, Kommentar, Zustandswechsel, Review, Review-Anfrage,
Zuweisung, Erwähnung und fehlgeschlagenem Workflow. Gründe werden nach
Spezifität vergeben (Erwähnung schlägt Beobachtung). Als gelesen markieren
einzeln und gesamt, Einstellungen, Echtzeit-Updates per Server-Sent Events.

*Belegt:* Niemand wird über die eigene Handlung benachrichtigt; niemand ohne
Leserecht erhält eine Benachrichtigung zu einem privaten Repository.

### CI/CD
Workflow-Dateien werden aus `.github/workflows` **und** `.forge/workflows`
gelesen; das YAML-Format ist das von GitHub Actions. `actions/checkout`,
`actions/setup-node` und `actions/upload-artifact` sind unter ihrem
GitHub-Namen umgesetzt, die Version hinter `@` wird ignoriert. Einen
Marktplatz gibt es nicht – fremder Code mit Zugriff auf Secrets und den
Docker-Socket wäre ein erhebliches Risiko.

Schlüssel, die hier nichts bewirken, werden abgewiesen statt übergangen:
`strategy`, `services`, `defaults`, `outputs`, `environment`, `concurrency`,
`permissions`. Eine Datei mit `strategy: matrix` liefe sonst als ein
einziger Job, ohne dass jemand die fehlenden bemerkt.

*Belegt:* vier Tests, darunter eine unveränderte GitHub-CI-Datei und die
Ablehnung einer Matrix.

*Nicht belegt:* `actions/setup-node` lädt Node von nodejs.org – in dieser
Umgebung ist weder Docker Hub noch nodejs.org erreichbar, der Weg ist also
geschrieben, aber nicht durchlaufen.

**Darunter unverändert:**
Parser mit Validierung, Trigger
für Push, Pull Request, manuell und zeitgesteuert (Cron), Job-Queue mit
Abhängigkeiten (`needs`) und Label-Zuweisung, Runner-Registrierung mit Lease
und Heartbeat, Ausführung in isolierten Docker-Containern, Log-Streaming,
Secrets, Variablen, Artefakte, Abbruch, Wiederholung.

Container-Isolation: `--cpus`, `--memory`, `--pids-limit`, `--network`,
`--read-only` mit beschreibbarem `/workspace` und `/tmp`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, Aufräumen nach Job-Ende.

*Belegt:* Push eines Workflows löst einen Lauf aus, ein Runner übernimmt ihn,
führt die Schritte in einem Container aus (`node -v` liefert v22.22.0 aus dem
Container), schreibt Logs, lädt ein Artefakt hoch und meldet den Status. Ein
abhängiger Job startet erst danach. `exit 3` führt zu `failure`, der
Folgeschritt wird `skipped`. Ein Secret ist in `run:` und in `env:` verfügbar,
erscheint im Log als `***` und steht nicht unter seinem Klarnamen in der
Umgebung.

### Releases und Pakete
Releases mit Tag-Erzeugung, Beschreibung, Pre-Release und Entwurf,
Asset-Upload und -Download mit Zählung.

**npm-kompatible Registry**: `npm publish`, `npm install` und `npm dist-tag`
funktionieren gegen Forge. Scoped-Pakete werden dem gleichnamigen Benutzer oder
der gleichnamigen Organisation zugeordnet; das Überschreiben einer
veröffentlichten Version wird abgelehnt.

*Belegt:* `npm publish` eines Pakets und `npm install` desselben Pakets in ein
zweites Projekt; `require()` des installierten Moduls liefert den erwarteten
Wert.

### Suche
Repositories, Code, Commits, Issues, Pull Requests, Benutzer und
Organisationen mit Filtern nach Sprache, Repository, Autor und Datum.

*Belegt:* Private Repositories erscheinen für Unberechtigte in keinem der
Suchbereiche.

### Webhooks
Verwaltung pro Repository und Organisation, Ereignisauswahl, HMAC-SHA256
signierte Zustellung, Wiederholung mit Backoff, Zustellhistorie,
Deaktivierung nach wiederholtem Fehlschlag.

*Belegt:* SSRF-Schutz erkennt interne Adressbereiche; das Geheimnis wird nur
beim Anlegen zurückgegeben.

### Datenhaltung: libSQL / Turso
Das gesamte Schema läuft auf libSQL. Lokal ist die Datenbank eine Datei –
kein Server, kein Container; auch die Tests legen sich vor jedem Lauf eine
eigene Datei an. In Betrieb zeigt dieselbe Variable auf Turso.

Portiert wurden: 17 Enums (jetzt Text mit Wertebereich), 18 JSONB-Spalten
(JSON-Text), 174 UUID- und 110 Zeitstempel-Spalten, 33 Postgres-Casts, der
Advisory-Lock der Migration, `ILIKE`, `GREATEST`, `now()`, die
jsonb-Funktionen und die Jobvergabe an Runner, die vorher auf
`FOR UPDATE SKIP LOCKED` beruhte.

*Belegt:* dieselben 194 Backend-Tests wie vorher, unverändert.

*Nicht belegt:* der Betrieb gegen eine echte Turso-Instanz. Geprüft ist der
Dialekt gegen eine lokale libSQL-Datei – derselbe Code, dasselbe Protokoll,
aber ohne Netz dazwischen. Ein Token hat diese Umgebung nicht.

### Dateien im Browser bearbeiten
Anlegen, Bearbeiten, Umbenennen, Löschen und Hochladen mehrerer Dateien, je
mit Commit-Nachricht und optionaler Beschreibung. Editor ist CodeMirror 6
(Zeilennummern, Syntaxhervorhebung aus dem Farbsystem der Anwendung,
Klammernpaare, Rückgängig-Historie), für Markdown mit Vorschau. Upload per
Auswahl oder Drag-and-drop, Binärdateien eingeschlossen. Wahlweise direkt auf
den Branch oder auf einen neuen Branch, der anschließend ins
Pull-Request-Formular führt – auch der Weg an einem geschützten Branch vorbei.

*Belegt:* 16 API-Tests und ein vollständiger Durchlauf im echten Browser
(siehe „Browserdurchlauf"). Geprüft sind unter anderem: Umlaute und
CRLF kommen unverändert zurück, Umbenennen hinterlässt keine Kopie, ein
Upload von drei Dateien ergibt genau einen Commit, Binärinhalte bleiben
unverfälscht, ein doppelter Pfad wird abgewiesen, ohne einen halben Commit zu
hinterlassen, ein veralteter Stand wird nicht überschrieben, ein geschützter
Branch lässt direktes Schreiben nicht zu, den Umweg über einen Branch aber
schon.

### Spiegelung auf andere Git-Hoster
Je Repository eine Spiegelung, Richtung *hinaus* (nach jedem Push schiebt
Forge an die Gegenseite weiter) oder *herein* (Forge holt alle fünf Minuten).
Beide Richtungen gleichzeitig werden abgelehnt, weil sie sich gegenseitig
überschreiben würden. Verbindungsprüfung über `ls-remote` vor dem ersten
echten Lauf, Pausieren, manuelles Auslösen, Statusanzeige mit letzter
Fehlermeldung. Eine Lease verhindert zwei gleichzeitige Läufe.

Anlass: Werkzeuge, die eine selbst betriebene Instanz nicht erreichen – der
Sandkasten vieler KI-Assistenten lässt nur eine feste Liste von Adressen zu.

*Belegt:* 24 Tests. Die Adressprüfung weist `http`, eingebettete Zugangsdaten,
Loopback, private Netze und die Cloud-Metadaten-Adresse ab. Das Token kommt
weder aus der Einzelansicht noch aus der Liste zurück und steht verschlüsselt
in der Datenbank; ohne neue Eingabe bleibt es beim Bearbeiten erhalten, ein
leerer String entfernt es. Die Maskierung in Fehlermeldungen ist einzeln
geprüft.

*Nicht belegt:* eine echte Übertragung nach GitHub. Dafür braucht es ein
gültiges Token und eine Netzverbindung; beides lässt sich in einem Test nicht
ehrlich nachstellen. Geprüft ist der Weg bis zum Aufruf von Git, nicht die
Übertragung selbst.

### E-Mail
Zwei Transportwege: `console` schreibt Nachrichten in das Serverprotokoll
(Entwicklung), `smtp` verschickt über einen echten Mailserver mit STARTTLS
bzw. implizitem TLS. Eine Admin-Route prüft die Verbindung, damit eine
Fehlkonfiguration auffällt, bevor jemand vergeblich auf eine Bestätigungsmail
wartet.

### Profilbilder
Upload für Benutzer und Organisationen. Der Dateityp wird an den ersten Bytes
erkannt, nicht am mitgeschickten Content-Type; ausgeliefert wird mit
`nosniff` und restriktiver CSP.

*Belegt:* Ein gültiges PNG kommt unverändert zurück. Eine HTML-Datei mit
`content-type: image/png` und eine SVG-Datei werden beide abgewiesen – SVG
grundsätzlich, weil es Skripte enthalten kann.

### Administration
Benutzer-, Repository-, Organisations- und Runner-Verwaltung,
Plattformstatistik, Wartungsmodus, Audit-Log-Ansicht, Abuse-Reports,
Rate-Limit-Übersicht, Mailtransport-Prüfung.

### Oberfläche
Eigenes Design-System: eckige Elemente, dezente Linien, warme Neutraltöne, ein
Akzentton, keine Verläufe, keine Schatten – Tiefe entsteht über
Flächenhelligkeit und Linien. Helles und dunkles Theme. Responsiv ab
Telefonbreite.

Überarbeitet nach einem Durchgang im echten Browser:

- Die helle Leinwand war praktisch weiß; Flächen hoben sich nur durch ihre
  Linie ab. Ein spürbarer Schritt zwischen Leinwand und Fläche stellt die
  Ebenen her.
- Der Akzent erreichte mit weißer Schrift nur 4,4:1 und verfehlte die
  Schwelle für Text auf Schaltflächen; er ist jetzt tiefer.
- Fließtext liegt bei 15 px mit begrenzter Zeilenlänge (72 Zeichen).
  Über die volle Spaltenbreite wurden Zeilen rund 160 Zeichen lang.
- In Markdown trugen h1 und h2 je eine Trennlinie, was READMEs wie einen
  Stapel Linien wirken ließ; jetzt nur noch h1.
- Avatarfarben kamen aus dem vollen Farbkreis bei 42 % Sättigung und
  stellten regelmäßig ein kräftiges Indigo neben den warmen Akzent. Jetzt
  zwölf feste Stufen bei 24 %.
- Issues und Pull Requests haben eine senkrechte Linie, die Eröffnungsbeitrag,
  Kommentare und Ereignisse als Abfolge zusammenhält.
- Die Seitenbreite stand an sieben Stellen im Quelltext; jetzt an einer, und
  bei 1280 statt 1400 px.

Zweiter Durchgang:

- Repository-Zeilen sind ganzflächig anklickbar statt nur am Namen, und der
  Name steht in Textfarbe statt durchgehend im Akzent – zwanzig eingefärbte
  Namen untereinander lesen sich als Farbfläche, nicht als Liste.
- Eingabefelder heben sich von der Fläche ab, auf der sie stehen.
- Leere Zustände belegten mit 56 px Luft mehr Fläche als eine gefüllte
  Liste; jetzt 40 px und leisere Schrift.
- Auswahlfelder schnitten ihre eigene Beschriftung ab („Zuletzt aktualisier").
- „1 Commits", „1 Dateien", „1 Kommentare": Einzahl und Mehrzahl werden
  unterschieden.

Seiten: Landing, Anmeldung, Registrierung, Passwort vergessen/zurücksetzen,
Dashboard, Repository anlegen, Entdecken, Suche, Benachrichtigungen, Profil,
Gists (Liste, neu, Detail), Pakete, Organisation anlegen und verwalten,
Administration (Benutzer, Repositories, Runner, Audit), Einstellungen (Profil
mit Avatar, Konto, Sitzungen, Tokens, SSH-Schlüssel, Sicherheit) sowie je
Repository: Code, Dateiansicht, Commits, Commit-Detail, Branches, Tags, Issues,
Pull Requests mit Diff und Review, Actions mit Logs, Releases, Wiki,
Projektboards und Einstellungen.

---

## Behobene Fehler aus dem Durchspielen

Diese Fehler fielen erst beim echten Durchlauf auf, nicht beim Schreiben:

1. **Ein relativer Datenbankpfad zeigte auf zwei verschiedene Dateien.**
   `file:./data/forge.db` ist relativ zum Arbeitsverzeichnis, und das
   unterscheidet sich je nach Startweg: `npm run dev:api` startet in
   `apps/api`, `npm start` in der Wurzel. Der Server fand die migrierte
   Datenbank nicht und meldete „no such table: namespaces". Jetzt wird gegen
   die Projektwurzel aufgelöst, und die aufgelöste Adresse steht beim Start
   im Protokoll.

2. **Doppelte Einträge lieferten 500 statt 409.** Die Erkennung hing am
   Namen des PostgreSQL-Index in der Fehlermeldung; SQLite nennt stattdessen
   die Spalten. Statt den Vergleich an zehn Stellen zu flicken, prüft das
   jetzt eine Funktion, die beide Formen kennt.

3. **`strategy: matrix` wurde stillschweigend verworfen.** Zod entfernt
   unbekannte Schlüssel ohne Hinweis, also lief ein Job, der neunmal laufen
   sollte, genau einmal – und niemand sah, dass acht Läufe fehlten. Solche
   Schlüssel führen jetzt zu einem Fehler, der benennt, was stattdessen geht.

4. **Zwei Kopien derselben CodeMirror-Pakete.** Beim Nachinstallieren waren
   `@codemirror/state`, `view`, `language` und `@lezer/highlight` mit einer
   älteren Untergrenze angegeben worden, als npm ohnehin aufgelöst hatte.
   Ergebnis: eine zweite, verschachtelte Kopie je Paket. Die Marken (`tags`)
   aus der einen Kopie sind andere Objekte als die der anderen, also griff im
   Editor keine einzige Hervorhebungsregel – Code stand einfarbig da. Weder
   Typprüfung noch Rendertests sehen so etwas; sichtbar wurde es erst im
   Browser. Behoben, indem die Versionsbereiche auf den bereits aufgelösten
   Stand angehoben wurden, sodass npm wieder auf je eine Kopie zusammenführt.

5. **Der Editor verschluckte Zeichen beim schnellen Tippen.** Jede Eingabe
   meldete den neuen Text nach oben, React stellte ihn verzögert wieder zu,
   und der Abgleich schrieb diesen inzwischen veralteten Stand zurück in das
   Dokument. Aus „MIT. Siehe README." wurde „MIT. Siehe .". Behoben über den
   Fokus: tippt jemand, ist der Editor die Quelle und ein von außen
   eintreffender Wert wird nicht übernommen.

6. **Die Sprache landete an einer bereits verworfenen Editor-Instanz.** Das
   Nachladen des Sprachmoduls ist asynchron, der Aufbau nicht. Fiel das
   Ergebnis zwischen Aufbau und dem zusätzlichen Neuaufbau an, den React im
   Entwicklungsmodus vornimmt, stand der neue Editor ohne Sprache da. Das
   Ergebnis wird jetzt festgehalten und nach jedem Aufbau erneut angelegt.

7. **`spawn git ENOENT` als Meldung für ein fehlendes Repository.** Node
   meldet denselben Fehler, wenn das Arbeitsverzeichnis nicht existiert. Beim
   flüchtigen Dateisystem ist genau das der häufige Fall, und die rohe Meldung
   schickte den Betreiber auf die Suche nach einer fehlenden Git-Installation.
   Jetzt wird unterschieden und die tatsächliche Ursache benannt.

8. **Ein Commit über die Oberfläche ließ „Letzter Push: nie" stehen.** Das
   Repository tauchte dadurch auch im Dashboard nicht auf, das danach
   sortiert. Web-Commits und Pull-Spiegelungen setzen den Zeitpunkt jetzt.

9. **Git-Prozess wurde zu früh beendet.** Der Abbruch hing am `close`-Event des
   Request-Streams, das in Node bereits feuert, wenn der Body gelesen ist.
   Jeder `git clone` brach mit „expected flush after ref listing" ab.

10. **Dateien ließen sich nicht löschen.** `git update-index --force-remove`
   verlangt ein Arbeitsverzeichnis, das ein Bare-Repository nicht hat. Läuft
   jetzt über `--index-info`.

11. **Irreführender 404 beim Push.** Ein Push ohne Schreibrecht auf ein
   *öffentliches* Repository meldete „nicht gefunden".

12. **Secrets wurden nicht aufgelöst.** `interpolate` existierte, wurde aber
   nirgends aufgerufen: `${{ secrets.X }}` landete buchstäblich im Kommando.

13. **Secrets lagen unter ihrem Klarnamen in der Umgebung jedes Schritts.** Ein
   `env` im Log hätte alle offengelegt.

14. **Schritt-`env` expandierte keine Secrets.** Docker ersetzt in `--env-file`
   und `--env` keine Variablen; die Schritt-Umgebung wird jetzt als
   `export`-Zeilen im Skript gesetzt, mit Quoting, das literale Teile vor der
   Shell schützt.

15. **Einschleusung über die Umgebungsdatei.** Ein Wert mit Zeilenumbruch hätte
   beliebige weitere Variablen gesetzt (etwa `PATH`).

16. **Secrets erschienen im Log.** Werden jetzt vor dem Senden durch `***`
   ersetzt.

17. **Artefakte fehlten in der Laufansicht.** Sie wurden hochgeladen, aber nicht
   mitgeliefert.

18. **Doppelte Typdefinitionen.** Beim Entdoppeln der gemeinsamen Typen wurde
    die Fassung entfernt, gegen die der vorhandene Code geschrieben war – 23
    Compilerfehler auf einen Schlag. Die Typen wurden an die Implementierung
    angeglichen, weil auch die Oberfläche gegen diese Shapes gebaut war.

19. **`npm publish` schlug fehl.** Der npm-Client sendet nicht belegte Felder
    als `null` statt sie wegzulassen; das Schema verlangte `undefined`.

20. **ssh2 ließ sich nicht importieren.** Das Paket ist CommonJS ohne benannte
    ESM-Exporte; nur der Default-Import funktioniert unter Node mit ESM.

21. **SSH-Hostschlüssel im falschen Format.** ssh2 liest ed25519 nur im
    OpenSSH-Format, das Node nicht erzeugt – jetzt RSA 3072 als PKCS#1-PEM.

---

## Nicht implementiert

| Bereich | Stand |
|---|---|
| Discussions | vollständig offen |
| Repository-Import von außen | kein Import-Formular beim Anlegen; stattdessen Push oder eine Spiegelung in Richtung *herein* |
| Docker- und Maven-Registry | das Paket-Schema ist formatneutral angelegt, Protokoll-Endpunkte gibt es nur für npm |
| Organisationsweite Projektboards | Tabelle vorbereitet, Endpunkte nur je Repository |
| Mehrprozessbetrieb der Benachrichtigungen | SSE läuft über einen prozesslokalen EventEmitter; hinter mehreren API-Instanzen braucht es Redis Pub/Sub (die Schnittstelle ist auf eine Datei begrenzt) |
| Hintergrundjobs | Garbage Collection der Repositories und das Leeren des Papierkorbs müssen derzeit angestoßen werden; Redis und BullMQ sind vorgesehen, es läuft noch kein Worker |

---

## Bekannte Einschränkungen

- **Browserdurchlauf jetzt vorhanden, aber nicht flächendeckend.** Chromium
  steht inzwischen zur Verfügung. Geprüft wurden: alle 24 Hauptseiten in
  hellem und dunklem Theme sowie auf Telefonbreite (kein waagerechter
  Überlauf, keine Seitenfehler, keine Konsolenfehler) und ein vollständiger
  Durchlauf für Anlegen, Bearbeiten, Hochladen, Löschen und den Weg über
  einen neuen Branch. **Nicht** durchgeklickt sind Issues, Pull Requests mit
  Review, Projektboards, Wiki, Gists und die Administration – dort gelten
  weiterhin nur Render- und Backend-Tests.
- **`git clone ssh://…` ist nicht end-to-end geprüft.** Der SSH-Dienst wurde
  mit einem SSH-Client getestet (Anmeldung, Ref-Ankündigung, abgewiesene
  Kommandos), aber in dieser Umgebung ist kein `ssh`-Binary installiert, das
  Git für den Transport bräuchte.
- **Webhook-Zustellung nur negativ geprüft.** Der SSRF-Schutz ist getestet, eine
  erfolgreiche Zustellung an einen externen Empfänger nicht – ausgehende
  Verbindungen sind in dieser Umgebung gesperrt.
- **Kein Betrieb gegen eine echte Turso-Instanz geprüft.** Der Dialekt ist
  gegen eine lokale libSQL-Datei belegt – derselbe Code und dasselbe
  Protokoll, aber ohne Netz dazwischen. Was dort auffallen kann und hier
  nicht: Latenz je Abfrage (Turso liegt in einer Region, nicht im Prozess)
  und das Verhalten interaktiver Transaktionen über die Leitung.
- **Spiegelung nicht gegen einen echten Hoster geprüft.** Adressprüfung,
  Token-Behandlung, Lease und Maskierung sind getestet; eine echte Übertragung
  nach GitHub nicht, weil ausgehende Verbindungen in dieser Umgebung gesperrt
  sind und ein gültiges Token fehlt. *Verbindung prüfen* in der Oberfläche ist
  genau dafür da: es überträgt nichts und meldet Adress- oder Token-Fehler
  sofort.
- **SMTP-Versand nicht geprüft.** Die Umsetzung steht, ein echter Mailserver war
  nicht erreichbar. Die Admin-Route `/api/v1/admin/mail/check` prüft die
  Verbindung beim Einrichten.
- **Das Runner-Image ist ein Abzug des Hostsystems** (15 GB), weil Docker Hub
  hier nicht erreichbar ist. Für den Produktivbetrieb gehört dort ein schlankes
  Image hin; die Zuordnung steht in `RUNNER_IMAGE_MAP` in
  `services/workflow-parser.ts`.
- **Der Runner braucht Zugriff auf den Docker-Socket.** Wer Jobs einstellen
  darf, kann damit indirekt Container auf dem Runner-Host starten. Ein Runner
  gehört deshalb auf eine Maschine, die sonst nichts Wichtiges tut.
- **Kein HTTPS in der Entwicklung.** Session-Cookies werden erst in
  `NODE_ENV=production` mit `secure` gesetzt.
- **Gists kennen keine private Stufe.** Nicht gelistete Gists sind über ihren
  Link erreichbar. Vertrauliches gehört in ein privates Repository.
- **Forks kopieren die Objektdatenbank vollständig.** Kostet Speicher, hält die
  Repositories aber unabhängig.
- **Commit-Index deckt die letzten 500 Commits je Push ab.** Ein vollständiger
  Index großer Repositories gehört in einen Hintergrundjob.
