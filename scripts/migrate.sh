#!/usr/bin/env bash
# Run all pending Stokku migrations (sqlx layout, services/api/migrations).
# One command from an empty database:  scripts/migrate.sh  (or: make migrate)
set -euo pipefail
cd "$(dirname "$0")/.."

# DATABASE_URL from the environment, else from .env at the repo root.
if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  set -a; source .env; set +a
fi
: "${DATABASE_URL:?DATABASE_URL is not set (copy .env.example to .env and set it)}"

# Dev-machine convenience: the bundled psql is not always on PATH.
if ! command -v psql >/dev/null 2>&1; then
  for d in /home/kiara/.hermes/cache/scratch/pg/bin /usr/lib/postgresql/*/bin; do
    if [[ -x "$d/psql" ]]; then export PATH="$d:$PATH"; break; fi
  done
fi

if ! command -v sqlx >/dev/null 2>&1; then
  echo "sqlx CLI not found. Install:" >&2
  echo "  cargo install sqlx-cli --no-default-features --features postgres" >&2
  exit 1
fi

(cd services/api && sqlx migrate run)
