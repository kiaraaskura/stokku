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

# Load .env (repo root) and put the bundled Postgres client tools on PATH,
# without failing when either is absent.
define env_setup
	if [[ -f .env ]]; then set -a; source .env; set +a; fi
	if ! command -v psql >/dev/null 2>&1; then
	  if [[ -n "$${PGBIN:-}" && -x "$$PGBIN/psql" ]]; then export PATH="$$PGBIN:$$PATH"
	  elif [[ -x /home/kiara/.hermes/cache/scratch/pg/bin/psql ]]; then export PATH="/home/kiara/.hermes/cache/scratch/pg/bin:$$PATH"
	  fi
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
	base="$${DATABASE_URL%/*}"
	psql "$$base/postgres" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $(CI_DB)" >/dev/null
	psql "$$base/postgres" -v ON_ERROR_STOP=1 -c "CREATE DATABASE $(CI_DB)" >/dev/null
	ci_url="$$base/$(CI_DB)"
	echo ">> migrate from zero on $(CI_DB)"
	DATABASE_URL="$$ci_url" ./scripts/migrate.sh
	echo '>> seed run #1'
	DATABASE_URL="$$ci_url" ./scripts/seed.sh
	echo '>> seed run #2 (must insert 0 rows)'
	DATABASE_URL="$$ci_url" ./scripts/seed.sh
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
