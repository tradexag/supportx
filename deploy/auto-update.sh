#!/bin/sh
# Pull-based update: run by the systemd timer (deploy/supportx-update.timer).
# Follows the branch in SUPPORTX_DEPLOY_BRANCH (default: live). Only tracked files
# are replaced; .env, theme and backups stay untouched (they are gitignored).
set -eu
cd "$(dirname "$0")/.."
BRANCH="${SUPPORTX_DEPLOY_BRANCH:-live}"
git fetch -q origin "$BRANCH"
TARGET="$(git rev-parse "origin/$BRANCH")"
[ "$(git rev-parse HEAD)" = "$TARGET" ] && exit 0
echo "SupportX-Update auf $TARGET"
git reset -q --hard "$TARGET"
docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d --build
