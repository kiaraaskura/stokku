#!/usr/bin/env bash
# Proof checks for the schema + seed (scripts/verify.sql).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  set -a; source .env; set +a
fi
: "${DATABASE_URL:?DATABASE_URL is not set}"

if ! command -v psql >/dev/null 2>&1; then
  for d in /home/kiara/.local/pg17/*/bin /home/kiara/.hermes/cache/scratch/pg/bin /usr/lib/postgresql/*/bin; do
    if [[ -x "$d/psql" ]]; then export PATH="$d:$PATH"; break; fi
  done
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify.sql
