# Stokku API image — multi-stage, owner: Deployment (T-005).
# Build context is the REPO ROOT:
#   docker build -f infra/api.Dockerfile .
# Multi-arch (amd64 + arm64):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f infra/api.Dockerfile -t <registry>/stokku-api:<tag> --push .
#
# NOTE for Backend: the release binary is expected at
# services/api/target/release/stokku-api (cargo package/bin named
# "stokku-api"). If the binary gets a different name, change ARG BIN
# (and the ENTRYPOINT) or tell Deployment in the channel.

ARG BIN=stokku-api

FROM rust:1-bookworm AS build
ARG BIN
WORKDIR /build
# Whole crate incl. migrations (sqlx runtime queries need no DB at build
# time; deps-only layer caching can be added once the crate layout settles).
COPY services/api/ .
RUN cargo build --release

FROM debian:bookworm-slim AS runtime
ARG BIN
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --no-create-home --home /nonexistent stokku
COPY --from=build /build/target/release/${BIN} /usr/local/bin/stokku-api
USER stokku
ENV PORT=8080 \
    RUST_LOG=info
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=12 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/usr/local/bin/stokku-api"]
