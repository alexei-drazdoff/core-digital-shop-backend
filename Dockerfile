# Single image for all four roles. The process is chosen by the command, so API,
# worker and both supplier stubs stay byte identical and cannot drift apart.
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache tini

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY seeds ./seeds
COPY migrations ./migrations
COPY scripts ./scripts

# Runs unprivileged, and tini reaps zombies so SIGTERM reaches the app and the
# graceful shutdown handlers actually run.
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npx", "tsx", "src/composition/main-api.ts"]
