#!/bin/bash
# Init script for the compose postgres — owner: Deployment (T-005).
# Runs once on first start of the postgres container (docker-entrypoint-initdb.d).
# The password comes from the container env (STOKKU_DB_PASSWORD, set in .env):
# no secret is stored in git.
#
# SECURITY MODEL: the bootstrap superuser in the compose stack is "postgres".
# The API must connect as the NON-superuser role "stokku" — forced RLS
# (DB's T-102) binds only non-superusers; a superuser connection would
# silently see every tenant. Migrations run as the superuser (they need
# extensions such as citext/pg_trgm), so the objects it creates are owned
# by "postgres" — default privileges below hand the app role just enough.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE stokku LOGIN PASSWORD '${STOKKU_DB_PASSWORD:?STOKKU_DB_PASSWORD must be set}';
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO stokku;
  GRANT USAGE, CREATE ON SCHEMA public TO stokku;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stokku;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO stokku;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO stokku;
EOSQL
