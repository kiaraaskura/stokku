#!/usr/bin/env bash
# Build the Stokku release bundle — owner: Deployment.
# One command: infra/release.sh [DEST]   (or: make release DEST=...)
# Default DEST is ./release (gitignored).
#
# Produces, under DEST:
#   api/stokku-api              release binary (cargo build --release --locked)
#   web/                         production web build (apps/web/dist)
#   db/                          migrations + migrate/seed/verify scripts
#   config/                      compose.yml, infra/* (Dockerfiles, backup, deploy), .env.example
#   docs/                        README + docs/
#   stokku-source-main-<sha>.zip clean source archive of HEAD
#   RELEASE.md                   version, contents, how to run
#   SHA256SUMS                   checksums of every file in the bundle
# Existing files under DEST with the same names are overwritten; nothing
# is deleted (safe to point at a shared result folder).
set -euo pipefail
cd "$(dirname "$0")/.."

DEST="${1:-release}"
REV="$(git rev-parse --short HEAD)"
STAMP="$(date -u +%Y-%m-%d)"

echo ">> release $STAMP @ $REV → $DEST"

# 1. API release binary
echo '>> building services/api (cargo build --release --locked)'
(cd services/api && cargo build --release --locked)

# 2. Web production build
echo '>> building apps/web (pnpm build)'
pnpm install --prefer-offline --silent
pnpm --filter ./apps/web run build

# 3. Assemble
echo ">> assembling bundle"
mkdir -p "$DEST/api" "$DEST/web" "$DEST/docs" "$DEST/db" "$DEST/config"
cp -f services/api/target/release/stokku-api "$DEST/api/stokku-api"
cp -rf apps/web/dist/. "$DEST/web/"
cp -rf docs/. "$DEST/docs/"
cp -f README.md "$DEST/docs/README.md"
cp -rf services/api/migrations "$DEST/db/migrations"
for f in scripts/migrate.sh scripts/seed.sh scripts/verify.sh scripts/seed.sql scripts/verify.sql; do
  [[ -f "$f" ]] && cp -f "$f" "$DEST/db/"
done
cp -f compose.yml "$DEST/config/"
cp -f .env.example "$DEST/config/"
cp -rf infra/. "$DEST/config/infra/"
git archive --format=zip -o "$DEST/stokku-source-main-$REV.zip" HEAD

# 4. Manifest + checksums
cat > "$DEST/RELEASE.md" <<EOF
# Stokku release bundle

Version: **$STAMP @ $REV** (git short SHA)

Contents:
- \`api/stokku-api\` — Rust axum API, release build (\`cargo build --release --locked\`)
- \`web/\` — production web app (Vite build; serve statically, SPA fallback)
- \`db/\` — sqlx migrations (\`db/migrations\`) and the migrate/seed/verify scripts
- \`config/\` — compose.yml, Dockerfiles, pg-init, backup.sh, deploy configs, \`.env.example\`
- \`docs/\` — README, DEPLOY.md, PRD, contracts, QA docs
- \`stokku-source-main-$REV.zip\` — clean source archive of the same commit

How to run (short version — full detail in docs/DEPLOY.md):
1. Copy \`config/.env.example\` to \`.env\`; set \`DATABASE_URL\` (**non-superuser role
   \`stokku\`** — a superuser DSN silently bypasses RLS), \`JWT_SECRET\`, \`APP_BASE_URL\`.
2. Create the Postgres database and run migrations:
   \`MIGRATION_DATABASE_URL=<admin DSN> DATABASE_URL=<app DSN> db/scripts/migrate.sh\`
   then optionally \`db/scripts/seed.sh\` for the demo tenant.
3. Run the API: \`PORT=8080 DATABASE_URL=... JWT_SECRET=... ./api/stokku-api\`
4. Serve \`web/\` from any static host (or use compose.yml on a Docker machine:
   \`make up\`).

Checksums: SHA256SUMS in this directory (\`sha256sum -c SHA256SUMS\`).
EOF

( cd "$DEST" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )

echo ">> done. bundle at $DEST (rev $REV):"
( cd "$DEST" && du -sh . && ls )
