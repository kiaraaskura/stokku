# Stokku root Makefile — this file IS the command contract (README.md).
# Owner: Deployment. Renaming/removing a target breaks everyone: ask in the
# channel first. Targets degrade gracefully while apps/web, packages/shared
# and services/api are still placeholders (branches not yet merged).

SHELL := /bin/bash
.ONESHELL:
.DEFAULT_GOAL := help
API_DIR := services/api
WEB_DIR := apps/web
export PATH := /home/kiara/.local/bin:$(PATH)

# Throwaway database used only by `make migrate-check` (dropped afterwards).
CI_DB ?= stokku_ci

# Load .env (repo root) and put the Postgres client tools on PATH, without
# failing when either is absent. PGBIN wins, then the known local install
# locations (the pg17 path is the current shared dev cluster; the older
# hermes path is kept as a fallback for machines that still have it).
define env_setup
	if [[ -f .env ]]; then set -a; source .env; set +a; fi
	if ! command -v psql >/dev/null 2>&1; then
	  for d in "$${PGBIN:-/nonexistent}" /home/kiara/.local/pg17/*/bin /home/kiara/.hermes/cache/scratch/pg/bin /usr/lib/postgresql/*/bin; do
	    if [[ -x "$$d/psql" ]]; then export PATH="$$d:$$PATH"; break; fi
	  done
	fi
endef

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- contract --

.PHONY: dev
dev: ## Web + API locally, hot reload (web :5173, api :8080)
	@set -euo pipefail
	$(env_setup)
	pids=()
	if [[ -f $(WEB_DIR)/package.json ]]; then
	  echo '>> web: pnpm dev  → http://localhost:5173'
	  (cd $(WEB_DIR) && exec pnpm dev) & pids+=($$!)
	fi
	if [[ -f $(API_DIR)/Cargo.toml ]]; then
	  echo '>> api: cargo run → http://127.0.0.1:8080/health'
	  (cd $(API_DIR) && exec cargo run) & pids+=($$!)
	fi
	if (( $${#pids[@]} == 0 )); then
	  echo '!! nothing to run yet: $(WEB_DIR) / $(API_DIR) are placeholders (frontend/backend branches not merged).'
	  exit 1
	fi
	trap 'kill $${pids[@]} 2>/dev/null || true' INT TERM EXIT
	wait

.PHONY: migrate
migrate: ## Run all pending Postgres migrations (works from an empty DB)
	@set -euo pipefail
	$(env_setup)
	if [[ -x scripts/migrate.sh ]]; then ./scripts/migrate.sh
	else echo '!! scripts/migrate.sh missing — merge branch "db" (owner: DB).'; exit 1; fi

.PHONY: seed
seed: ## Idempotent demo tenant seed (safe to run repeatedly)
	@set -euo pipefail
	$(env_setup)
	if [[ -x scripts/seed.sh ]]; then ./scripts/seed.sh
	else echo '!! scripts/seed.sh missing — merge branch "db" (owner: DB).'; exit 1; fi

.PHONY: verify
verify: ## DB self-checks: RLS, change_log, reconcile (needs seeded DB)
	@set -euo pipefail
	$(env_setup)
	if [[ -x scripts/verify.sh ]]; then ./scripts/verify.sh
	else echo '!! scripts/verify.sh missing — merge branch "db" (owner: DB).'; exit 1; fi

.PHONY: test
test: test-web test-api migrate-check ## Web tests, API tests + clippy, migration check

.PHONY: test-web
test-web: ## Typecheck + unit tests for apps/web (skips placeholder)
	@set -euo pipefail
	if [[ ! -f $(WEB_DIR)/package.json ]]; then echo '-- apps/web not merged yet, skipping'; exit 0; fi
	pnpm install --prefer-offline
	pnpm --filter ./$(WEB_DIR) run typecheck
	pnpm --filter ./$(WEB_DIR) run test

.PHONY: test-api
test-api: ## cargo fmt --check + clippy -D warnings + tests for services/api
	@set -euo pipefail
	if [[ ! -f $(API_DIR)/Cargo.toml ]]; then echo '-- services/api not merged yet, skipping'; exit 0; fi
	cd $(API_DIR)
	cargo fmt --check
	cargo clippy --all-targets -- -D warnings
	cargo test

.PHONY: migrate-check
migrate-check: ## Migrations from zero on a throwaway DB + seed idempotency
	@set -euo pipefail
	$(env_setup)
	if [[ ! -x scripts/migrate.sh || ! -x scripts/seed.sh ]]; then echo '-- db scripts not merged yet, skipping'; exit 0; fi
	if [[ -z "$${DATABASE_URL:-}" ]]; then echo '!! DATABASE_URL not set (copy .env.example to .env)'; exit 1; fi
	# This check must ALWAYS exercise the throwaway database. scripts/migrate.sh
	# prefers MIGRATION_DATABASE_URL, so any inherited value (shell or .env) is
	# deliberately forced empty here: migrate.sh then uses DATABASE_URL — the
	# throwaway — plus its own admin auto-fallback on the same server.
	export MIGRATION_DATABASE_URL=
	base="$${DATABASE_URL%/*}"
	ci_url="$$base/$(CI_DB)"
	# Admin view of the throwaway (user swapped to the bootstrap superuser,
	# same server): RLS hides tenant rows from a context-less app-role read,
	# and this check must not be able to "pass" on an invisible database.
	admin_ci_url="$$(printf '%s' "$$ci_url" | sed -E 's#^(postgres(ql)?://)[^@/]*@#\1postgres@#')"
	psql "$$base/postgres" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $(CI_DB)" >/dev/null
	psql "$$base/postgres" -v ON_ERROR_STOP=1 -c "CREATE DATABASE $(CI_DB)" >/dev/null
	echo ">> migrate from zero on $(CI_DB) (inherited MIGRATION_DATABASE_URL is ignored)"
	DATABASE_URL="$$ci_url" ./scripts/migrate.sh
	# Loud proof, not a silent pass: every migration file must have applied,
	# from zero, on the throwaway itself.
	n_files=$$(ls services/api/migrations/*.sql | wc -l | tr -d ' ')
	applied=$$(psql "$$admin_ci_url" -tAc 'SELECT count(*) FROM _sqlx_migrations' | tr -d ' ')
	max_file=$$(ls services/api/migrations/*.sql | sed -E 's#.*/0*([0-9]+)_[^/]*\.sql#\1#' | sort -n | tail -1)
	max_applied=$$(psql "$$admin_ci_url" -tAc 'SELECT max(version) FROM _sqlx_migrations' | tr -d ' ')
	if [[ "$$applied" != "$$n_files" || "$$max_applied" != "$$max_file" ]]; then
	  echo "!! migrate-check FAILED: $$applied/$$n_files migrations applied (max version $$max_applied, expected $$max_file) on $(CI_DB)"
	  psql "$$base/postgres" -c "DROP DATABASE IF EXISTS $(CI_DB)" >/dev/null
	  exit 1
	fi
	echo ">> all $$n_files migrations applied from zero (latest: $$max_applied)"
	echo '>> seed run #1'
	DATABASE_URL="$$ci_url" ./scripts/seed.sh
	# The seed must actually seed (read as the superuser: RLS hides tenant
	# rows from a context-less app-role connection, so a no-op seed would
	# otherwise look identical to a working one).
	seeded=$$(psql "$$admin_ci_url" -tAc 'SELECT count(*) FROM item' | tr -d ' ')
	if [[ "$$seeded" -eq 0 ]]; then
	  echo "!! migrate-check FAILED: seed run #1 inserted nothing on $(CI_DB)"
	  psql "$$base/postgres" -c "DROP DATABASE IF EXISTS $(CI_DB)" >/dev/null
	  exit 1
	fi
	echo ">> seed run #1 seeded the demo tenant ($$seeded items)"
	seeded_rows=$$(psql "$$admin_ci_url" -tAc 'SELECT count(*) FROM change_log' | tr -d ' ')
	echo '>> seed run #2 (must write nothing: every write lands a change_log row)'
	DATABASE_URL="$$ci_url" ./scripts/seed.sh
	written=$$(psql "$$admin_ci_url" -tAc 'SELECT count(*) FROM change_log' | tr -d ' ')
	if [[ "$$written" != "$$seeded_rows" ]]; then
	  echo "!! migrate-check FAILED: seed run #2 wrote rows (change_log $$seeded_rows -> $$written)"
	  psql "$$base/postgres" -c "DROP DATABASE IF EXISTS $(CI_DB)" >/dev/null
	  exit 1
	fi
	echo ">> seed is idempotent (change_log $$written rows, unchanged)"
	psql "$$base/postgres" -v ON_ERROR_STOP=1 -c "DROP DATABASE $(CI_DB)" >/dev/null
	echo '>> migrate-check OK'

.PHONY: build
build: build-web build-api ## Production build of every app

.PHONY: build-web
build-web: ## Production build of apps/web (+ any buildable workspace package)
	@set -euo pipefail
	if [[ ! -f $(WEB_DIR)/package.json ]]; then echo '-- apps/web not merged yet, skipping'; exit 0; fi
	pnpm install --prefer-offline
	pnpm --filter './apps/*' --filter './packages/*' run build

.PHONY: build-api
build-api: ## Release build of services/api
	@set -euo pipefail
	if [[ ! -f $(API_DIR)/Cargo.toml ]]; then echo '-- services/api not merged yet, skipping'; exit 0; fi
	cd $(API_DIR)
	cargo build --release

.PHONY: up
up: ## docker compose: postgres + api + web, migrated + seeded, one command
	@set -euo pipefail
	if ! command -v docker >/dev/null 2>&1; then echo '!! docker is not installed on this machine — compose is config-verified only'; exit 1; fi
	if [[ ! -f .env ]]; then echo '!! copy .env.example to .env and fill it first'; exit 1; fi
	docker compose up -d --wait postgres
	docker compose --profile tools run --rm migrate
	docker compose --profile tools run --rm --entrypoint bash migrate scripts/seed.sh
	docker compose up -d --wait
	echo '>> up: web http://localhost:5173 · api http://localhost:8080/health'

.PHONY: down
down: ## Stop the docker compose stack (volumes kept: data persists)
	@set -euo pipefail
	if ! command -v docker >/dev/null 2>&1; then echo '!! docker is not installed on this machine'; exit 1; fi
	docker compose down

.PHONY: images
images: ## Build multi-arch (amd64+arm64) api + web images with buildx
	@set -euo pipefail
	if ! command -v docker >/dev/null 2>&1; then echo '!! docker is not installed on this machine — images are config-verified only'; exit 1; fi
	docker buildx build --platform linux/amd64,linux/arm64 -f infra/api.Dockerfile -t stokku/api:local --load .
	docker buildx build --platform linux/amd64,linux/arm64 -f infra/web.Dockerfile -t stokku/web:local --load .

DEST ?= release
.PHONY: release
release: ## Build the release bundle (api binary, web build, db, config, docs) into DEST
	@set -euo pipefail
	./infra/release.sh "$(DEST)"

# ------------------------------------------------------------------ extras --

.PHONY: backup
backup: ## Logical backup of DATABASE_URL (pg_dump -Fc, 7-day retention)
	@set -euo pipefail
	./infra/backup.sh

.PHONY: psql
psql: ## Interactive psql on DATABASE_URL
	@set -euo pipefail
	$(env_setup)
	if [[ -z "$${DATABASE_URL:-}" ]]; then echo '!! DATABASE_URL not set (copy .env.example to .env)'; exit 1; fi
	exec psql "$$DATABASE_URL"

.PHONY: clean
clean: ## Remove build artifacts (node_modules, dist, target)
	@set -euo pipefail
	rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/*/dist packages/*/dist
	if [[ -f $(API_DIR)/Cargo.toml ]]; then cd $(API_DIR) && cargo clean; fi
