# syntax=docker/dockerfile:1
# Production image for a Node service in the monorepo: api, worker or simulator.
#   docker build -f docker/service.Dockerfile --build-arg APP=api .
# CI builds it natively for linux/arm64 (the EC2 target).

ARG NODE_IMAGE=node:24.22.3-trixie-slim

FROM ${NODE_IMAGE} AS build
ARG APP
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# pnpm's Docker pattern: fetch from the lockfile alone (cached until it changes),
# then install offline from that store. No list of workspace packages to maintain.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter "@app/${APP}..."
RUN pnpm --filter "@app/${APP}..." build \
 && pnpm deploy --filter "@app/${APP}" --prod /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# Mount point for the shared media volume; a new named volume takes this ownership.
RUN mkdir -p /data/media && chown node:node /data/media
USER node
CMD ["node", "dist/main.js"]
