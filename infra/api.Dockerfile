# Stokku API image — multi-stage, owner: Deployment.
# Build context is the REPO ROOT:
#   docker build -f infra/api.Dockerfile .
# Multi-arch (amd64 + arm64), or use `make images`:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f infra/api.Dockerfile -t <registry>/stokku-api:<tag> --push .
# Binary name "stokku-api" is confirmed by Backend (cargo package/bin name).
# Runtime connects as the NON-superuser role via DATABASE_URL (see
# docs/DEPLOY.md) so forced RLS binds — never point it at a superuser.

FROM rust:1-bookworm AS build
WORKDIR /build
# Whole crate incl. Cargo.lock for reproducible builds; sqlx runtime queries
# need no DB at build time (no sqlx macros, no .sqlx prepare).
COPY services/api/ .
RUN cargo build --release --locked

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --no-create-home --home /nonexistent stokku
COPY --from=build /build/target/release/stokku-api /usr/local/bin/stokku-api
USER stokku
ENV PORT=8080 \
    RUST_LOG=info
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=12 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/usr/local/bin/stokku-api"]
