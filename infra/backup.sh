#!/usr/bin/env bash
# Stokku logical backup — owner: Deployment (T-503 groundwork).
# pg_dump in custom format (-Fc: compressed, pg_restore-able),
# 7-day rolling retention, copy-paste restore command.
#
# Usage:
#   infra/backup.sh [backup-dir]     # default: ./backups (gitignored)
# Env:
#   DATABASE_URL            (or .env at the repo root)
#   BACKUP_KEEP_DAYS=7      # retention
# Restore (copy-paste, adjust the dump path):
#   pg_restore --clean --if-exists -d "$DATABASE_URL" backups/stokku-<stamp>.dump
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${1:-backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ -f .env ]]; then
    set -a; source .env; set +a
  fi
fi
: "${DATABASE_URL:?DATABASE_URL is not set (copy .env.example to .env, or export it)}"

# Dev-machine convenience: the bundled psql/pg_dump is not always on PATH.
if ! command -v pg_dump >/dev/null 2>&1; then
  if [[ -n "${PGBIN:-}" && -x "$PGBIN/pg_dump" ]]; then
    export PATH="$PGBIN:$PATH"
  elif [[ -x /home/kiara/.hermes/cache/scratch/pg/bin/pg_dump ]]; then
    export PATH="/home/kiara/.hermes/cache/scratch/pg/bin:$PATH"
  fi
fi
command -v pg_dump >/dev/null 2>&1 || { echo "pg_dump not found" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%d-%H%M%S)
file="$BACKUP_DIR/stokku-$stamp.dump"

echo ">> pg_dump (custom format) → $file"
pg_dump "$DATABASE_URL" --format=custom --file="$file"

# 7-day retention: delete backups older than KEEP_DAYS (prints what it drops).
find "$BACKUP_DIR" -name 'stokku-*.dump' -mtime +"$KEEP_DAYS" -print -delete

size=$(du -h "$file" | cut -f1)
echo ">> backup done: $file ($size), retention ${KEEP_DAYS}d"
echo ">> restore with:"
echo "   pg_restore --clean --if-exists -d \"\$DATABASE_URL\" $file"
