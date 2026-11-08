#!/usr/bin/env bash
# =============================================================================
#  Organisation "vortex" und die Vortex-Repos auf Vortex Git anlegen.
#
#    bash scripts/vortex-repos.sh <zugriffstoken>
#
#  Das Token (fgp_...) erstellst du nach dem Anmelden unter
#  Einstellungen -> Zugriffstokens. Bereits vorhandene Repos werden uebersprungen.
# =============================================================================
set -uo pipefail
TOKEN="${1:-}"; [ -n "$TOKEN" ] || { sed -n '2,9p' "$0"; exit 1; }
API="http://127.0.0.1:${VORTEX_GIT_PORT:-4100}/api/v1"
ORG="${VORTEX_ORG:-vortex}"

post() {
  curl -sS -o /tmp/vortex-repos.$$ -w '%{http_code}' -X POST "$API$1" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$2"
}

code=$(post /organizations "{\"name\":\"$ORG\",\"displayName\":\"Vortex\"}")
case "$code" in
  2*) echo "Organisation $ORG angelegt." ;;
  409) echo "Organisation $ORG gibt es schon." ;;
  *) echo "Organisation: HTTP $code $(cat /tmp/vortex-repos.$$)"; exit 1 ;;
esac

# name:sichtbarkeit:beschreibung
for r in "Vortex-Launcher:public:Vortex Client Launcher (Windows)" \
         "Vortex-Client:public:Vortex Client (Fabric-Mod)" \
         "Vortex-Addon-v2:private:Vortex Plus Addon" \
         "Vortex-Client-Cosmetics:public:Cosmetics-Liste fuer den Client"; do
  IFS=: read -r name vis desc <<<"$r"
  code=$(post /repositories "{\"ownerName\":\"$ORG\",\"name\":\"$name\",\"visibility\":\"$vis\",\"description\":\"$desc\",\"defaultBranch\":\"main\"}")
  case "$code" in
    2*) echo "Repo $ORG/$name ($vis) angelegt." ;;
    409) echo "Repo $ORG/$name gibt es schon." ;;
    *) echo "Repo $name: HTTP $code $(cat /tmp/vortex-repos.$$)" ;;
  esac
done
rm -f /tmp/vortex-repos.$$
echo
echo "Hochladen (lokal, ohne Cloudflare-Grenze von 100 MB), z. B.:"
echo "  git push http://127.0.0.1:${VORTEX_GIT_PORT:-4100}/$ORG/Vortex-Launcher.git main"
echo "  (Benutzername: dein Name auf Vortex Git, Passwort: das Zugriffstoken)"
