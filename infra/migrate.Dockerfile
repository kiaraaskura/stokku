# One-shot migration/seed runner for the compose stack — owner: Deployment.
# Used by `make up`:
#   docker compose --profile tools run --rm migrate                      # migrate
#   docker compose --profile tools run --rm --entrypoint bash migrate scripts/seed.sh
# Wraps DB's scripts/migrate.sh / scripts/seed.sh (sqlx-cli + psql inside).
FROM rust:1-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/* \
 && cargo install sqlx-cli --version 0.9.1 --no-default-features --features postgres
WORKDIR /repo
COPY scripts/ scripts/
COPY services/api/migrations/ services/api/migrations/
ENTRYPOINT ["bash", "scripts/migrate.sh"]
