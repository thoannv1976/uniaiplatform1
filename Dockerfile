# syntax=docker/dockerfile:1
# One image recipe for the Cloud Run services. Build with --build-arg APP=api|worker.
ARG NODE_IMAGE=mirror.gcr.io/library/node:22-slim

FROM ${NODE_IMAGE} AS build
ARG APP
ENV TURBO_TELEMETRY_DISABLED=1 CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN test -n "$APP" || (echo "Thiếu --build-arg APP=api|worker" && exit 1)
RUN pnpm install --frozen-lockfile --filter "@uniai/${APP}..."
RUN pnpm exec turbo run build --filter "@uniai/${APP}..."
# Standalone folder with only production dependencies (workspace packages copied in).
RUN pnpm --filter "@uniai/${APP}" deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
