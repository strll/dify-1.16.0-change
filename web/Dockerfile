# base image
FROM node:22.22.1-alpine AS base
LABEL maintainer="takatost@gmail.com"

# Use an Alpine mirror for the base package install in the local build
# environment; this only affects image construction.
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories

# Keep npmjs.org as the source of lockfile metadata so pnpm's supply-chain
# validation remains intact; increase network retry limits for slow links.
RUN npm config set registry https://registry.npmjs.org

RUN apk add --no-cache tzdata
RUN corepack enable
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV npm_config_registry="https://registry.npmjs.org"
ENV npm_config_fetch_timeout="600000"
ENV npm_config_fetch_retries="5"
ENV npm_config_fetch_retry_maxtimeout="600000"
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH="$NEXT_PUBLIC_BASE_PATH"


# install packages
FROM base AS packages

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml /app/
COPY web/package.json /app/web/
COPY e2e/package.json /app/e2e/
COPY sdks/nodejs-client/package.json /app/sdks/nodejs-client/
COPY packages /app/packages
RUN find /app/packages -type d -name node_modules -prune -exec rm -rf {} +

# Use packageManager from package.json
RUN corepack install
RUN pnpm config set fetch-timeout 600000 \
    && pnpm config set fetch-retries 5 \
    && pnpm config set fetch-retry-factor 2 \
    && pnpm config set fetch-retry-maxtimeout 600000

# Install workspace dependencies for the Docker build environment.
RUN VITE_GIT_HOOKS=0 pnpm install --frozen-lockfile

# build resources
FROM base AS builder
WORKDIR /app
COPY . .
# Copy the Linux-generated pnpm links last. The source checkout may contain
# host (Windows) node_modules symlinks, which must never override these links.
COPY --from=packages /app/ .

WORKDIR /app/web
ENV NODE_OPTIONS="--max-old-space-size=4096"
ENV pnpm_config_verify_deps_before_run=false
RUN pnpm build && pnpm build:vinext


# production stage
FROM base AS production

ENV NODE_ENV=production
ENV EDITION=SELF_HOSTED
ENV DEPLOY_ENV=PRODUCTION
# Keep API URLs empty in the image. The runtime entrypoint emits relative
# /console/api and /api prefixes, which the deployment Nginx proxies to api:5001.
ENV CONSOLE_API_URL=""
ENV APP_API_URL=""
# Server-side rendering needs an absolute internal API origin; browser
# requests still use the empty public prefixes above and go through Nginx.
ENV SERVER_CONSOLE_API_URL="http://api:5001"
ENV MARKETPLACE_API_URL=https://marketplace.dify.ai
ENV MARKETPLACE_URL=https://marketplace.dify.ai
ENV PORT=3000
ENV EXPERIMENTAL_ENABLE_VINEXT=false
ENV NEXT_TELEMETRY_DISABLED=1

# set timezone
ENV TZ=UTC
RUN ln -s /usr/share/zoneinfo/${TZ} /etc/localtime \
    && echo ${TZ} > /etc/timezone

# Create non-root user
ARG dify_uid=1001
RUN addgroup -S -g ${dify_uid} dify && \
    adduser -S -u ${dify_uid} -G dify -s /bin/ash -h /home/dify dify && \
    mkdir /app && \
    chown -R dify:dify /app


WORKDIR /app

COPY --from=builder --chown=dify:dify /app/web/public ./targets/next/web/public
COPY --from=builder --chown=dify:dify /app/web/.next/standalone ./targets/next/
COPY --from=builder --chown=dify:dify /app/web/.next/static ./targets/next/web/.next/static
COPY --from=builder --chown=dify:dify /app/web/dist/standalone ./targets/vinext

COPY --chown=dify:dify --chmod=755 web/docker/entrypoint.sh ./entrypoint.sh

ARG COMMIT_SHA
ENV COMMIT_SHA=${COMMIT_SHA}

USER dify
EXPOSE 3000
ENTRYPOINT ["/bin/sh", "./entrypoint.sh"]
