#!/bin/sh
# Daily database dump; keep 14 days. Example cron: 30 3 * * * /opt/supportx/deploy/backup.sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
docker compose -f deploy/docker-compose.prod.yml --env-file .env exec -T db pg_dump -U supportx -Fc supportx > "backups/supportx-$(date +%F).dump"
find backups -name 'supportx-*.dump' -mtime +14 -delete
