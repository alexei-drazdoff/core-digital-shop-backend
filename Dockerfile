# syntax=docker/dockerfile:1.7

# One image serves every role: api, worker, migrator and the supplier stubs. The
# role is chosen by the command, so the processes stay byte identical and cannot
# drift apart between deploys.
#
# TypeScript is compiled here rather than transpiled on each boot: the runtime
# stage carries plain node, production dependencies only, and no toolchain.

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    # A dropped connection to the registry should cost a retry, not the build.
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=2000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=60000

# --- dependencies, dev included: tsc is needed to build --------------------
FROM base AS deps
COPY package.json package-lock.json ./
# sharing=locked: npm's cache is not safe under concurrent writers, and BuildKit
# will happily run this against a warm cache while another build reads it.
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci

# --- compile ---------------------------------------------------------------
# rootDir is the repository root, so the output keeps the source layout:
# dist/src/... and dist/seeds/... . Several runtime paths depend on that.
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY seeds ./seeds
RUN npm run build

# --- runtime dependencies only ---------------------------------------------
# Pruned from the tree deps already resolved rather than installed by a second
# npm ci: one network fetch per build instead of two competing ones, and the
# runtime image is unaffected either way since it only copies the result out.
FROM deps AS prod-deps
RUN npm prune --omit=dev

# --- runtime ---------------------------------------------------------------
FROM base AS runtime

LABEL org.opencontainers.image.title="core-digital-shop-backend" \
      org.opencontainers.image.description="Digital goods marketplace core: catalog, orders, payment webhooks, automatic key delivery" \
      org.opencontainers.image.source="https://github.com/alexei-drazdoff/core-digital-shop-backend" \
      org.opencontainers.image.licenses="UNLICENSED"

ENV NODE_ENV=production

# tini reaps zombies and forwards SIGTERM, so the graceful shutdown handlers in
# the api and worker actually run instead of the process being killed outright.
RUN apk add --no-cache tini

# The real package.json, not a stub: node walks up from dist/src/... looking for
# the nearest one, and without "type": "module" every compiled file would be
# loaded as CommonJS and fail on its first import.
COPY --chown=node:node package.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# Both are read through fs at runtime rather than imported, so tsc emits nothing
# for them. They are resolved relative to the compiled files, which is why they
# land inside dist/ instead of next to it.
COPY --chown=node:node migrations ./dist/migrations
COPY --chown=node:node seeds/catalog.json seeds/keys.json ./dist/seeds/

USER node

# api 3000, worker metrics 3001, supplier stubs 4001/4002. Documentation only;
# the port a container actually opens follows from its command.
EXPOSE 3000 3001 4001 4002

# No HEALTHCHECK here on purpose: one image, four roles, four different ports.
# The probe belongs with the command that selects the role, so it lives in
# docker-compose.yml per service.

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/composition/main-api.js"]
