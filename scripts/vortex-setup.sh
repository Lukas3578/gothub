#!/usr/bin/env bash
# =============================================================================
#  Vortex Git (gothub) auf dem eigenen Server einrichten oder aktualisieren.
#
#    bash scripts/vortex-setup.sh
#
#  Sicher mehrfach ausfuehrbar: beim ersten Mal wird .env mit neuen Schluesseln
#  angelegt, danach nur gebaut, die Datenbank migriert und neu gestartet.
#  Daten (Repos, Releases, Datenbank) liegen in ./data und bleiben erhalten.
#
#  Anpassbar ueber Umgebung:
#    VORTEX_GIT_URL   oeffentliche Adresse   (Standard https://git.vortexpvp.eu)
#    VORTEX_GIT_PORT  lokaler Port           (Standard 4100)
#    VORTEX_GIT_NAME  Name in pm2            (Standard vortex-git)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

VG_URL="${VORTEX_GIT_URL:-https://git.vortexpvp.eu}"
VG_URL="${VG_URL%/}"
VG_PORT="${VORTEX_GIT_PORT:-4100}"
VG_NAME="${VORTEX_GIT_NAME:-vortex-git}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "Voraussetzungen pruefen"
command -v node >/dev/null || { echo "Node.js fehlt (mind. 20)."; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node $NODE_MAJOR ist zu alt, mindestens 20 noetig."; exit 1; }
command -v git >/dev/null || { echo "git fehlt (apt install git)."; exit 1; }
command -v pm2 >/dev/null || { echo "pm2 fehlt -> npm i -g pm2"; npm i -g pm2; }
echo "node $(node -v), git $(git --version | cut -d' ' -f3), pm2 $(pm2 -v)"

if [ ! -f .env ]; then
  say ".env anlegen (neue geheime Schluessel)"
  SESSION_SECRET=$(node -e 'console.log(require("crypto").randomBytes(48).toString("base64"))')
  ENCRYPTION_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
  umask 077
  cat > .env <<ENV
# Vortex Git (gothub). Erzeugt von scripts/vortex-setup.sh. NICHT weitergeben.
NODE_ENV=production
FORGE_BRAND_NAME=Vortex Git
FORGE_BRAND_TAGLINE=Code, Releases und Builds von Vortex
API_HOST=127.0.0.1
PORT=${VG_PORT}
PUBLIC_API_URL=${VG_URL}
PUBLIC_WEB_URL=${VG_URL}
DATABASE_URL=file:./data/forge.db
GIT_STORAGE_ROOT=./data/repositories
UPLOAD_STORAGE_ROOT=./data/uploads
SESSION_SECRET=${SESSION_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
SSH_ENABLED=false
FIRST_USER_IS_ADMIN=true
# Nach dem Anlegen eurer Konten auf false stellen und neu starten (bash scripts/vortex-setup.sh):
# sonst kann sich jeder registrieren und Repos mit Workflows anlegen.
ALLOW_REGISTRATION=true
MAIL_TRANSPORT=console
ENV
  chmod 600 .env
  echo ".env geschrieben (Adresse ${VG_URL}, Port ${VG_PORT})."
else
  echo ".env gibt es schon, bleibt wie sie ist."
fi
mkdir -p data/repositories data/uploads

say "Pakete installieren"
for versuch in 1 2 3; do
  if npm ci --no-audit --no-fund; then break; fi
  [ "$versuch" = 3 ] && { echo "npm ci ist dreimal fehlgeschlagen."; exit 1; }
  echo "Neuer Versuch in 15 s ..."; sleep 15
done

say "Bauen (Web-Oberflaeche zeigt auf ${VG_URL})"
VITE_API_URL="${VG_URL}" npm run build
npm run build --workspace @forge/runner

say "Datenbank migrieren"
# Variablen anderer Programme im selben Container duerfen die .env nicht ueberdecken.
for v in $(grep -oE '^[A-Z_]+=' .env | tr -d '='); do
  if [ -n "${!v+x}" ]; then echo "Hinweis: $v ist in der Shell gesetzt und wird fuer Vortex Git ignoriert."; unset "$v"; fi
done
npm run db:migrate

say "Starten (pm2: ${VG_NAME}, Port ${VG_PORT})"
# Mit leerer Umgebung starten: Variablen anderer Programme im Container (z. B. PORT
# oder DATABASE_URL vom Freunde-Server) duerfen Vortex Git nicht umlenken. Alles
# Noetige steht in .env.
NODE_BIN=$(command -v node)
pm2 delete "${VG_NAME}" >/dev/null 2>&1 || true
pm2 start bash --name "${VG_NAME}" --time -- -c \
  "cd '${ROOT}' && exec env -i PATH='${PATH}' HOME='${HOME}' LANG=C.UTF-8 '${NODE_BIN}' apps/api/dist/server.js"
pm2 save >/dev/null 2>&1 || true

say "Kurzer Test"
ok=""
for i in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${VG_PORT}/api/v3" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ -n "$ok" ]; then
  echo "API laeuft:            http://127.0.0.1:${VG_PORT}/api/v3"
  curl -fsS -o /dev/null -w "Web-Oberflaeche:       HTTP %{http_code}\n" "http://127.0.0.1:${VG_PORT}/" || true
  echo
  echo "Fertig. Jetzt im Cloudflare-Tunnel ${VG_URL#https://} -> http://localhost:${VG_PORT} eintragen"
  echo "(Anleitung: VORTEX.md, Schritt 2)."
else
  echo "Die API antwortet nicht. Letzte Log-Zeilen:"
  pm2 logs "${VG_NAME}" --lines 40 --nostream || true
  exit 1
fi
