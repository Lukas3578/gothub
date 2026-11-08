#!/usr/bin/env bash
# =============================================================================
#  Build-Runner fuer Vortex Git starten (ohne Docker, "Host-Modus").
#
#    bash scripts/vortex-runner.sh <name> <runner-token>
#
#  <runner-token> bekommst du im Repo auf Vortex Git unter
#  Einstellungen -> Runner -> "Runner hinzufuegen" (einmal pro Repo).
#  Jeder Runner gehoert zu genau einem Repo und nimmt nur dessen Jobs an.
#
#  Sicherheit: Die Builds laufen direkt auf diesem Server. Deshalb
#    - nimmt der Runner nur Jobs von VORTEX_RUNNER_OWNERS an (Standard: vortex),
#    - laeuft er, wenn moeglich, als eigener Benutzer "vortex-runner" ohne Zugriff
#      auf /root (also auch nicht auf store.env mit den PayPal-Schluesseln).
#
#  Umgebung: VORTEX_GIT_PORT (4100), VORTEX_RUNNER_OWNERS (vortex)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

NAME="${1:-}"; TOKEN="${2:-}"
[ -n "$NAME" ] && [ -n "$TOKEN" ] || { sed -n '2,20p' "$0"; exit 1; }
[[ "$NAME" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Name nur aus Buchstaben, Ziffern, - und _"; exit 1; }
PORT="${VORTEX_GIT_PORT:-4100}"
OWNERS="${VORTEX_RUNNER_OWNERS:-vortex}"
PM2NAME="vortex-runner-${NAME}"

[ -f apps/runner/dist/index.js ] || npm run build --workspace @forge/runner

NODE_BIN=$(command -v node)
RUN_AS=""
if [ "$(id -u)" = 0 ] && command -v useradd >/dev/null && command -v runuser >/dev/null; then
  # Node muss fuer den Runner-Benutzer erreichbar sein (nicht unter /root, z. B. nvm).
  case "$(readlink -f "$NODE_BIN")" in
    /root/*) echo "Hinweis: node liegt unter /root -- Runner laeuft deshalb als root (weniger abgeschottet).";;
    *) RUN_AS="vortex-runner";;
  esac
fi

DIR="${ROOT}/data/runners"
mkdir -p "$DIR"
if [ -n "$RUN_AS" ]; then
  id "$RUN_AS" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$RUN_AS"
  HOME_DIR=$(getent passwd "$RUN_AS" | cut -d: -f6)
  chmod 700 /root 2>/dev/null || true
  # Der Runner braucht nur Lesezugriff auf seinen eigenen Code, nicht auf data/ oder .env.
  RUNNER_COPY="${HOME_DIR}/forge-runner"
  rm -rf "$RUNNER_COPY" && mkdir -p "$RUNNER_COPY"
  cp -r apps/runner/dist apps/runner/package.json "$RUNNER_COPY/"
  chown -R "$RUN_AS:$RUN_AS" "$RUNNER_COPY"
  ENVFILE="${HOME_DIR}/.forge-runner-${NAME}.env"
  ENTRY="${RUNNER_COPY}/dist/index.js"
  CACHE="${HOME_DIR}/.forge-runner/tools"
else
  ENVFILE="${DIR}/${NAME}.env"
  ENTRY="${ROOT}/apps/runner/dist/index.js"
  CACHE="${ROOT}/data/runner-tools"
fi

umask 077
cat > "$ENVFILE" <<ENV
FORGE_API_URL=http://127.0.0.1:${PORT}
FORGE_RUNNER_TOKEN=${TOKEN}
FORGE_RUNNER_MODE=host
FORGE_RUNNER_ALLOWED_OWNERS=${OWNERS}
FORGE_RUNNER_LABELS=self-hosted
FORGE_RUNNER_TOOL_CACHE=${CACHE}
ENV
[ -n "$RUN_AS" ] && chown "$RUN_AS:$RUN_AS" "$ENVFILE"
chmod 600 "$ENVFILE"

START="set -a; . '${ENVFILE}'; set +a; exec '${NODE_BIN}' '${ENTRY}'"
pm2 delete "$PM2NAME" >/dev/null 2>&1 || true
if [ -n "$RUN_AS" ]; then
  pm2 start bash --name "$PM2NAME" --time -- -c "exec runuser -u ${RUN_AS} -- bash -c \"${START//\"/\\\"}\""
else
  pm2 start bash --name "$PM2NAME" --time -- -c "$START"
fi
pm2 save >/dev/null 2>&1 || true
sleep 3
pm2 logs "$PM2NAME" --lines 15 --nostream || true
echo
echo "Runner \"${NAME}\" laeuft${RUN_AS:+ als Benutzer ${RUN_AS}}. Log: pm2 logs ${PM2NAME}"
