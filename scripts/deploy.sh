#!/usr/bin/env bash
# Deploy or update the dashboard stack on the VPS. Safe to re-run.
#   scripts/deploy.sh            pull main, rebuild, provision Metabase
#   scripts/deploy.sh --no-pull  deploy the current checkout as is
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "Missing .env: cp .env.example .env, then fill it in" >&2; exit 1; }
password=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
if [[ ${#password} -lt 32 || $password == CHANGE_ME* ]]; then
  echo "POSTGRES_PASSWORD in .env is a placeholder or too short: use openssl rand -hex 32" >&2
  exit 1
fi
chmod 600 .env

docker network inspect apps_apps >/dev/null 2>&1 \
  || { echo "Docker network apps_apps not found: start the main stack in /opt/apps first" >&2; exit 1; }

if [[ ${1:-} != --no-pull ]]; then
  git pull --ff-only origin main
fi

docker compose up -d --build --remove-orphans

if grep -qE '^MB_API_KEY=.+' .env; then
  docker compose run --rm metabase-setup
else
  echo "MB_API_KEY not set in .env: skipping Metabase provisioning" >&2
fi

grep -q 'udienza-metabase' /opt/apps/proxy/Caddyfile 2>/dev/null \
  || echo "Warning: the shared Caddy has no route to udienza-metabase (see README)" >&2
docker compose ps
