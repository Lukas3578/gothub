#!/usr/bin/env bash
# Startet die Dienste, die Forge in der Entwicklung braucht.
#
# Seit dem Wechsel auf libSQL ist das nur noch Redis, und auch das ist
# optional: ohne Redis laufen Rate-Limiting und Caching prozesslokal weiter.
# Die Datenbank ist eine Datei unter data/ und braucht keinen Dienst.
#
# Idempotent: ein bereits laufender Dienst wird nicht neu gestartet.
set -e

if command -v redis-cli >/dev/null 2>&1; then
  redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes --save '' --appendonly no
  sleep 1
  redis-cli ping
else
  echo "Redis ist nicht installiert – Forge läuft auch ohne."
fi

echo "Die Datenbank ist eine Datei. Anlegen mit: npm run db:migrate"
