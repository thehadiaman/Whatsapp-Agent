# syntax=docker/dockerfile:1
# Production image for apps/web, using Next.js standalone output.
#   docker build -f docker/web.Dockerfile .

ARG NODE_IMAGE=node:24.22.3-trixie-slim

FROM ${NODE_IMAGE} AS build
# Where the web server proxies /api. Fixed at build time by Next.js rewrites;
# in production Caddy routes /api directly and this proxy is not used.
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
# Where photos and voice notes are played from (the S3 bucket's origin), for
# the content security policy. Empty in mock mode: media comes from the API.
ARG MEDIA_ORIGIN=
ENV MEDIA_ORIGIN=${MEDIA_ORIGIN}
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter "@app/web..."
RUN pnpm --filter "@app/web..." build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
# Standalone output does not include public/ (fonts, licences).
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
