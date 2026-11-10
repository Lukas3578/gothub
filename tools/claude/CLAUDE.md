# Arbeiten auf Vortex Git (für Claude)

Dieses Repo liegt auf **Vortex Git** (https://git.vortexpvp.eu, „Forge“), nicht auf GitHub.
Token: `$FORGE_TOKEN` (aus der Cloud-Umgebung „forge“). Werkzeug: `tools/forge/forge`
(gleiches Kommando wie `forge --help`).

## Ablauf für jede Änderung
1. Eigenen Branch anlegen: `git checkout -b claude/<kurzer-name>`
2. Ändern, testen, committen.
3. Pushen: `tools/forge/forge push`  (pusht nie auf main)
4. Pull Request: `tools/forge/forge pr create --head claude/<name> --title "…" --body-file pr.md`
5. Workflow beobachten: `tools/forge/forge run list`, dann `tools/forge/forge run watch <id>`;
   bei Fehler `tools/forge/forge run logs <id>` lesen, beheben, erneut pushen.
6. Wenn alles grün ist und der Besitzer es so will: `tools/forge/forge pr merge <nr>`.
   Mergen auf main löst die Builds/Releases aus, also nur wenn wirklich fertig.

## Workflows
- Liegen in `.forge/workflows/*.yml` (GitHub-Actions-Format), `runs-on: self-hosted` (Linux).
- Nicht unterstützt: `strategy`/`matrix`, Schritt-`id`, `steps.*.outputs`, `concurrency`,
  `permissions`, `inputs.*` (sind leer). Aktionen: checkout, setup-java, setup-node, setup-go,
  upload-artifact. `gh release …` geht über `tools/forge/gh`.
- Von Hand starten: `tools/forge/forge run dispatch --workflow .forge/workflows/<datei>.yml --watch`
- Secret `FORGE_TOKEN` ist gesetzt und auch als `${{ github.token }}` erreichbar.

## Regeln
- Client: bei jeder Änderung `mod_version` in `gradle.properties` erhöhen, sonst bekommen
  Spieler kein Update.
- Keine Tokens, Passwörter oder `store.env`-Inhalte in Commits, PRs oder Logs.
- Fragen an den Menschen kurz und auf Deutsch.
