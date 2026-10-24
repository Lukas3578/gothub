#!/usr/bin/env bash
# Startet die Dienste, die Forge in der Entwicklung braucht.
# Idempotent: ein bereits laufender Dienst wird nicht neu gestartet.
set -e
pg_isready -q 2>/dev/null || pg_ctlcluster 16 main start
redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes --save '' --appendonly no
sleep 2
pg_isready && redis-cli ping
