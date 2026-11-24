# Stokku web image — build the Vite app, serve with nginx — owner: Deployment.
# Build context is the repo root. apps/web itself is Frontend's tree; this
# file only reads it. When packages/shared becomes a real workspace package
# it is picked up automatically because the whole repo is copied.
#   docker build -f infra/web.Dockerfile .
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter ./apps/web run build

FROM nginx:1.27-alpine AS runtime
COPY infra/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
