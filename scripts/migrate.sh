#!/usr/bin/env bash
# Run all pending Stokku migrations (sqlx layout, services/api/migrations).
# One command from an empty database:  scripts/migrate.sh  (or: make migrate)
#
# Connection model (matches compose and CI):
#   DATABASE_URL            the API/app connection — non-superuser role stokku.
#   MIGRATION_DATABASE_URL  optional admin connection used ONLY for the
#                           migrations. Migration 0010 needs a superuser
#                           (only a superuser can set up the stokku_auth
#                           definer role), while the API must stay
#                           non-superuser so forced RLS keeps binding it.
#   When MIGRATION_DATABASE_URL is unset we fall back to DATABASE_URL and,
#   if that user is not a superuser, automatically try the admin account
#   (postgres) on the same server — passwordless on trust-auth dev installs,
#   or with POSTGRES_PASSWORD when that is set.
#   When the migrations ran as someone other than the app role, the app role
#   is granted table/sequence/function rights afterwards (the same model as
#   infra/pg-init.sh in compose).
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

# psql_q <url> <sql> — prints the single value, empty on failure.
psql_q() { psql "$1" -tAc "$2" 2>/dev/null || true; }

APP_URL="$DATABASE_URL"
APP_USER="$(psql_q "$APP_URL" 'select current_user')"
MIG_URL="${MIGRATION_DATABASE_URL:-$APP_URL}"
MIG_SUPER="$(psql_q "$MIG_URL" 'select rolsuper from pg_roles where rolname = current_user')"

# No explicit admin URL and the app role cannot run 0010? Try the admin
# account on the same server (dev installs use trust auth), else the
# documented POSTGRES_PASSWORD.
if [[ "$MIG_SUPER" != "t" && -z "${MIGRATION_DATABASE_URL:-}" ]]; then
  admin_url="$(printf '%s' "$APP_URL" | sed -E 's#^(postgres(ql)?://)[^@]*@#\1postgres@#')"
  if [[ "$(psql_q "$admin_url" 'select rolsuper from pg_roles where rolname = current_user')" == "t" ]]; then
    MIG_URL="$admin_url"
  elif [[ -n "${POSTGRES_PASSWORD:-}" ]]; then
    admin_url="$(printf '%s' "$APP_URL" | sed -E "s#^(postgres(ql)?://)[^@]*@#\\1postgres:${POSTGRES_PASSWORD}@#")"
    if [[ "$(psql_q "$admin_url" 'select rolsuper from pg_roles where rolname = current_user')" == "t" ]]; then
      MIG_URL="$admin_url"
    fi
  fi
  MIG_SUPER="$(psql_q "$MIG_URL" 'select rolsuper from pg_roles where rolname = current_user')"
fi

MIG_USER="$(psql_q "$MIG_URL" 'select current_user')"
echo ">> migrations run as '${MIG_USER:-unknown}' (app role stays '${APP_USER:-unknown}')"

if [[ "$MIG_SUPER" != "t" ]]; then
  echo "!! no admin connection available: running as non-superuser '$MIG_USER'." >&2
  echo "!! migration 0010 needs a superuser to set up the auth definer role" >&2
  echo "!! (BYPASSRLS). If this run fails, set MIGRATION_DATABASE_URL to an" >&2
  echo "!! admin connection, e.g. MIGRATION_DATABASE_URL=postgres://postgres@127.0.0.1:55442/<db>" >&2
fi

# sqlx reads DATABASE_URL; point it at the migration connection.
( export DATABASE_URL="$MIG_URL"; cd services/api && sqlx migrate run )

# When the admin (not the app role) created the objects, hand the app role
# the rights it needs — same grants as infra/pg-init.sh in compose.
if [[ -n "$MIG_USER" && -n "$APP_USER" && "$MIG_USER" != "$APP_USER" ]]; then
  psql "$MIG_URL" -v ON_ERROR_STOP=1 -q \
    -c "grant select, insert, update, delete on all tables in schema public to ${APP_USER};" \
    -c "grant usage, select on all sequences in schema public to ${APP_USER};" \
    -c "grant execute on all functions in schema public to ${APP_USER};"
  echo ">> granted app role '${APP_USER}' table/sequence/function rights"
fi
